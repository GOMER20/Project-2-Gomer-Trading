import http from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { pool, waitForDatabase } from './db/pool.js';
import { engine } from './engine/matchingEngine.js';
import { startBotGateway } from './gateway/index.js';
import { hft } from './hft/index.js';
import { logger } from './lib/logger.js';
import { market } from './market/marketData.js';
import { redis } from './redis/client.js';
import { Gateway } from './ws/gateway.js';

async function main(): Promise<void> {
  await waitForDatabase();
  await market.start();
  await engine.start();
  // HFT is given a copy of everything from here on. It cannot hold start-up up or stop it: if the
  // program is missing or will not run, the exchange starts without it and says so in its status.
  hft.start();

  const server = http.createServer(createApp());
  // Slow or stalled clients must not be able to hold sockets open indefinitely.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 65_000;
  const gateway = new Gateway();
  const botGateway = await startBotGateway();
  // Two WebSocket services share this server: the trading terminal's and the bot gateway's.
  server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/ws') gateway.handleUpgrade(request, socket, head);
    else if (path === '/gateway') botGateway.ws.handleUpgrade(request, socket, head);
    else socket.destroy();
  });
  server.listen(config.port, config.host, () => {
    logger.info(`API listening on http://${config.host ?? 'localhost'}:${config.port} (WebSocket at /ws, market data: ${market.providerName})`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down`);
    // Stop taking traffic first, then release the feed and the data stores.
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();
    await Promise.all([gateway.close(), botGateway.close()]);
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    // Idle keep-alive sockets would otherwise hold the server open until they time out.
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 2_000).unref();
    await closed;
    // HFT finishes its recording and writes its last statistics.
    await hft.stop();
    // Everything the engine has decided reaches the database before the pool is closed.
    await engine.stop();
    await market.stop();
    await pool.end();
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // A rejected promise nobody awaited is a bug in one request, not a reason to drop every trader.
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled promise rejection'));
  // After an uncaught exception the process state cannot be trusted. Exit cleanly and let the
  // supervisor start a fresh one: every balance and resting order is rebuilt from Postgres.
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception, restarting');
    void shutdown('uncaughtException').finally(() => process.exit(1));
  });
}

main().catch((err) => {
  logger.fatal(err, 'API failed to start');
  process.exit(1);
});

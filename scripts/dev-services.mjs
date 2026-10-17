// Starts project-local PostgreSQL and Redis for development, so the stack runs
// without Docker or any system-wide install.
//
//   Postgres: real server binaries from the `embedded-postgres` package,
//             data kept in ./.data/postgres (survives restarts)
//   Redis:    real redis-server built by `redis-memory-server`, in-memory only
//             (the leaderboard and quote cache rebuild themselves in seconds)
//
// A service is skipped when something is already listening on its port, which
// is how `docker compose up -d` or a system install takes over transparently.
//
// Run directly (`npm run services`) to keep them up, or import startServices().

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, '.data', 'postgres');

function loadEnv() {
  try {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } catch {
    // defaults below apply
  }
  const db = new URL(process.env.DATABASE_URL ?? 'postgresql://trader:trader@localhost:5432/trading');
  const cache = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return {
    pg: {
      host: db.hostname,
      port: Number(db.port || 5432),
      user: decodeURIComponent(db.username || 'trader'),
      password: decodeURIComponent(db.password || 'trader'),
      database: db.pathname.replace(/^\//, '') || 'trading',
    },
    redis: { host: cache.hostname, port: Number(cache.port || 6379) },
  };
}

const isLocal = (host) => ['localhost', '127.0.0.1', '::1'].includes(host);

export function isListening(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.setTimeout(500);
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('timeout', () => (socket.destroy(), resolve(false)));
    socket.once('error', () => resolve(false));
  });
}

async function startPostgres(cfg, log) {
  if (!isLocal(cfg.host)) return log(`postgres  using remote server at ${cfg.host}:${cfg.port}`), null;
  if (await isListening(cfg.port)) return log(`postgres  already running on port ${cfg.port}, using it`), null;

  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const server = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: cfg.user,
    password: cfg.password,
    port: cfg.port,
    persistent: true,
    onLog: () => {},
    onError: (message) => {
      const text = String(message?.message ?? message).trim();
      // Postgres writes routine startup notices to stderr; only surface real problems.
      if (/\b(FATAL|PANIC|ERROR)\b/.test(text)) log(`postgres  ${text}`);
    },
  });

  if (!fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'))) {
    log('postgres  initialising a new database cluster in .data/postgres');
    await server.initialise();
  }
  await server.start();
  try {
    await server.createDatabase(cfg.database);
  } catch (err) {
    if (!/already exists/i.test(String(err?.message ?? err))) throw err;
  }
  log(`postgres  ready on port ${cfg.port} (database "${cfg.database}")`);
  return () => server.stop();
}

async function startRedis(cfg, log) {
  if (!isLocal(cfg.host)) return log(`redis     using remote server at ${cfg.host}:${cfg.port}`), null;
  if (await isListening(cfg.port)) return log(`redis     already running on port ${cfg.port}, using it`), null;

  const { RedisMemoryServer } = await import('redis-memory-server');
  const server = new RedisMemoryServer({ instance: { port: cfg.port, ip: '127.0.0.1' } });
  await server.start();
  log(`redis     ready on port ${cfg.port}`);
  return () => server.stop();
}

/** Starts whichever services are not already running. Resolves with a function that stops them. */
export async function startServices(log = console.log) {
  const cfg = loadEnv();
  const stoppers = [];
  try {
    for (const start of [() => startPostgres(cfg.pg, log), () => startRedis(cfg.redis, log)]) {
      const stop = await start();
      if (stop) stoppers.push(stop);
    }
  } catch (err) {
    await Promise.allSettled(stoppers.map((stop) => stop()));
    throw err;
  }
  return async () => {
    await Promise.allSettled(stoppers.map((stop) => stop()));
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stop = await startServices((line) => console.log(`[services] ${line}`));
  console.log('[services] running - press Ctrl+C to stop');
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  setInterval(() => {}, 1 << 30); // keep the event loop alive
}

import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { engine } from './engine/matchingEngine.js';
import { orderTimings } from './gateway/pipeline.js';
import { market } from './market/marketData.js';
import { eventLoopLag, responseTimes, shedLoad, timeRequests } from './lib/overload.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { redis } from './redis/client.js';
import { apiRouter } from './routes/index.js';

/**
 * Serves the exported interface. Next.js writes each page as `<name>.html`
 * next to a `<name>/` folder of data files, so a plain static handler would
 * answer /join with a redirect into that folder. Pages are therefore mapped
 * by hand: an invite link or a reload on any page must simply work.
 */
function serveInterface(app: express.Express, directory: string): void {
  const pages = new Map(
    fs
      .readdirSync(directory)
      .filter((file) => file.endsWith('.html'))
      .map((file) => [`/${file.slice(0, -'.html'.length)}`, path.join(directory, file)]),
  );
  app.get(/.*/, (req, res, next) => {
    const page = pages.get(req.path.length > 1 ? req.path.replace(/\/$/, '') : '/index');
    if (!page) return next();
    // Pages are tiny and name the current build's scripts: always fetch them fresh.
    res.set('Cache-Control', 'no-cache').sendFile(page);
  });
  app.use(
    express.static(directory, {
      index: false,
      redirect: false,
      // Build files carry a content hash in their name, so they can be cached for good.
      setHeaders: (res, file) => res.set('Cache-Control', file.includes(`${path.sep}_next${path.sep}static${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'),
    }),
  );
  // Someone who mistypes an address gets the interface's own "not found" page, not an API error.
  const missing = path.join(directory, '404.html');
  if (fs.existsSync(missing)) {
    app.get(/^\/(?!api\/|health$).*/, (req, res, next) => (req.accepts('html') ? res.status(404).sendFile(missing) : next()));
  }
}

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind a load balancer set TRUST_PROXY so rate limiting sees real client IPs.
  if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

  app.use(
    helmet(
      config.staticDir
        ? {
            contentSecurityPolicy: {
              directives: {
                // The exported Next.js pages bootstrap from inline scripts and styles.
                'script-src': ["'self'", "'unsafe-inline'"],
                'style-src': ["'self'", "'unsafe-inline'"],
                'img-src': ["'self'", 'data:', 'blob:'],
                'connect-src': ["'self'"],
                // The app is served over plain http on the loopback interface.
                'upgrade-insecure-requests': null,
              },
            },
            strictTransportSecurity: false,
          }
        : undefined,
    ),
  );
  app.use(cors({ origin: config.corsOrigins, methods: ['GET', 'POST', 'PUT', 'DELETE'], maxAge: 600 }));
  app.use(express.json({ limit: '32kb' }));

  app.get('/health', async (_req, res) => {
    const [db, cache] = await Promise.allSettled([pool.query('SELECT 1'), redis.ping()]);
    const healthy = db.status === 'fulfilled' && cache.status === 'fulfilled';
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      postgres: db.status === 'fulfilled',
      redis: cache.status === 'fulfilled',
      marketData: market.providerName,
      feed: market.feedStatus,
      restingOrders: engine.restingCount,
      // Orders are answered from memory and written just behind. "unwritten" and "writeLagMs" show how far behind.
      engine: engine.stats,
      // Time the exchange spends on an order from a trading program, start to execution report sent.
      gatewayOrders: orderTimings(),
      eventLoopLagMs: eventLoopLag(),
      responseTimeMs: responseTimes(),
      // Connections open / free, and requests queued for one. A queue here means the database is the bottleneck.
      databasePool: { open: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    });
  });

  // Health stays reachable when the API is shedding load, so monitoring can see why.
  app.use('/api', timeRequests, shedLoad, apiLimiter, apiRouter);
  if (config.staticDir) serveInterface(app, config.staticDir);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

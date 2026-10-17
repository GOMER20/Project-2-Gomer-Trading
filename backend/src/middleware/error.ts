import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { isDatabaseBusy } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

// Under overload, logging every refused request would itself become load. Count them and
// report once a second instead.
let busyCount = 0;
let busyReason = '';
setInterval(() => {
  if (busyCount === 0) return;
  logger.warn(`${busyCount} request(s) answered "busy" in the last second because the database was saturated (${busyReason})`);
  busyCount = 0;
}, 1000).unref();
function noteBusy(reason: string | undefined): void {
  busyCount++;
  busyReason = reason ?? 'unknown';
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
};

// Express identifies error middleware by its four-argument signature.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    const details = err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    const first = details[0];
    const message = first ? (first.path ? `${first.path}: ${first.message}` : first.message) : 'Invalid request';
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message, details } });
    return;
  }

  if (err instanceof AppError) {
    if (err.status === 499) return; // the client has already disconnected; there is nobody to answer
    if (err.status === 503) res.set('Retry-After', '2');
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }

  // body-parser failures (malformed JSON, payload too large) carry their own status.
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
    res.status(err.status).json({ error: { code: 'BAD_REQUEST', message: err.expose ? err.message : 'Bad request' } });
    return;
  }

  // Saturated or momentarily unreachable database: tell the client to retry rather than report a bug.
  if (isDatabaseBusy(err)) {
    noteBusy(err?.message);
    res.set('Retry-After', '2').status(503).json({ error: { code: 'BUSY', message: 'The server is busy. Please try again in a moment.' } });
    return;
  }

  // Postgres unique_violation
  if (err?.code === '23505') {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'That record already exists.' } });
    return;
  }

  logger.error({ err, method: req.method, path: req.path }, 'Unhandled request error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side.' } });
};

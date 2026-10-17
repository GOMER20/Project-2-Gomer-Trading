import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { RequestHandler } from 'express';

/**
 * Load shedding. Everything in this process shares one event loop: quotes,
 * order matching and every HTTP request. When requests arrive faster than
 * they can be served the loop falls behind, and the worst thing to do is
 * accept more work. Past MAX_LAG_MS new API requests are turned away with a
 * 503 and a Retry-After, which keeps prices flowing and lets the backlog
 * clear instead of the whole process grinding to a halt.
 */

const MAX_LAG_MS = 250;
const SAMPLE_MS = 1_000;

const RESOLUTION_MS = 20;
const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
histogram.enable();

let lagMs = 0;
setInterval(() => {
  // The histogram times a repeating RESOLUTION_MS timer, in nanoseconds: an idle loop reads
  // about RESOLUTION_MS, so only the excess is delay. An empty sample reads NaN.
  lagMs = Number.isFinite(histogram.mean) ? Math.max(0, histogram.mean / 1e6 - RESOLUTION_MS) : 0;
  histogram.reset();
}, SAMPLE_MS).unref();

/** Average event-loop delay over the last second, in milliseconds. */
export const eventLoopLag = () => Math.round(lagMs);

export const shedLoad: RequestHandler = (_req, res, next) => {
  if (lagMs <= MAX_LAG_MS) return next();
  res
    .set('Retry-After', '2')
    .status(503)
    .json({ error: { code: 'OVERLOADED', message: 'The server is very busy right now. Please try again in a moment.' } });
};

// --- response times, as the server itself measures them ----------------------
// Kept so that "it feels slow" can be answered with where the time went: if
// these are small while a client sees seconds, the delay is in front of the
// server (network, proxy, the client itself), not in it.

const WINDOW_MS = 10_000;
type Summary = { requests: number; median: number; p95: number; slowest: number };
const summarise = (times: number[]): Summary => {
  const sorted = times.sort((a, b) => a - b);
  return {
    requests: sorted.length,
    median: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0),
    p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
    slowest: Math.round(sorted[sorted.length - 1] ?? 0),
  };
};

// Anything that hashes a password (signing in, joining, creating an account or setting a password)
// is timed separately: it is slow and queues by design, and would otherwise hide how trading is doing.
let current = { trading: [] as number[], signIn: [] as number[] };
let lastWindow = { trading: summarise([]), signIn: summarise([]) };
setInterval(() => {
  lastWindow = { trading: summarise(current.trading), signIn: summarise(current.signIn) };
  current = { trading: [], signIn: [] };
}, WINDOW_MS).unref();

/** How long API requests took, from arrival to the last byte of the response, over the last ten seconds. */
export const responseTimes = () => lastWindow;

export const timeRequests: RequestHandler = (req, res, next) => {
  const started = performance.now();
  const hashesPassword = req.path.startsWith('/auth/') || req.path.startsWith('/users') || /^\/invites\/[^/]+\/join/.test(req.path);
  const bucket = hashesPassword ? current.signIn : current.trading;
  res.once('finish', () => {
    if (bucket.length < 50_000) bucket.push(performance.now() - started);
  });
  next();
};

import type { RequestHandler } from 'express';
import { z } from 'zod';
import { notFound } from '../lib/errors.js';
import { market } from '../market/marketData.js';
import { shownDepth } from '../market/depth.js';
import { marketHours } from '../market/usMarketHours.js';
import { SYMBOL_PATTERN, TIMEFRAMES, type Timeframe } from '../types.js';

const symbolParam = z.object({ symbol: z.string().trim().toUpperCase().regex(SYMBOL_PATTERN, 'Invalid ticker symbol') });
const barsQuery = z.object({
  timeframe: z.enum(Object.keys(TIMEFRAMES) as [Timeframe, ...Timeframe[]]).default('1Min'),
  limit: z.coerce.number().int().min(1).max(1000).default(300),
});

/** GET /api/market/symbols?q= */
export const symbols: RequestHandler = (req, res) => {
  const { q } = z.object({ q: z.string().trim().toUpperCase().max(20).default('') }).parse(req.query);
  const all = market.listSymbols();
  const matches = q ? all.filter((s) => s.symbol.startsWith(q) || s.name.toUpperCase().includes(q)) : all;
  res.json({ provider: market.providerName, symbols: matches.slice(0, 50) });
};

/**
 * GET /api/market/hours (public): whether the US stock market is open, and the
 * next sessions, as absolute times. Clients show them in their own time zone.
 * `alwaysOpen` is true when this server's prices ignore those hours (the
 * practice market set to run around the clock).
 */
export const hours: RequestHandler = (_req, res) => {
  res.json({ ...marketHours(), alwaysOpen: market.alwaysOpen });
};

/** GET /api/market/quote/:symbol: one-off Level 1 snapshot. */
export const quote: RequestHandler = async (req, res) => {
  const { symbol } = symbolParam.parse(req.params);
  const snapshot = await market.retain(symbol);
  if (!snapshot) throw notFound(`No quote available for ${symbol}`);
  market.release(symbol);
  res.json({ quote: snapshot });
};

/** GET /api/market/depth/:symbol: the Level 2 book. Levels behind the best bid and offer are modelled. */
export const depth: RequestHandler = async (req, res) => {
  const { symbol } = symbolParam.parse(req.params);
  const snapshot = await market.retain(symbol);
  if (!snapshot) throw notFound(`No quote available for ${symbol}`);
  const book = market.getDepth(symbol);
  market.release(symbol);
  res.json({ depth: book ? shownDepth(book) : null });
};

/** GET /api/market/bars/:symbol?timeframe=1Min&limit=300: chart history, oldest first. */
export const bars: RequestHandler = async (req, res) => {
  const { symbol } = symbolParam.parse(req.params);
  const { timeframe, limit } = barsQuery.parse(req.query);
  res.json({ symbol, timeframe, bars: await market.getBars(symbol, timeframe, limit) });
};

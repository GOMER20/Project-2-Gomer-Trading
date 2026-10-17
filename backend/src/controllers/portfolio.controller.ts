import type { RequestHandler } from 'express';
import { z } from 'zod';
import { currentUser } from '../middleware/auth.js';
import * as portfolios from '../services/portfolio.service.js';

const params = z.object({ competitionId: z.uuid() });
const historyQuery = z.object({
  status: z.enum(['OPEN', 'FILLED', 'CANCELLED', 'REJECTED']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/** GET /api/portfolios/:competitionId: cash, buying power, equity, P&L and open positions. */
export const getPortfolio: RequestHandler = async (req, res) => {
  const { competitionId } = params.parse(req.params);
  res.json({ portfolio: await portfolios.getPortfolio(currentUser(req).id, competitionId) });
};

/** GET /api/portfolios/:competitionId/positions */
export const getPositions: RequestHandler = async (req, res) => {
  const { competitionId } = params.parse(req.params);
  const portfolio = await portfolios.getPortfolio(currentUser(req).id, competitionId);
  res.json({ positions: portfolio.positions, asOf: portfolio.asOf });
};

/** GET /api/portfolios/:competitionId/executions: every piece that has traded, newest first. */
export const getExecutions: RequestHandler = async (req, res) => {
  const { competitionId } = params.parse(req.params);
  const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(300) }).parse(req.query);
  res.json(await portfolios.getExecutions(currentUser(req).id, competitionId, limit));
};

/** GET /api/portfolios/:competitionId/orders: account history, newest first. */
export const getOrders: RequestHandler = async (req, res) => {
  const { competitionId } = params.parse(req.params);
  res.json(await portfolios.getOrderHistory(currentUser(req).id, competitionId, historyQuery.parse(req.query)));
};

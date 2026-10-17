import type { RequestHandler } from 'express';
import { z } from 'zod';
import { getAtDashboard } from '../services/at.service.js';

/**
 * GET /api/at (owner): AT, the trading algorithm. What it traded here and how,
 * and the statistics it reports about itself. `?brief=1` leaves out the long
 * lists, for the small box on the terminal.
 */
export const dashboard: RequestHandler = async (req, res) => {
  const { brief } = z.object({ brief: z.enum(['0', '1']).optional() }).parse(req.query);
  res.json(await getAtDashboard(brief === '1'));
};

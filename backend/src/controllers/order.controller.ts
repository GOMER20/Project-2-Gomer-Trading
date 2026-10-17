import type { RequestHandler } from 'express';
import { z } from 'zod';
import { engine } from '../engine/matchingEngine.js';
import { currentUser } from '../middleware/auth.js';
import { approvedOrder } from '../middleware/risk.js';

/** POST /api/orders: runs after riskCheck, which validated the body and left the order on res.locals. */
export const placeOrder: RequestHandler = async (_req, res) => {
  res.status(201).json({ order: await engine.submit(approvedOrder(res)) });
};

/** DELETE /api/orders/:id: cancels a resting limit order. */
export const cancelOrder: RequestHandler = async (req, res) => {
  const { id } = z.object({ id: z.uuid() }).parse(req.params);
  res.json({ order: await engine.cancel(id, currentUser(req).id) });
};

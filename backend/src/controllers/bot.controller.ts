import type { RequestHandler } from 'express';
import { z } from 'zod';
import { gatewayEndpoints } from '../gateway/index.js';
import * as bots from '../gateway/keys.service.js';
import { registry } from '../gateway/session.js';

const idParam = z.object({ id: z.uuid() });

/** What each key's live connections are doing, for the admin console. */
function live(keyId: string) {
  const sessions = registry.forKey(keyId);
  return {
    connections: sessions.length,
    transports: [...new Set(sessions.map((s) => s.transport))],
    orders: sessions.reduce((sum, s) => sum + s.counters.orders, 0),
    marketDataDropped: sessions.reduce((sum, s) => sum + s.counters.dropped, 0),
  };
}

/** GET /api/bots (admin): every API key, where it trades, and whether its program is connected. */
export const list: RequestHandler = async (_req, res) => {
  res.json({ bots: (await bots.listBots()).map((bot) => ({ ...bot, live: live(bot.id) })), endpoints: gatewayEndpoints });
};

const createSchema = z.object({
  label: z.string().trim().min(2).max(60),
  competitionId: z.uuid(),
  traderId: z.string().trim().max(24).optional(),
  ordersPerSecond: z.number().int().min(1).max(5000).optional(),
});

/** POST /api/bots (admin): admits a trading program. The API key in the reply is shown this once. */
export const create: RequestHandler = async (req, res) => {
  res.status(201).json(await bots.createBot(createSchema.parse(req.body)));
};

const updateSchema = z
  .object({ competitionId: z.uuid().optional(), ordersPerSecond: z.number().int().min(1).max(5000).optional(), enabled: z.boolean().optional() })
  .refine((change) => Object.keys(change).length > 0, 'Nothing to change');

/** PUT /api/bots/:id (admin): move it to another sandbox, change its throttle, or switch it off and on. */
export const update: RequestHandler = async (req, res) => {
  res.json({ bot: await bots.updateBot(idParam.parse(req.params).id, updateSchema.parse(req.body)) });
};

/** POST /api/bots/:id/rotate (admin): a new key; the old one stops working. */
export const rotate: RequestHandler = async (req, res) => {
  res.json(await bots.rotateBotKey(idParam.parse(req.params).id));
};

/** DELETE /api/bots/:id (admin) */
export const remove: RequestHandler = async (req, res) => {
  await bots.deleteBot(idParam.parse(req.params).id);
  res.status(204).end();
};

import type { RequestHandler } from 'express';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { config } from '../config.js';
import { engine } from '../engine/matchingEngine.js';
import { notFound } from '../lib/errors.js';
import { currentUser } from '../middleware/auth.js';
import * as competitions from '../services/competition.service.js';
import { getLeaderboard } from '../services/leaderboard.service.js';
import { getResults } from '../services/results.service.js';

const idParam = z.object({ id: z.uuid() });
const traderIds = z.array(z.string().trim().min(1).max(24)).max(1000);

const createSchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    startingBalance: z.number().positive().max(1_000_000_000).default(100_000),
    allowShorting: z.boolean().default(true),
    leverage: z.number().min(1).max(10).default(1),
    // Dollars per share, e.g. 0.005. Zero means no commission.
    commissionPerShare: z.number().min(0).max(1).default(0),
    // Margin call level as a fraction, e.g. 0.25. Zero switches margin calls off.
    maintenanceMargin: z.number().min(0).max(0.9).default(0.25),
    traderIds: traderIds.default([]),
    openToInvites: z.boolean().default(true),
  })
  .refine((c) => c.endDate > c.startDate, { path: ['endDate'], message: 'End date must be after the start date' })
  // A fully used account sits at 1 / leverage. A call level at or above that would liquidate people the moment they traded.
  .refine((c) => c.maintenanceMargin < 1 / c.leverage, {
    path: ['maintenanceMargin'],
    message: 'The margin call level must be below 1 ÷ leverage (for 2× leverage, below 50%), or accounts would be liquidated as soon as they were fully invested',
  })
  .refine((c) => c.endDate > new Date(), { path: ['endDate'], message: 'End date must be in the future' });

/** GET /api/competitions */
export const list: RequestHandler = async (req, res) => {
  res.json({ competitions: await competitions.listCompetitions(currentUser(req)) });
};

/** GET /api/competitions/:id */
export const get: RequestHandler = async (req, res) => {
  const { id } = idParam.parse(req.params);
  res.json({ competition: await competitions.getCompetition(id, currentUser(req)) });
};

/** POST /api/competitions (admin): creates the tournament and funds a portfolio for each listed trader. */
export const create: RequestHandler = async (req, res) => {
  res.status(201).json(await competitions.createCompetition(createSchema.parse(req.body), currentUser(req)));
};

/**
 * PUT /api/competitions/:id/balance (owner): the money every account in the
 * competition starts with. Each account's cash moves by the difference, so
 * profits and losses so far are kept; traders who join later get the new amount.
 */
export const setBalance: RequestHandler = async (req, res) => {
  const { id } = idParam.parse(req.params);
  const { startingBalance } = z.object({ startingBalance: z.number().min(100).max(1_000_000_000) }).parse(req.body);
  const changed = await engine.setStartingBalance(id, new Decimal(startingBalance).toDecimalPlaces(2));
  // Written just behind the answer; wait, so whatever the caller reads next already has it.
  await engine.drained();
  res.json(changed);
};

/** POST /api/competitions/:id/participants (admin) */
export const addParticipants: RequestHandler = async (req, res) => {
  const { id } = idParam.parse(req.params);
  const body = z.object({ traderIds: traderIds.min(1) }).parse(req.body);
  res.json({ enrollment: await competitions.addParticipants(id, body.traderIds) });
};

/** GET /api/competitions/:id/participants (admin) */
export const listParticipants: RequestHandler = async (req, res) => {
  const { id } = idParam.parse(req.params);
  res.json({ participants: await competitions.listParticipants(id) });
};

const codeParam = z.object({ code: z.string().trim().min(4).max(16) });

/** GET /api/invites/:code (public): what an invite code leads to, shown before signing up. */
export const invitePreview: RequestHandler = async (req, res) => {
  const { code } = codeParam.parse(req.params);
  const { id: _hidden, ...competition } = await competitions.findInvite(code);
  res.json({ competition });
};

/** POST /api/invites/:code/join: a signed-in trader joins another competition with its code. */
export const joinWithCode: RequestHandler = async (req, res) => {
  const { code } = codeParam.parse(req.params);
  const { alreadyEnrolled, ...competition } = await competitions.joinWithCode(code, currentUser(req).traderId);
  res.json({ competition, alreadyEnrolled });
};

/** PUT /api/competitions/:id/invite (admin): open or close sign-up by invite code. */
export const setInvite: RequestHandler = async (req, res) => {
  const { id } = idParam.parse(req.params);
  const { open } = z.object({ open: z.boolean() }).parse(req.body);
  res.json({ joinCode: await competitions.setInvite(id, open) });
};

/** GET /api/competitions/:id/results: every trader's standing and record; names the winner once final. */
export const results: RequestHandler = async (req, res) => {
  const { id } = idParam.parse(req.params);
  await competitions.getCompetition(id, currentUser(req)); // 404 / 403 for outsiders
  res.json(await getResults(id));
};

/** GET /api/competitions/:id/leaderboard */
export const leaderboard: RequestHandler = async (req, res) => {
  const { id } = idParam.parse(req.params);
  const { limit } = z
    .object({ limit: z.coerce.number().int().min(1).max(100).default(config.leaderboard.size) })
    .parse(req.query);
  const user = currentUser(req);
  await competitions.getCompetition(id, user); // 404 / 403 for outsiders
  const board = await getLeaderboard(id, limit, user.traderId);
  if (!board) throw notFound('Competition not found');
  res.json(board);
};

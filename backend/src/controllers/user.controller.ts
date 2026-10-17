import type { RequestHandler } from 'express';
import { z } from 'zod';
import { currentUser } from '../middleware/auth.js';
import * as users from '../services/user.service.js';
import { presence } from '../ws/presence.js';

const createUserSchema = z.object({
  traderId: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{3,24}$/, 'Trader ID must be 3-24 characters: letters, digits, - or _'),
  // bcrypt only hashes the first 72 bytes, so longer passwords would be silently truncated.
  password: z.string().min(8, 'Password must be at least 8 characters').max(72, 'Password cannot exceed 72 characters'),
  displayName: z.string().trim().min(1).max(60).optional(),
  role: z.enum(['ADMIN', 'TRADER']).default('TRADER'),
});

/** GET /api/users (admin). `online` is true while the user has the terminal open. */
export const listUsers: RequestHandler = async (_req, res) => {
  const online = presence.onlineUserIds();
  res.json({ users: (await users.listUsers()).map((user) => ({ ...user, online: online.has(user.id) })) });
};

const userId = z.object({ id: z.uuid() });

/** PUT /api/users/:id/password (admin): replaces a forgotten password with a temporary one, shown once. */
export const resetPassword: RequestHandler = async (req, res) => {
  res.json(await users.resetPassword(userId.parse(req.params).id));
};

/** PUT /api/users/:id/active (admin): { active } */
export const setActive: RequestHandler = async (req, res) => {
  const { active } = z.object({ active: z.boolean() }).parse(req.body);
  res.json({ user: await users.setActive(userId.parse(req.params).id, active, currentUser(req).id) });
};

/** POST /api/users (admin) */
export const createUser: RequestHandler = async (req, res) => {
  res.status(201).json({ user: await users.createUser(createUserSchema.parse(req.body)) });
};

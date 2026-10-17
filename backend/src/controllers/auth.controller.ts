import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { notFound, unauthorized } from '../lib/errors.js';
import { currentUser } from '../middleware/auth.js';
import * as auth from '../services/auth.service.js';

const loginSchema = z.object({
  traderId: z.string().trim().min(1, 'Trader ID is required').max(64),
  password: z.string().min(1, 'Password is required').max(256),
});

/** POST /api/auth/login */
export const login: RequestHandler = async (req, res) => {
  const { traderId, password } = loginSchema.parse(req.body);
  // If the client gives up while waiting in the sign-in queue, do not spend a hash on it.
  const gone = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) gone.abort();
  });
  res.json(await auth.login(traderId, password, gone.signal));
};

const traderIdField = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_-]{3,24}$/, 'Trader ID must be 3-24 characters: letters, digits, - or _');

const joinSchema = z.object({
  code: z.string().trim().min(4, 'Enter the invite code').max(16),
  traderId: traderIdField,
  // bcrypt-era limit kept: nobody needs more, and it bounds the work a request can ask for.
  password: z.string().min(8, 'Password must be at least 8 characters').max(72, 'Password cannot exceed 72 characters'),
  displayName: z.string().trim().min(1).max(60).optional(),
});

/** POST /api/auth/join: sign yourself up with a competition's invite code. */
export const join: RequestHandler = async (req, res) => {
  res.status(201).json(await auth.joinWithInvite(joinSchema.parse(req.body)));
};

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password').max(256),
  newPassword: z.string().min(8, 'Password must be at least 8 characters').max(72, 'Password cannot exceed 72 characters'),
});

/** PUT /api/auth/password: change your own password. Signs you out everywhere else. */
export const changePassword: RequestHandler = async (req, res) => {
  const { currentPassword, newPassword } = passwordSchema.parse(req.body);
  res.json(await auth.changePassword(currentUser(req).id, currentPassword, newPassword));
};

/**
 * POST /api/auth/desktop: the desktop app signing its owner in to a built-in
 * account. It exists only when the app has set a key, accepts only requests
 * made on this machine that did not come through a tunnel or proxy, and
 * answers as if it were not there to anyone else.
 */
export const desktopSignIn: RequestHandler = async (req, res) => {
  const { key, accounts } = config.desktop;
  const offered = Buffer.from(String(req.headers['x-desktop-key'] ?? ''));
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
  const direct = !req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip'] && !req.headers['tailscale-funnel-request'];
  if (!key || !local || !direct || offered.length !== key.length || !timingSafeEqual(offered, Buffer.from(key))) throw notFound();

  const { account } = z.object({ account: z.enum(['admin', 'trader']) }).parse(req.body);
  res.json(await auth.desktopSignIn(accounts[account]));
};

/** GET /api/auth/me */
export const me: RequestHandler = async (req, res) => {
  const user = await auth.getUser(currentUser(req).id);
  if (!user) throw unauthorized('This account is no longer active.');
  res.json({ user });
};

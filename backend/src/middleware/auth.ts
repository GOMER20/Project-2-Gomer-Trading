import type { Request, RequestHandler } from 'express';
import { forbidden, unauthorized } from '../lib/errors.js';
import { isOwner, verifyToken } from '../services/auth.service.js';
import { assertSessionLive } from '../services/session.service.js';
import type { AuthUser, UserRole } from '../types.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Requires a valid `Authorization: Bearer <jwt>` header for a session that has
 * not been ended (password change, reset, deactivation) and attaches the
 * caller to req.user.
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  const user = verifyToken(header.slice('Bearer '.length));
  await assertSessionLive(user);
  req.user = user;
  next();
};

export const requireRole =
  (role: UserRole): RequestHandler =>
  (req, _res, next) => {
    if (currentUser(req).role !== role) throw forbidden(`${role} role required`);
    next();
  };

/** Administrators, and the desktop app's own trader account. */
export const requireOwner: RequestHandler = (req, _res, next) => {
  if (!isOwner(currentUser(req))) throw forbidden('Only the owner of this exchange can see this.');
  next();
};

/** The authenticated caller. Only valid behind requireAuth. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

import { EventEmitter } from 'node:events';
import { pool } from '../db/pool.js';
import { unauthorized } from '../lib/errors.js';
import type { AuthUser } from '../types.js';

/**
 * Whether a signed token still stands for a live session.
 *
 * A token is valid on its own for twelve hours, which is too long to wait when
 * a password has been changed or a trader removed. So every account has a
 * version, tokens carry the version they were issued under, and a session
 * whose version is behind is dead.
 *
 * Asking the database on every request would double its load, so the answer is
 * remembered briefly. Changes made through this process drop the memory at
 * once, which is why ending a session takes effect immediately.
 */
const REMEMBER_MS = 30_000;
const known = new Map<string, { version: number; active: boolean; at: number }>();

/** Emits a user id whenever that user's sessions are ended, so open connections can be closed. */
export const sessionEvents = new EventEmitter<{ ended: [string] }>();

async function accountState(userId: string): Promise<{ version: number; active: boolean }> {
  const cached = known.get(userId);
  if (cached && Date.now() - cached.at < REMEMBER_MS) return cached;
  const { rows } = await pool.query<{ token_version: number; is_active: boolean }>('SELECT token_version, is_active FROM users WHERE id = $1', [userId]);
  const state = { version: rows[0]?.token_version ?? -1, active: rows[0]?.is_active ?? false, at: Date.now() };
  known.set(userId, state);
  if (known.size > 20_000) for (const [id, entry] of known) if (Date.now() - entry.at >= REMEMBER_MS) known.delete(id);
  return state;
}

/** Throws 401 unless the session is for an active account and was issued under its current version. */
export async function assertSessionLive(user: AuthUser): Promise<void> {
  const state = await accountState(user.id);
  if (!state.active) throw unauthorized('This account is no longer active.');
  if (state.version !== user.tokenVersion) throw unauthorized('You have been signed out. Please log in again.');
}

/** Call after raising an account's version or deactivating it. */
export function endSessions(userId: string): void {
  known.delete(userId);
  sessionEvents.emit('ended', userId);
}

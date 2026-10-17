import { randomInt } from 'node:crypto';
import type { Queryable } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import type { UserRole, UserRow } from '../types.js';
import { hashPassword, normaliseTraderId, toPublicUser, type PublicUser } from './auth.service.js';
import { endSessions } from './session.service.js';

export type ManagedUser = PublicUser & { isActive: boolean; createdAt: string };

const toManagedUser = (row: UserRow): ManagedUser => ({ ...toPublicUser(row), isActive: row.is_active, createdAt: row.created_at.toISOString() });

export interface NewUser {
  traderId: string;
  password: string;
  displayName?: string;
  role?: UserRole;
}

export async function createUser(input: NewUser, db: Queryable = pool): Promise<PublicUser> {
  const traderId = normaliseTraderId(input.traderId);
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users (trader_id, password_hash, display_name, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (trader_id) DO NOTHING
     RETURNING *`,
    [traderId, await hashPassword(input.password), input.displayName?.trim() || traderId, input.role ?? 'TRADER'],
  );
  if (!rows[0]) throw conflict(`Trader ID ${traderId} is already taken.`);
  return toPublicUser(rows[0]);
}

export async function listUsers(): Promise<ManagedUser[]> {
  const { rows } = await pool.query<UserRow>('SELECT * FROM users ORDER BY role, trader_id');
  return rows.map(toManagedUser);
}

// Easy to read out or type from a message: no 0/O, 1/l/I.
const TEMPORARY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/**
 * For a trader who has forgotten their password: gives the account a new
 * random one and returns it, once, for the administrator to pass on. The
 * trader's open sessions end.
 */
export async function resetPassword(userId: string): Promise<{ user: ManagedUser; temporaryPassword: string }> {
  const temporaryPassword = Array.from({ length: 12 }, () => TEMPORARY_ALPHABET[randomInt(TEMPORARY_ALPHABET.length)]).join('');
  const { rows } = await pool.query<UserRow>('UPDATE users SET password_hash = $2, token_version = token_version + 1 WHERE id = $1 RETURNING *', [
    userId,
    await hashPassword(temporaryPassword),
  ]);
  if (!rows[0]) throw notFound('User not found');
  endSessions(userId);
  return { user: toManagedUser(rows[0]), temporaryPassword };
}

/**
 * Deactivating signs the user out everywhere and stops them logging in; their
 * trades and their place in the standings are kept. Reactivating lets them
 * back in with the same password.
 */
export async function setActive(userId: string, active: boolean, actingUserId: string): Promise<ManagedUser> {
  if (!active && userId === actingUserId) throw badRequest('You cannot deactivate the account you are signed in with.');
  const { rows } = await pool.query<UserRow>(
    `UPDATE users SET is_active = $2, token_version = token_version + CASE WHEN $2 THEN 0 ELSE 1 END WHERE id = $1 RETURNING *`,
    [userId, active],
  );
  if (!rows[0]) throw notFound('User not found');
  if (!active) endSessions(userId);
  return toManagedUser(rows[0]);
}

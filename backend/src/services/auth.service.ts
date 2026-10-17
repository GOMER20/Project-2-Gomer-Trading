import { randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config, HASHING_THREADS } from '../config.js';
import { pool, withTransaction } from '../db/pool.js';
import { AppError, badRequest, conflict, unauthorized } from '../lib/errors.js';
import { scryptOnThread } from '../lib/hashPool.js';
import type { AuthUser, UserRole, UserRow } from '../types.js';
import { findInvite, joinWithCode } from './competition.service.js';
import { endSessions } from './session.service.js';

const ISSUER = 'gomer';
const ALGORITHM = 'HS256' as const;

export interface PublicUser {
  id: string;
  traderId: string;
  role: UserRole;
  displayName: string;
  /** May see the AT and HFT windows: see isOwner. */
  owner: boolean;
}

export const toPublicUser = (row: Pick<UserRow, 'id' | 'trader_id' | 'role' | 'display_name'>): PublicUser => ({
  id: row.id,
  traderId: row.trader_id,
  role: row.role,
  displayName: row.display_name,
  owner: isOwner({ role: row.role, traderId: row.trader_id }),
});

/**
 * The people this exchange belongs to: administrators, and, in the desktop app, the
 * trader account it signs its owner in to. Only they see the AT and HFT windows.
 */
export function isOwner(user: { role: UserRole; traderId: string }): boolean {
  if (user.role === 'ADMIN') return true;
  return config.desktop.key !== undefined && user.traderId === config.desktop.accounts.trader.trim().toUpperCase();
}

export const normaliseTraderId = (traderId: string) => traderId.trim().toUpperCase();

// Passwords are hashed with scrypt on dedicated threads (lib/hashPool.ts), so
// a burst of logins cannot stall the event loop that is streaming quotes and
// matching orders, nor the database connections. (bcryptjs, used before, is
// pure JavaScript and blocks the event loop for a quarter of a second per login.)
// cost 14 means N = 2^14 (16 MiB per hash, about a tenth of a second): Node's own default.
// It sets how many people can sign in per second, so raise it only with spare cores.
const SCRYPT = { cost: 14, blockSize: 8, parallelization: 1, keyLength: 64 };

/**
 * Hashing is the slowest thing the server does (on purpose: it is what makes
 * stolen password hashes expensive to crack), so it gets an orderly queue:
 *
 *  - at most HASHING_THREADS hashes run at once, each on its own thread
 *  - the rest wait in line, in order; nobody waits longer than MAX_WAIT_MS
 *    and the line is never longer than MAX_WAITING. Past either limit the
 *    caller gets an immediate "busy, retry shortly" instead of a request that
 *    hangs until it times out
 *  - a request whose client has already gone away is dropped when its turn
 *    comes, so retries from impatient clients cannot snowball
 */
const MAX_WAITING = HASHING_THREADS * 40;
const MAX_WAIT_MS = 12_000;
const busy = () => new AppError(503, 'BUSY', 'A lot of people are signing in right now. Please try again in a few seconds.');

let hashing = 0;
const waiting = new Set<{ start: () => void }>();

async function withHashingSlot<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (hashing >= HASHING_THREADS) {
    if (waiting.size >= MAX_WAITING) throw busy();
    await new Promise<void>((resolve, reject) => {
      const entry = {
        start: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        waiting.delete(entry);
        reject(busy());
      }, MAX_WAIT_MS);
      waiting.add(entry);
    });
  }
  // The slot is taken before this check so the accounting below stays in one place.
  hashing++;
  try {
    if (signal?.aborted) throw new AppError(499, 'CLIENT_CLOSED', 'The client went away before its turn.');
    return await task();
  } finally {
    hashing--;
    // Sets iterate in insertion order, so this is first come, first served.
    const next = waiting.values().next().value;
    if (next) {
      waiting.delete(next);
      next.start();
    }
  }
}

function scryptKey(password: string, salt: Buffer, cost: number, blockSize: number, parallelization: number, keyLength: number, signal?: AbortSignal): Promise<Buffer> {
  return withHashingSlot(() => scryptOnThread({ password, salt, N: 2 ** cost, r: blockSize, p: parallelization, keyLength }), signal);
}

/** Returns `scrypt$<log2 N>$<r>$<p>$<salt>$<key>`, everything needed to verify it later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptKey(password, salt, SCRYPT.cost, SCRYPT.blockSize, SCRYPT.parallelization, SCRYPT.keyLength);
  return ['scrypt', SCRYPT.cost, SCRYPT.blockSize, SCRYPT.parallelization, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Checks a password against a stored hash: scrypt, or bcrypt for accounts created before the switch. */
export async function verifyPassword(password: string, stored: string, signal?: AbortSignal): Promise<boolean> {
  if (!stored.startsWith('scrypt$')) return bcrypt.compare(password, stored);
  const [, cost, blockSize, parallelization, salt, key] = stored.split('$');
  if (!salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  try {
    const actual = await scryptKey(password, Buffer.from(salt, 'base64'), Number(cost), Number(blockSize), Number(parallelization), expected.length, signal);
    return timingSafeEqual(actual, expected);
  } catch (err) {
    if (err instanceof AppError) throw err; // busy, or the client left: not a wrong password
    return false; // malformed parameters in the stored hash
  }
}

// Compared against when the trader id does not exist, so a miss costs the same
// as a wrong password and response time does not reveal which ids are real.
let decoyHash: Promise<string> | undefined;
const getDecoyHash = () => (decoyHash ??= hashPassword('decoy-password-never-matches'));

export function signToken(user: AuthUser): string {
  return jwt.sign({ tid: user.traderId, role: user.role, v: user.tokenVersion }, config.jwt.secret, {
    subject: user.id,
    issuer: ISSUER,
    algorithm: ALGORITHM,
    expiresIn: config.jwt.expiresInSeconds,
  });
}

export function verifyToken(token: string): AuthUser {
  try {
    const payload = jwt.verify(token, config.jwt.secret, { issuer: ISSUER, algorithms: [ALGORITHM] });
    if (typeof payload === 'string' || !payload.sub || typeof payload.tid !== 'string') throw new Error('malformed');
    return {
      id: payload.sub,
      traderId: payload.tid,
      role: payload.role === 'ADMIN' ? 'ADMIN' : 'TRADER',
      // Tokens issued before versions existed count as version 0, which is where every account starts.
      tokenVersion: typeof payload.v === 'number' ? payload.v : 0,
    };
  } catch {
    throw unauthorized('Your session is invalid or has expired. Please log in again.');
  }
}

export async function login(traderId: string, password: string, signal?: AbortSignal): Promise<{ token: string; expiresIn: number; user: PublicUser }> {
  const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE trader_id = $1', [normaliseTraderId(traderId)]);
  const user = rows[0];
  const matches = await verifyPassword(password, user?.password_hash ?? (await getDecoyHash()), signal);

  // One message for every failure mode: never confirm that a trader id exists.
  if (!user || !matches || !user.is_active) throw unauthorized('Invalid trader ID or password.');

  // Accounts created before the switch to scrypt are upgraded the first time they sign in.
  if (!user.password_hash.startsWith('scrypt$')) {
    pool
      .query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(password)])
      .catch(() => undefined); // not worth failing a login over; it is retried next time
  }

  return session(user);
}

const tokenFor = (user: UserRow) => signToken({ id: user.id, traderId: user.trader_id, role: user.role, tokenVersion: user.token_version });

const session = (user: UserRow) => ({ token: tokenFor(user), expiresIn: config.jwt.expiresInSeconds, user: toPublicUser(user) });

/**
 * Changes the caller's own password. Every other session of theirs stops
 * working; the new token returned here keeps this one going.
 */
export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<{ token: string; expiresIn: number; user: PublicUser }> {
  const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE id = $1 AND is_active', [userId]);
  const user = rows[0];
  if (!user) throw unauthorized('This account is no longer active.');
  if (!(await verifyPassword(currentPassword, user.password_hash))) throw badRequest('Your current password is not right.');
  if (currentPassword === newPassword) throw badRequest('Choose a password different from your current one.');

  const updated = await pool.query<UserRow>('UPDATE users SET password_hash = $2, token_version = token_version + 1 WHERE id = $1 RETURNING *', [
    user.id,
    await hashPassword(newPassword),
  ]);
  endSessions(user.id);
  return session(updated.rows[0]!);
}

/**
 * Signs the desktop app's owner in to one of its built-in accounts without a
 * password, so changing that account's password never locks them out of
 * their own app. Guarded by a secret only the app's main process holds.
 */
export async function desktopSignIn(traderId: string): Promise<{ token: string; expiresIn: number; user: PublicUser }> {
  const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE trader_id = $1 AND is_active', [normaliseTraderId(traderId)]);
  if (!rows[0]) throw unauthorized('That account is not available.');
  return session(rows[0]);
}

export async function getUser(userId: string): Promise<PublicUser | null> {
  const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE id = $1 AND is_active', [userId]);
  return rows[0] ? toPublicUser(rows[0]) : null;
}

/**
 * Self sign-up: creates a trader account and enrols it in the competition the
 * invite code belongs to, in one transaction, then signs the trader in.
 * Without a valid code nobody can create an account.
 */
export async function joinWithInvite(input: {
  code: string;
  traderId: string;
  password: string;
  displayName?: string;
}): Promise<{ token: string; expiresIn: number; user: PublicUser; competition: { id: string; name: string } }> {
  // Checked before hashing, so a wrong code costs the server next to nothing.
  await findInvite(input.code);
  const traderId = normaliseTraderId(input.traderId);
  const passwordHash = await hashPassword(input.password);

  return withTransaction(async (client) => {
    const { rows } = await client.query<UserRow>(
      `INSERT INTO users (trader_id, password_hash, display_name, role)
       VALUES ($1, $2, $3, 'TRADER')
       ON CONFLICT (trader_id) DO NOTHING
       RETURNING *`,
      [traderId, passwordHash, input.displayName?.trim() || traderId],
    );
    const user = rows[0];
    if (!user) throw conflict(`Trader ID ${traderId} is already taken. Choose another, or log in if it is yours.`);

    const competition = await joinWithCode(input.code, traderId, client);
    return { ...session(user), competition: { id: competition.id, name: competition.name } };
  });
}

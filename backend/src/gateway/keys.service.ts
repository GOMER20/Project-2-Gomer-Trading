import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { pool, withTransaction } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { hashPassword } from '../services/auth.service.js';
import { addParticipants } from '../services/competition.service.js';
import { endSessions } from '../services/session.service.js';

/**
 * API keys for trading programs ("bots").
 *
 * A key looks like `gtk_3fa91c07b2_<secret>`. The middle part is public and is
 * how the key is found; only a SHA-256 of the secret is stored, so a copy of
 * the database does not let anyone trade. The secret is 32 random bytes, which
 * is why a fast hash is enough here where passwords need a slow one.
 *
 * Every key is pinned to one competition. That competition's portfolio is the
 * program's sandbox: its own balance, its own positions, its own line on the
 * leaderboard. Pointing the key at another competition moves the program.
 */

export interface KeyIdentity {
  keyId: string;
  userId: string;
  traderId: string;
  competitionId: string;
  competitionName: string;
  portfolioId: string;
  startingBalance: number;
  ordersPerSecond: number;
}

export interface BotDto {
  id: string;
  label: string;
  traderId: string;
  displayName: string;
  /** True when the account was created for this program rather than belonging to a person. */
  isBot: boolean;
  competitionId: string;
  competitionName: string;
  keyPrefix: string;
  ordersPerSecond: number;
  enabled: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Fired with a key id when that key is changed, disabled or deleted, so its live sessions can be dropped. */
export const keyEvents = new EventEmitter<{ changed: [string] }>();

const sha256 = (text: string) => createHash('sha256').update(text).digest();
const KEY_PATTERN = /^gtk_([0-9a-f]{10})_([A-Za-z0-9_-]{43})$/;

function mint(): { key: string; prefix: string; hash: string } {
  const prefix = randomBytes(5).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return { key: `gtk_${prefix}_${secret}`, prefix, hash: sha256(secret).toString('hex') };
}

// Looking a key up costs a database round trip; REST sends the key with every request. A few
// seconds of memory removes that cost, and any change to a key drops its entry at once.
const REMEMBER_MS = 5_000;
const remembered = new Map<string, { identity: KeyIdentity; hash: Buffer; at: number }>();
keyEvents.on('changed', (keyId) => {
  for (const [prefix, entry] of remembered) if (entry.identity.keyId === keyId) remembered.delete(prefix);
});

/** Resolves an API key to the account and sandbox it trades for, or null if it is not a usable key. */
export async function authenticate(apiKey: string): Promise<KeyIdentity | null> {
  const match = KEY_PATTERN.exec(apiKey.trim());
  if (!match) return null;
  const [, prefix, secret] = match as unknown as [string, string, string];
  const offered = sha256(secret);

  const known = remembered.get(prefix);
  if (known && Date.now() - known.at < REMEMBER_MS) return timingSafeEqual(offered, known.hash) ? known.identity : null;

  const { rows } = await pool.query<{
    id: string;
    key_hash: string;
    user_id: string;
    trader_id: string;
    competition_id: string;
    competition_name: string;
    portfolio_id: string;
    starting_balance: string;
    orders_per_second: number;
  }>(
    `SELECT k.id, k.key_hash, k.user_id, u.trader_id, k.competition_id, c.name AS competition_name,
            p.id AS portfolio_id, c.starting_balance, k.orders_per_second
       FROM api_keys k
       JOIN users u ON u.id = k.user_id AND u.is_active
       JOIN competitions c ON c.id = k.competition_id
       JOIN portfolios p ON p.user_id = k.user_id AND p.competition_id = k.competition_id
      WHERE k.key_prefix = $1 AND k.enabled`,
    [prefix],
  );
  const row = rows[0];
  if (!row) return null;
  const hash = Buffer.from(row.key_hash, 'hex');
  if (hash.length !== offered.length || !timingSafeEqual(offered, hash)) return null;

  const identity: KeyIdentity = {
    keyId: row.id,
    userId: row.user_id,
    traderId: row.trader_id,
    competitionId: row.competition_id,
    competitionName: row.competition_name,
    portfolioId: row.portfolio_id,
    startingBalance: Number(row.starting_balance),
    ordersPerSecond: row.orders_per_second,
  };
  remembered.set(prefix, { identity, hash, at: Date.now() });
  pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]).catch(() => undefined);
  return identity;
}

const SELECT_BOT = `
  SELECT k.id, k.label, u.trader_id, u.display_name, u.is_bot, k.competition_id, c.name AS competition_name,
         k.key_prefix, k.orders_per_second, k.enabled, k.created_at, k.last_used_at
    FROM api_keys k
    JOIN users u ON u.id = k.user_id
    JOIN competitions c ON c.id = k.competition_id`;

interface BotRow {
  id: string;
  label: string;
  trader_id: string;
  display_name: string;
  is_bot: boolean;
  competition_id: string;
  competition_name: string;
  key_prefix: string;
  orders_per_second: number;
  enabled: boolean;
  created_at: Date;
  last_used_at: Date | null;
}

const toDto = (row: BotRow): BotDto => ({
  id: row.id,
  label: row.label,
  traderId: row.trader_id,
  displayName: row.display_name,
  isBot: row.is_bot,
  competitionId: row.competition_id,
  competitionName: row.competition_name,
  keyPrefix: row.key_prefix,
  ordersPerSecond: row.orders_per_second,
  enabled: row.enabled,
  createdAt: row.created_at.toISOString(),
  lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
});

export async function listBots(): Promise<BotDto[]> {
  const { rows } = await pool.query<BotRow>(`${SELECT_BOT} ORDER BY k.created_at DESC`);
  return rows.map(toDto);
}

async function getBot(id: string): Promise<BotDto> {
  const { rows } = await pool.query<BotRow>(`${SELECT_BOT} WHERE k.id = $1`, [id]);
  if (!rows[0]) throw notFound('That API key does not exist.');
  return toDto(rows[0]);
}

export interface NewBot {
  /** What the program is called. Shown on the leaderboard when it gets an account of its own. */
  label: string;
  /** The sandbox it trades in. */
  competitionId: string;
  /** Give the key to an existing trader's account instead of creating one for the program. */
  traderId?: string;
  ordersPerSecond?: number;
}

/**
 * Admits a trading program: gives it an account (a new one unless an existing
 * trader is named), enrols that account in the competition, and issues the
 * key. The key is returned once, here, and cannot be read back later.
 */
export async function createBot(input: NewBot): Promise<{ bot: BotDto; apiKey: string }> {
  const label = input.label.trim();
  const minted = mint();
  const id = await withTransaction(async (client) => {
    const competition = await client.query('SELECT 1 FROM competitions WHERE id = $1', [input.competitionId]);
    if (!competition.rowCount) throw notFound('Competition not found');

    let traderId = input.traderId?.trim().toUpperCase();
    if (traderId) {
      const existing = await client.query('SELECT 1 FROM users WHERE trader_id = $1 AND is_active', [traderId]);
      if (!existing.rowCount) throw notFound(`There is no active trader ${traderId}.`);
    } else {
      // An account of its own, with a password nobody knows: the key is the only way in.
      traderId = `BOT-${minted.prefix.slice(0, 6).toUpperCase()}`;
      await client.query(`INSERT INTO users (trader_id, password_hash, display_name, role, is_bot) VALUES ($1, $2, $3, 'TRADER', TRUE)`, [
        traderId,
        await hashPassword(randomBytes(24).toString('base64url')),
        label,
      ]);
    }
    await addParticipants(input.competitionId, [traderId], client);

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO api_keys (user_id, competition_id, label, key_prefix, key_hash, orders_per_second)
       SELECT u.id, $2, $3, $4, $5, $6 FROM users u WHERE u.trader_id = $1
       RETURNING id`,
      [traderId, input.competitionId, label, minted.prefix, minted.hash, input.ordersPerSecond ?? 50],
    );
    return inserted.rows[0]!.id;
  });
  return { bot: await getBot(id), apiKey: minted.key };
}

/**
 * The administrator's switches for one key: which sandbox it trades in, how
 * fast it may send orders, and whether it works at all. Any change drops the
 * program's live connections; it reconnects into the new arrangement.
 */
export async function updateBot(id: string, change: { competitionId?: string; ordersPerSecond?: number; enabled?: boolean }): Promise<BotDto> {
  await withTransaction(async (client) => {
    const found = await client.query<{ trader_id: string; user_id: string }>(
      'SELECT u.trader_id, k.user_id FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.id = $1 FOR UPDATE OF k',
      [id],
    );
    const key = found.rows[0];
    if (!key) throw notFound('That API key does not exist.');
    if (change.competitionId) {
      const competition = await client.query<{ ended: boolean }>('SELECT end_date < now() AS ended FROM competitions WHERE id = $1', [change.competitionId]);
      if (!competition.rows[0]) throw notFound('Competition not found');
      if (competition.rows[0].ended) throw badRequest('That competition has ended. Choose one that is running or yet to start.');
      // Moving sandbox means a portfolio there: a fresh one at the starting balance if the account has none.
      await addParticipants(change.competitionId, [key.trader_id], client);
    }
    await client.query(
      `UPDATE api_keys
          SET competition_id = COALESCE($2, competition_id),
              orders_per_second = COALESCE($3, orders_per_second),
              enabled = COALESCE($4, enabled)
        WHERE id = $1`,
      [id, change.competitionId ?? null, change.ordersPerSecond ?? null, change.enabled ?? null],
    );
  });
  keyEvents.emit('changed', id);
  return getBot(id);
}

/** Replaces the secret. The old key stops working at once; the new one is returned once. */
export async function rotateBotKey(id: string): Promise<{ bot: BotDto; apiKey: string }> {
  const minted = mint();
  const { rowCount } = await pool.query('UPDATE api_keys SET key_prefix = $2, key_hash = $3 WHERE id = $1', [id, minted.prefix, minted.hash]);
  if (!rowCount) throw notFound('That API key does not exist.');
  keyEvents.emit('changed', id);
  return { bot: await getBot(id), apiKey: minted.key };
}

/** Deletes a key. An account that was created for the program is deactivated with it; its trades stay on the record. */
export async function deleteBot(id: string): Promise<void> {
  const { rows } = await pool.query<{ user_id: string; is_bot: boolean; others: number }>(
    `DELETE FROM api_keys k USING users u
      WHERE k.id = $1 AND u.id = k.user_id
      RETURNING k.user_id, u.is_bot, (SELECT count(*)::int FROM api_keys o WHERE o.user_id = k.user_id AND o.id <> k.id) AS others`,
    [id],
  );
  const key = rows[0];
  if (!key) throw notFound('That API key does not exist.');
  keyEvents.emit('changed', id);
  if (key.is_bot && key.others === 0) {
    await pool.query('UPDATE users SET is_active = FALSE, token_version = token_version + 1 WHERE id = $1', [key.user_id]);
    endSessions(key.user_id);
  }
}

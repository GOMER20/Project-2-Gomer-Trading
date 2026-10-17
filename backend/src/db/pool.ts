import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// NUMERIC columns stay strings (pg's default) so money never passes through a
// float on its way in or out of the database. Convert with Decimal at the edges.
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  // Opening a connection is slow (the password handshake is deliberately expensive), so
  // keep a few ready and do not close the rest the moment traffic pauses.
  min: Math.min(4, config.dbPoolMax),
  idleTimeoutMillis: 5 * 60_000,
  // Under heavy load requests queue for a connection; past this they fail fast (reported as 503).
  connectionTimeoutMillis: 5_000,
  // No statement or abandoned transaction may hold a connection, or a row lock, indefinitely.
  statement_timeout: 15_000,
  idle_in_transaction_session_timeout: 30_000,
});

/** True for errors that mean "the database is saturated or briefly unavailable", not "the request was wrong". */
export function isDatabaseBusy(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  return (
    e.code === '57014' || // statement_timeout
    e.code === '53300' || // too_many_connections
    e.code === '57P03' || // cannot_connect_now (starting up / shutting down)
    e.code === 'ECONNREFUSED' ||
    e.code === 'ECONNRESET' ||
    /timeout exceeded when trying to connect|Connection terminated/i.test(e.message ?? '')
  );
}

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle Postgres client');
});

export type Queryable = Pick<pg.PoolClient, 'query'>;

/** Runs fn inside a transaction, rolling back if it throws. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Blocks until Postgres accepts connections. Used at startup so process order does not matter. */
export async function waitForDatabase(attempts = 30, delayMs = 1000): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      logger.warn(`Waiting for Postgres (attempt ${i}/${attempts})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

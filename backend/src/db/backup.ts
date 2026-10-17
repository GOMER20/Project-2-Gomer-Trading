/**
 * Saves and restores everything people have done in the app: accounts,
 * competitions, portfolios, positions, orders, and the practice market.
 *
 *   backup save <file>    write a backup; safe while the app is running
 *   backup load <file>    replace the database's contents with a backup;
 *                         stop the API and the worker first
 *
 * A backup is one gzipped JSON file. It holds data, not database files, so it
 * can be restored into a fresh install or a later version of the app.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { logger } from '../lib/logger.js';
import { pool, waitForDatabase, withTransaction } from './pool.js';

const FORMAT = 1;
const APP = 'gomer-trading';

/** Parents before children: rows go back in this order so every reference finds its target. */
const TABLES = ['users', 'competitions', 'api_keys', 'portfolios', 'positions', 'orders', 'executions', 'market_engine', 'market_bars'] as const;
/** Not data: rebuilt by the migrations themselves. */
const NOT_BACKED_UP = new Set(['schema_migrations', 'engine_journal']);

interface BackupFile {
  format: number;
  app: string;
  createdAt: string;
  migrations: string[];
  /**
   * Each table's rows as JSON text, exactly as Postgres wrote it. Kept as text
   * so money never passes through a JavaScript number on the way out or back.
   */
  tables: Record<string, string>;
  counts: Record<string, number>;
}

async function save(file: string): Promise<void> {
  const client = await pool.connect();
  const backup: BackupFile = { format: FORMAT, app: APP, createdAt: new Date().toISOString(), migrations: [], tables: {}, counts: {} };
  try {
    // One snapshot for every table, so the backup is a single consistent moment even while people trade.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

    const existing = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const unknown = existing.rows.map((r) => r.table_name).filter((name) => !TABLES.includes(name as (typeof TABLES)[number]) && !NOT_BACKED_UP.has(name));
    // A table added later must be added here too. Better to fail than to write a backup that silently leaves it out.
    if (unknown.length) throw new Error(`the backup does not know about: ${unknown.join(', ')}`);

    backup.migrations = (await client.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
    for (const table of TABLES) {
      const { rows } = await client.query<{ rows: string; count: number }>(`SELECT COALESCE(json_agg(t), '[]'::json)::text AS rows, count(*)::int AS count FROM ${table} t`);
      backup.tables[table] = rows[0]!.rows;
      backup.counts[table] = rows[0]!.count;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  // Written beside its destination and renamed, so a half-written backup is never mistaken for a good one.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const partial = `${file}.partial`;
  fs.writeFileSync(partial, zlib.gzipSync(JSON.stringify(backup)), { mode: 0o600 });
  fs.renameSync(partial, file);
  logger.info({ counts: backup.counts }, `Backup written to ${file}`);
}

async function load(file: string): Promise<void> {
  let backup: BackupFile;
  try {
    backup = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')) as BackupFile;
  } catch {
    throw new Error('that file is not a Gomer Trading backup, or it is damaged');
  }
  if (backup.app !== APP || backup.format !== FORMAT || !backup.tables) throw new Error('that file is not a Gomer Trading backup');

  const applied = new Set((await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const newer = backup.migrations.filter((name) => !applied.has(name));
  if (newer.length) throw new Error('this backup was made by a newer version of the app; update the app, then restore it');

  // All or nothing: if any table fails to go back, the database is left exactly as it was.
  await withTransaction(async (client) => {
    await client.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    for (const table of TABLES) {
      const rows = backup.tables[table];
      if (!rows || rows === '[]') continue;
      // Only the columns the backup has. One it predates then takes its default instead of NULL.
      const columns = await client.query<{ name: string }>(
        `SELECT key AS name
           FROM json_object_keys(($1::json) -> 0) AS key
          WHERE key IN (SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $2)`,
        [rows, table],
      );
      const list = columns.rows.map((c) => `"${c.name}"`).join(', ');
      await client.query(`INSERT INTO ${table} (${list}) SELECT ${list} FROM json_populate_recordset(NULL::${table}, $1::json)`, [rows]);
    }
  });
  // The database is now a different database as far as the engine's journal is concerned:
  // nothing journalled against what was here before may be replayed into what is here now.
  await pool.query('UPDATE engine_journal SET journal_id = gen_random_uuid(), applied_seq = 0');
  logger.info({ counts: backup.counts, madeAt: backup.createdAt }, `Backup restored from ${file}`);
}

const [action, file] = process.argv.slice(2);
if ((action !== 'save' && action !== 'load') || !file) {
  console.error('usage: backup save <file> | backup load <file>');
  process.exit(2);
}

try {
  await waitForDatabase();
  await (action === 'save' ? save(file) : load(file));
  await pool.end();
} catch (err) {
  logger.error(`Backup ${action} failed: ${err instanceof Error ? err.message : String(err)}`);
  await pool.end().catch(() => undefined);
  process.exit(1);
}

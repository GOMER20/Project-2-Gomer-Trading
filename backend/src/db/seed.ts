import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { addParticipants, setInvite } from '../services/competition.service.js';
import { hashPassword } from '../services/auth.service.js';
import { migrate } from './migrate.js';
import { pool } from './pool.js';

/**
 * Creates the first admin account and, outside production, a set of demo
 * traders enrolled in a running demo competition.
 *
 * Idempotent: existing users, competitions and portfolios are left untouched,
 * so it is safe to run on every boot. Passwords come from the environment
 * (see .env.example); nothing is hard-coded here.
 */

const DEMO_COMPETITION = 'Demo Trading Challenge';
const DEMO_TRADERS = [
  'Ava Chen',
  'Marcus Reed',
  'Priya Nair',
  'Diego Alvarez',
  'Hannah Schmidt',
  'Kenji Watanabe',
  'Zoe Laurent',
  'Omar Haddad',
  'Lucia Romano',
  'Noah Bennett',
  'Mei Lin',
  'Tomas Novak',
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length < 8) {
    throw new Error(`${name} must be set to a value of at least 8 characters before seeding (see .env.example).`);
  }
  return value;
}

async function upsertUser(traderId: string, password: string, displayName: string, role: 'ADMIN' | 'TRADER'): Promise<boolean> {
  // Checked first because hashing is deliberately slow and this runs on every start.
  const existing = await pool.query('SELECT 1 FROM users WHERE trader_id = $1', [traderId]);
  if (existing.rowCount) return false;

  const { rowCount } = await pool.query(
    `INSERT INTO users (trader_id, password_hash, display_name, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (trader_id) DO NOTHING`,
    [traderId, await hashPassword(password), displayName, role],
  );
  return rowCount === 1;
}

async function seed(): Promise<void> {
  await migrate();

  const adminId = (process.env.SEED_ADMIN_ID ?? 'ADMIN').trim().toUpperCase();
  if (await upsertUser(adminId, requireEnv('SEED_ADMIN_PASSWORD'), 'Administrator', 'ADMIN')) {
    logger.info(`Created admin account ${adminId}`);
  }

  const wantDemo = process.env.SEED_DEMO_DATA ? process.env.SEED_DEMO_DATA === 'true' : !config.isProduction;
  if (!wantDemo) return;

  const traderPassword = requireEnv('SEED_TRADER_PASSWORD');
  const count = Math.min(DEMO_TRADERS.length, Math.max(1, Number(process.env.SEED_TRADER_COUNT ?? 10)));
  const traderIds: string[] = [];
  let created = 0;
  for (let i = 0; i < count; i++) {
    const traderId = `TRADER${String(i + 1).padStart(2, '0')}`;
    traderIds.push(traderId);
    if (await upsertUser(traderId, traderPassword, DEMO_TRADERS[i]!, 'TRADER')) created++;
  }
  if (created) logger.info(`Created ${created} demo traders (TRADER01 - ${traderIds[traderIds.length - 1]})`);

  const existing = await pool.query<{ id: string }>('SELECT id FROM competitions WHERE name = $1 AND end_date > now()', [
    DEMO_COMPETITION,
  ]);
  let competitionId = existing.rows[0]?.id;
  if (!competitionId) {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO competitions (name, start_date, end_date, starting_balance, allow_shorting, leverage)
       VALUES ($1, now(), now() + interval '30 days', 100000, TRUE, 1)
       RETURNING id`,
      [DEMO_COMPETITION],
    );
    competitionId = inserted.rows[0]!.id;
    logger.info(`Created competition "${DEMO_COMPETITION}" (30 days, $100,000 starting balance)`);
  }

  // Ready to share: the demo competition can be joined with an invite code from the start.
  await setInvite(competitionId, true);
  const enrollment = await addParticipants(competitionId, traderIds);
  if (enrollment.enrolled.length) logger.info(`Enrolled ${enrollment.enrolled.length} traders with a fresh $100,000 portfolio`);
}

seed()
  .then(() => logger.info('Seed complete'))
  .catch((err) => {
    logger.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

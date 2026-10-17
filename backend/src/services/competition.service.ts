import { randomInt } from 'node:crypto';
import { config } from '../config.js';
import type { Queryable } from '../db/pool.js';
import { pool, withTransaction } from '../db/pool.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { competitionStatus, type AuthUser, type CompetitionRow, type CompetitionStatus } from '../types.js';
import { normaliseTraderId } from './auth.service.js';

export interface CompetitionDto {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  startingBalance: number;
  allowShorting: boolean;
  leverage: number;
  /** Dollars charged per share on every execution. Zero means trading is free. */
  commissionPerShare: number;
  /** Margin call level: equity below this share of gross exposure liquidates the account. Zero switches it off. */
  maintenanceMargin: number;
  status: CompetitionStatus;
  /** True once an ended competition has been settled and its standings are final. */
  final: boolean;
  participants: number;
  /** Whether the calling user has a portfolio in this competition. */
  enrolled: boolean;
  /** Invite code people can join with. Only sent to administrators; null when sign-up is closed. */
  joinCode?: string | null;
}

export interface NewCompetition {
  name: string;
  startDate: Date;
  endDate: Date;
  startingBalance: number;
  allowShorting: boolean;
  leverage: number;
  commissionPerShare: number;
  maintenanceMargin: number;
  traderIds: string[];
  /** Create an invite code so people can sign themselves up. */
  openToInvites: boolean;
}

export interface EnrollmentResult {
  enrolled: string[];
  alreadyEnrolled: string[];
  notFound: string[];
}

type CompetitionListRow = CompetitionRow & { participants: number; enrolled: boolean };

const toDto = (row: CompetitionListRow, forAdmin = false): CompetitionDto => ({
  ...(forAdmin ? { joinCode: row.join_code } : {}),
  id: row.id,
  name: row.name,
  startDate: row.start_date.toISOString(),
  endDate: row.end_date.toISOString(),
  startingBalance: Number(row.starting_balance),
  allowShorting: row.allow_shorting,
  leverage: Number(row.leverage),
  commissionPerShare: Number(row.commission_per_share),
  maintenanceMargin: Number(row.maintenance_margin),
  status: competitionStatus(row),
  final: row.settled_at !== null,
  participants: row.participants,
  enrolled: row.enrolled,
});

const SELECT_COMPETITION = `
  SELECT c.*,
         (SELECT count(*)::int FROM portfolios p WHERE p.competition_id = c.id) AS participants,
         EXISTS (SELECT 1 FROM portfolios p WHERE p.competition_id = c.id AND p.user_id = $1) AS enrolled
    FROM competitions c`;

/** Admins see every competition; traders see the ones they are enrolled in. */
export async function listCompetitions(user: AuthUser): Promise<CompetitionDto[]> {
  const { rows } = await pool.query<CompetitionListRow>(
    `${SELECT_COMPETITION}
      WHERE $2 OR EXISTS (SELECT 1 FROM portfolios p WHERE p.competition_id = c.id AND p.user_id = $1)
      ORDER BY c.start_date DESC, c.name`,
    [user.id, user.role === 'ADMIN'],
  );
  return rows.map((row) => toDto(row, user.role === 'ADMIN'));
}

export async function getCompetition(competitionId: string, user: AuthUser): Promise<CompetitionDto> {
  const { rows } = await pool.query<CompetitionListRow>(`${SELECT_COMPETITION} WHERE c.id = $2`, [user.id, competitionId]);
  const row = rows[0];
  if (!row) throw notFound('Competition not found');
  if (user.role !== 'ADMIN' && !row.enrolled) throw forbidden('You are not enrolled in this competition.');
  return toDto(row, user.role === 'ADMIN');
}

/**
 * Gives each listed trader a fresh portfolio funded with the competition's
 * starting balance. Idempotent: traders who already have a portfolio keep it
 * untouched, so re-running this can never reset someone's account.
 */
export async function addParticipants(competitionId: string, traderIds: string[], db: Queryable = pool): Promise<EnrollmentResult> {
  const requested = [...new Set(traderIds.map(normaliseTraderId))];
  const competition = await db.query<Pick<CompetitionRow, 'end_date'>>('SELECT end_date FROM competitions WHERE id = $1', [
    competitionId,
  ]);
  if (!competition.rows[0]) throw notFound('Competition not found');
  if (competition.rows[0].end_date < new Date()) throw conflict('This competition has already ended.');
  if (requested.length === 0) return { enrolled: [], alreadyEnrolled: [], notFound: [] };

  const { rows } = await db.query<{ trader_id: string; enrolled: boolean }>(
    `WITH wanted AS (
       SELECT id, trader_id FROM users WHERE trader_id = ANY($2::text[]) AND is_active
     ),
     inserted AS (
       INSERT INTO portfolios (user_id, competition_id, cash, buying_power, total_equity)
       SELECT w.id, c.id, c.starting_balance, c.starting_balance * c.leverage, c.starting_balance
         FROM wanted w
        CROSS JOIN competitions c
        WHERE c.id = $1
       ON CONFLICT (user_id, competition_id) DO NOTHING
       RETURNING user_id
     )
     SELECT w.trader_id, (i.user_id IS NOT NULL) AS enrolled
       FROM wanted w
       LEFT JOIN inserted i ON i.user_id = w.id`,
    [competitionId, requested],
  );

  const found = new Set(rows.map((r) => r.trader_id));
  return {
    enrolled: rows.filter((r) => r.enrolled).map((r) => r.trader_id),
    alreadyEnrolled: rows.filter((r) => !r.enrolled).map((r) => r.trader_id),
    notFound: requested.filter((id) => !found.has(id)),
  };
}

export async function createCompetition(
  input: NewCompetition,
  createdBy: AuthUser,
): Promise<{ competition: CompetitionDto; enrollment: EnrollmentResult }> {
  const { id, enrollment } = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO competitions (name, start_date, end_date, starting_balance, allow_shorting, leverage, commission_per_share, maintenance_margin, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [input.name, input.startDate, input.endDate, input.startingBalance, input.allowShorting, input.leverage, input.commissionPerShare, input.maintenanceMargin, createdBy.id],
    );
    const competitionId = rows[0]!.id;
    if (input.openToInvites) await setInvite(competitionId, true, client);
    return { id: competitionId, enrollment: await addParticipants(competitionId, input.traderIds, client) };
  });
  return { competition: await getCompetition(id, createdBy), enrollment };
}

export async function listParticipants(
  competitionId: string,
): Promise<Array<{ traderId: string; displayName: string; totalEquity: number; cash: number }>> {
  const { rows } = await pool.query<{ trader_id: string; display_name: string; total_equity: string; cash: string }>(
    `SELECT u.trader_id, u.display_name, p.total_equity, p.cash
       FROM portfolios p
       JOIN users u ON u.id = p.user_id
      WHERE p.competition_id = $1
      ORDER BY p.total_equity DESC, u.trader_id`,
    [competitionId],
  );
  return rows.map((r) => ({
    traderId: r.trader_id,
    displayName: r.display_name,
    totalEquity: Number(r.total_equity),
    cash: Number(r.cash),
  }));
}

// ---------------------------------------------------------------------------
// Invites: joining with a code
// ---------------------------------------------------------------------------

// No 0/O or 1/I/L: codes get read out loud and typed on phones.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
export const normaliseJoinCode = (code: string) => code.replace(/[\s-]/g, '').toUpperCase();
const newJoinCode = () => Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

/** Opens or closes self sign-up. Opening keeps an existing code, so links already shared keep working. */
export async function setInvite(competitionId: string, open: boolean, db: Queryable = pool): Promise<string | null> {
  if (!open) {
    const closed = await db.query('UPDATE competitions SET join_code = NULL WHERE id = $1', [competitionId]);
    if (!closed.rowCount) throw notFound('Competition not found');
    return null;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const { rows } = await db.query<{ join_code: string }>(
        'UPDATE competitions SET join_code = COALESCE(join_code, $2) WHERE id = $1 RETURNING join_code',
        [competitionId, newJoinCode()],
      );
      if (!rows[0]) throw notFound('Competition not found');
      return rows[0].join_code;
    } catch (err) {
      // 23505: another competition already drew this code. Draw again.
      if ((err as { code?: string }).code !== '23505' || attempt >= 5) throw err;
    }
  }
}

export interface InvitePreview {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  startingBalance: number;
  status: CompetitionStatus;
  participants: number;
}

/**
 * The competition an invite code opens, or 404. An ended competition and an
 * unknown code get the same answer: a code is only ever valid or not.
 */
export async function findInvite(code: string, db: Queryable = pool): Promise<InvitePreview> {
  const { rows } = await db.query<CompetitionRow & { participants: number }>(
    `SELECT c.*, (SELECT count(*)::int FROM portfolios p WHERE p.competition_id = c.id) AS participants
       FROM competitions c
      WHERE c.join_code = $1 AND c.end_date > now()`,
    [normaliseJoinCode(code)],
  );
  const row = rows[0];
  if (!row) throw notFound('That invite code is not valid. Check it with whoever is running the competition.');
  return {
    id: row.id,
    name: row.name,
    startDate: row.start_date.toISOString(),
    endDate: row.end_date.toISOString(),
    startingBalance: Number(row.starting_balance),
    status: competitionStatus(row),
    participants: row.participants,
  };
}

/** Enrols an existing trader through an invite code. Joining twice is harmless. */
export async function joinWithCode(code: string, traderId: string, db: Queryable = pool): Promise<InvitePreview & { alreadyEnrolled: boolean }> {
  const invite = await findInvite(code, db);
  if (invite.participants >= config.maxParticipants) throw conflict('This competition is full.');
  const enrollment = await addParticipants(invite.id, [traderId], db);
  return { ...invite, alreadyEnrolled: enrollment.alreadyEnrolled.length > 0 };
}

import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { keys, redis } from '../redis/client.js';

export interface LeaderboardEntry {
  rank: number;
  traderId: string;
  displayName: string;
  equity: number;
  /** What this trader started with. The same for everyone unless an account was funded on its own. */
  startingBalance: number;
  pnl: number;
  returnPct: number;
}

export interface Leaderboard {
  competitionId: string;
  startingBalance: number;
  participants: number;
  updatedAt: string | null;
  entries: LeaderboardEntry[];
}

export interface Standing {
  traderId: string;
  displayName: string;
  equity: number;
  startingBalance: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * What the board ranks by: the return on the money each trader started with.
 * When everyone starts with the same amount this orders them exactly as their
 * equity does; when one account was given more, it gets no head start.
 */
export const scoreOf = (equity: number, startingBalance: number) => (startingBalance > 0 ? (equity - startingBalance) / startingBalance : 0);

/** Kept beside each score: name, equity and starting money. */
interface Detail {
  n: string;
  e: number;
  s: number;
}
export const encodeDetail = (displayName: string, equity: number, startingBalance: number) => JSON.stringify({ n: displayName, e: round2(equity), s: startingBalance } satisfies Detail);
/** Boards written by older versions kept the bare name there and scored by equity. */
function decodeDetail(raw: string | null | undefined, traderId: string, score: number, competitionStart: number): Detail {
  if (raw?.startsWith('{')) {
    try {
      return JSON.parse(raw) as Detail;
    } catch {
      // fall through
    }
  }
  return { n: raw ?? traderId, e: score, s: competitionStart };
}

const toEntry = (rank: number, traderId: string, detail: Detail): LeaderboardEntry => ({
  rank,
  traderId,
  displayName: detail.n,
  equity: round2(detail.e),
  startingBalance: detail.s,
  pnl: round2(detail.e - detail.s),
  returnPct: detail.s > 0 ? round2(((detail.e - detail.s) / detail.s) * 100) : 0,
});

/**
 * Replaces a competition's standings in Redis. The sorted set is built under a
 * temporary key and renamed into place inside one MULTI, so readers always see
 * either the old board or the new one, and traders who left simply disappear.
 */
export async function writeLeaderboard(competitionId: string, startingBalance: number, standings: Standing[]): Promise<void> {
  const key = keys.leaderboard(competitionId);
  const namesKey = keys.leaderboardNames(competitionId);
  const multi = redis.multi();

  if (standings.length > 0) {
    const staging = `${key}:staging:${randomUUID()}`;
    multi.zadd(staging, ...standings.flatMap((s) => [scoreOf(s.equity, s.startingBalance), s.traderId]));
    multi.rename(staging, key);
    multi.del(namesKey);
    multi.hset(namesKey, Object.fromEntries(standings.map((s) => [s.traderId, encodeDetail(s.displayName, s.equity, s.startingBalance)])));
  } else {
    multi.del(key, namesKey);
  }
  multi.hset(keys.leaderboardMeta(competitionId), {
    startingBalance: String(startingBalance),
    participants: String(standings.length),
    updatedAt: new Date().toISOString(),
  });
  await multi.exec();
}

/** Top-N straight from the Redis sorted set. Null when the board has never been built. */
export async function readLeaderboard(competitionId: string, limit: number): Promise<Leaderboard | null> {
  const [flat, meta] = await Promise.all([
    redis.zrevrange(keys.leaderboard(competitionId), 0, limit - 1, 'WITHSCORES'),
    redis.hgetall(keys.leaderboardMeta(competitionId)),
  ]);
  if (!meta.updatedAt) return null;

  const traderIds = flat.filter((_, i) => i % 2 === 0);
  const details = traderIds.length ? await redis.hmget(keys.leaderboardNames(competitionId), ...traderIds) : [];
  const startingBalance = Number(meta.startingBalance);

  return {
    competitionId,
    startingBalance,
    participants: Number(meta.participants),
    updatedAt: meta.updatedAt,
    entries: traderIds.map((traderId, i) => toEntry(i + 1, traderId, decodeDetail(details[i], traderId, Number(flat[i * 2 + 1]), startingBalance))),
  };
}

/** Rebuilds the board from the equity last persisted to Postgres. Used when Redis has been flushed. */
async function rebuildFromDatabase(competitionId: string): Promise<boolean> {
  const competition = await pool.query<{ starting_balance: string }>('SELECT starting_balance FROM competitions WHERE id = $1', [
    competitionId,
  ]);
  if (!competition.rows[0]) return false;
  const { rows } = await pool.query<{ trader_id: string; display_name: string; total_equity: string; funding: string }>(
    `SELECT u.trader_id, u.display_name, p.total_equity, p.funding
       FROM portfolios p
       JOIN users u ON u.id = p.user_id
      WHERE p.competition_id = $1`,
    [competitionId],
  );
  const start = Number(competition.rows[0].starting_balance);
  await writeLeaderboard(
    competitionId,
    start,
    rows.map((r) => ({ traderId: r.trader_id, displayName: r.display_name, equity: Number(r.total_equity), startingBalance: start + Number(r.funding) })),
  );
  return true;
}

/**
 * The leaderboard as the UI wants it: the top N plus the caller's own standing,
 * which matters when they are outside the top N.
 */
export async function getLeaderboard(
  competitionId: string,
  limit: number,
  traderId: string,
): Promise<(Leaderboard & { me: LeaderboardEntry | null }) | null> {
  let board = await readLeaderboard(competitionId, limit);
  if (!board) {
    if (!(await rebuildFromDatabase(competitionId))) return null;
    board = await readLeaderboard(competitionId, limit);
    if (!board) return null;
  }

  const inTop = board.entries.find((e) => e.traderId === traderId);
  if (inTop) return { ...board, me: inTop };

  const key = keys.leaderboard(competitionId);
  const [rank, score, detail] = await Promise.all([
    redis.zrevrank(key, traderId),
    redis.zscore(key, traderId),
    redis.hget(keys.leaderboardNames(competitionId), traderId),
  ]);
  const me = rank === null || score === null ? null : toEntry(rank + 1, traderId, decodeDetail(detail, traderId, Number(score), board.startingBalance));
  return { ...board, me };
}

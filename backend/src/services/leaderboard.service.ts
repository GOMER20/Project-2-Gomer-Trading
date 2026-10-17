import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { keys, redis } from '../redis/client.js';

export interface LeaderboardEntry {
  rank: number;
  traderId: string;
  displayName: string;
  equity: number;
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
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const toEntry = (rank: number, traderId: string, displayName: string, equity: number, startingBalance: number): LeaderboardEntry => ({
  rank,
  traderId,
  displayName,
  equity: round2(equity),
  pnl: round2(equity - startingBalance),
  returnPct: startingBalance > 0 ? round2(((equity - startingBalance) / startingBalance) * 100) : 0,
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
    multi.zadd(staging, ...standings.flatMap((s) => [s.equity, s.traderId]));
    multi.rename(staging, key);
    multi.del(namesKey);
    multi.hset(namesKey, Object.fromEntries(standings.map((s) => [s.traderId, s.displayName])));
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
  const names = traderIds.length ? await redis.hmget(keys.leaderboardNames(competitionId), ...traderIds) : [];
  const startingBalance = Number(meta.startingBalance);

  return {
    competitionId,
    startingBalance,
    participants: Number(meta.participants),
    updatedAt: meta.updatedAt,
    entries: traderIds.map((traderId, i) => toEntry(i + 1, traderId, names[i] ?? traderId, Number(flat[i * 2 + 1]), startingBalance)),
  };
}

/** Rebuilds the board from the equity last persisted to Postgres. Used when Redis has been flushed. */
async function rebuildFromDatabase(competitionId: string): Promise<boolean> {
  const competition = await pool.query<{ starting_balance: string }>('SELECT starting_balance FROM competitions WHERE id = $1', [
    competitionId,
  ]);
  if (!competition.rows[0]) return false;
  const { rows } = await pool.query<{ trader_id: string; display_name: string; total_equity: string }>(
    `SELECT u.trader_id, u.display_name, p.total_equity
       FROM portfolios p
       JOIN users u ON u.id = p.user_id
      WHERE p.competition_id = $1`,
    [competitionId],
  );
  await writeLeaderboard(
    competitionId,
    Number(competition.rows[0].starting_balance),
    rows.map((r) => ({ traderId: r.trader_id, displayName: r.display_name, equity: Number(r.total_equity) })),
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
  const [rank, score, name] = await Promise.all([
    redis.zrevrank(key, traderId),
    redis.zscore(key, traderId),
    redis.hget(keys.leaderboardNames(competitionId), traderId),
  ]);
  const me = rank === null || score === null ? null : toEntry(rank + 1, traderId, name ?? traderId, Number(score), board.startingBalance);
  return { ...board, me };
}

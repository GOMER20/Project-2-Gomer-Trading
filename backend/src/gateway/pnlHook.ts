import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { engine, type OrderEvent } from '../engine/matchingEngine.js';
import { logger } from '../lib/logger.js';
import { keys, redis } from '../redis/client.js';
import { readLeaderboard } from '../services/leaderboard.service.js';

/**
 * Real-time P&L hook.
 *
 * The leaderboard worker re-marks every portfolio every ten seconds. That is
 * right for prices drifting, but a fill changes a trader's standing at once,
 * and a fast program can trade many times inside ten seconds. So every fill,
 * the moment its transaction commits, is reported straight to the leaderboard
 * store in Redis:
 *
 *   lb:<competition>       the trader's score is set to their equity after the fill
 *   fills:<competition>    a capped stream of every fill (who, what, how many, at
 *                          what price, equity afterwards) for anything that wants
 *                          to follow the competition trade by trade
 *
 * and the new standings are announced on the channel the trading terminals
 * already listen to, so every screen's leaderboard moves with the trade.
 */

const FILL_STREAM_LENGTH = 10_000;
const ANNOUNCE_EVERY_MS = 400;

const traders = new Map<string, { traderId: string; displayName: string }>();
async function traderOf(userId: string): Promise<{ traderId: string; displayName: string } | null> {
  const known = traders.get(userId);
  if (known) return known;
  const { rows } = await pool.query<{ trader_id: string; display_name: string }>('SELECT trader_id, display_name FROM users WHERE id = $1', [userId]);
  if (!rows[0]) return null;
  const trader = { traderId: rows[0].trader_id, displayName: rows[0].display_name };
  traders.set(userId, trader);
  return trader;
}

/** A burst of fills in one competition announces the standings once, not once per fill. */
const pending = new Map<string, NodeJS.Timeout>();
function announce(competitionId: string): void {
  if (pending.has(competitionId)) return;
  pending.set(
    competitionId,
    setTimeout(() => {
      pending.delete(competitionId);
      readLeaderboard(competitionId, config.leaderboard.size)
        .then((board) => (board ? redis.publish(keys.leaderboardChannel, JSON.stringify(board)) : 0))
        .catch((err) => logger.debug({ err: (err as Error).message }, 'Leaderboard announcement skipped'));
    }, ANNOUNCE_EVERY_MS),
  );
}

async function onOrder(event: OrderEvent): Promise<void> {
  if (!event.fill) return;
  const trader = await traderOf(event.userId);
  if (!trader) return;
  const { order, fill, competitionId } = event;
  await redis
    .multi()
    .zadd(keys.leaderboard(competitionId), fill.equity, trader.traderId)
    .hset(keys.leaderboardNames(competitionId), trader.traderId, trader.displayName)
    .xadd(
      keys.fills(competitionId),
      'MAXLEN',
      '~',
      FILL_STREAM_LENGTH,
      '*',
      'traderId',
      trader.traderId,
      'orderId',
      order.id,
      'symbol',
      order.ticker,
      'side',
      order.side,
      'quantity',
      String(fill.quantity),
      'price',
      String(fill.price),
      'equity',
      String(fill.equity),
    )
    .exec();
  announce(competitionId);
}

const listener = (event: OrderEvent) => void onOrder(event).catch((err) => logger.warn({ err: (err as Error).message }, 'P&L hook could not report a fill'));

export const pnlHook = {
  start: () => void engine.on('order', listener),
  stop: () => {
    engine.off('order', listener);
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
  },
};

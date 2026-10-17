import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { config } from '../config.js';
import { pool, waitForDatabase } from '../db/pool.js';
import { valuePortfolio, type PositionState } from '../engine/accounting.js';
import { logger } from '../lib/logger.js';
import { markPrice } from '../market/mark.js';
import { keys, redis } from '../redis/client.js';
import { readLeaderboard, writeLeaderboard } from '../services/leaderboard.service.js';
import type { Quote } from '../types.js';

/**
 * Live P&L and leaderboard worker.
 *
 * Every LEADERBOARD_INTERVAL_MS (10s by default) it:
 *   1. loads every portfolio in every running competition, with its positions
 *   2. reads the latest price of each held symbol from the Redis quote cache
 *   3. computes each portfolio's NAV = cash + sum(quantity x price)
 *   4. persists equity and buying power to Postgres
 *   5. rewrites the competition's Redis sorted set and publishes the new top N
 *
 * It only ever writes derived columns (total_equity, buying_power), and only
 * while a competition is running. Cash and positions belong to the matching
 * engine, which also settles a competition when it ends: it closes every
 * position at the final price and records the result. From the moment a
 * competition ends this worker stops computing and simply publishes the
 * standings the engine has recorded, so it can never overwrite a final result.
 * A Redis lock makes it safe to run more than one replica.
 */

const INSTANCE_ID = randomUUID();

interface PortfolioRow {
  id: string;
  cash: string;
  /** Money given to this account alone, on top of the competition's starting money. */
  funding: string;
  trader_id: string;
  display_name: string;
}

interface CompetitionRow {
  id: string;
  name: string;
  starting_balance: string;
  leverage: string;
  ended: boolean;
}

/** Latest marks for the given symbols from the cache the API process maintains. */
async function loadMarks(tickers: string[]): Promise<Map<string, Decimal>> {
  const marks = new Map<string, Decimal>();
  if (tickers.length === 0) return marks;
  const cached = await redis.hmget(keys.quotes, ...tickers);
  tickers.forEach((ticker, i) => {
    const raw = cached[i];
    if (!raw) return;
    try {
      const mark = markPrice(JSON.parse(raw) as Quote);
      if (mark > 0) marks.set(ticker, new Decimal(mark));
    } catch {
      // A corrupt cache entry is treated as a missing price.
    }
  });
  return marks;
}

async function updateCompetition(competition: CompetitionRow): Promise<number> {
  const portfolios = await pool.query<PortfolioRow>(
    `SELECT p.id, p.cash, p.funding, u.trader_id, u.display_name
       FROM portfolios p
       JOIN users u ON u.id = p.user_id
      WHERE p.competition_id = $1`,
    [competition.id],
  );
  const positions = await pool.query<{ portfolio_id: string; ticker: string; quantity: number; average_price: string }>(
    `SELECT pos.portfolio_id, pos.ticker, pos.quantity, pos.average_price
       FROM positions pos
       JOIN portfolios p ON p.id = pos.portfolio_id
      WHERE p.competition_id = $1`,
    [competition.id],
  );

  const byPortfolio = new Map<string, Map<string, PositionState>>();
  for (const row of positions.rows) {
    let held = byPortfolio.get(row.portfolio_id);
    if (!held) byPortfolio.set(row.portfolio_id, (held = new Map()));
    held.set(row.ticker, { quantity: row.quantity, averagePrice: new Decimal(row.average_price) });
  }

  const marks = await loadMarks([...new Set(positions.rows.map((r) => r.ticker))]);
  const leverage = new Decimal(competition.leverage);
  const empty = new Map<string, PositionState>();

  const ids: string[] = [];
  const equities: string[] = [];
  const buyingPowers: string[] = [];
  const standings = portfolios.rows.map((portfolio) => {
    // A symbol missing from the cache is carried at cost by valuePortfolio.
    const valuation = valuePortfolio(
      new Decimal(portfolio.cash),
      byPortfolio.get(portfolio.id) ?? empty,
      (ticker) => marks.get(ticker) ?? null,
      leverage,
    );
    ids.push(portfolio.id);
    equities.push(valuation.equity.toFixed(4));
    buyingPowers.push(valuation.buyingPower.toFixed(4));
    return {
      traderId: portfolio.trader_id,
      displayName: portfolio.display_name,
      equity: valuation.equity.toDecimalPlaces(2).toNumber(),
      startingBalance: Number(competition.starting_balance) + Number(portfolio.funding),
    };
  });

  if (ids.length > 0) {
    // One statement for the whole competition instead of a round trip per portfolio.
    await pool.query(
      `UPDATE portfolios p
          SET total_equity = v.equity, buying_power = v.buying_power
         FROM unnest($1::uuid[], $2::numeric[], $3::numeric[]) AS v(id, equity, buying_power)
        WHERE p.id = v.id AND (p.total_equity, p.buying_power) IS DISTINCT FROM (v.equity, v.buying_power)`,
      [ids, equities, buyingPowers],
    );
  }

  await writeLeaderboard(competition.id, Number(competition.starting_balance), standings);
  const board = await readLeaderboard(competition.id, config.leaderboard.size);
  if (board) await redis.publish(keys.leaderboardChannel, JSON.stringify(board));
  return standings.length;
}

/** Publishes the standings of a competition that has ended, exactly as the engine recorded them. */
async function publishFinal(competition: CompetitionRow): Promise<number> {
  const { rows } = await pool.query<{ trader_id: string; display_name: string; total_equity: string; funding: string }>(
    `SELECT u.trader_id, u.display_name, p.total_equity, p.funding
       FROM portfolios p
       JOIN users u ON u.id = p.user_id
      WHERE p.competition_id = $1`,
    [competition.id],
  );
  const standings = rows.map((row) => ({
    traderId: row.trader_id,
    displayName: row.display_name,
    equity: new Decimal(row.total_equity).toDecimalPlaces(2).toNumber(),
    startingBalance: Number(competition.starting_balance) + Number(row.funding),
  }));
  await writeLeaderboard(competition.id, Number(competition.starting_balance), standings);
  const board = await readLeaderboard(competition.id, config.leaderboard.size);
  if (board) await redis.publish(keys.leaderboardChannel, JSON.stringify(board));
  return standings.length;
}

async function runOnce(): Promise<{ competitions: number; portfolios: number }> {
  const { rows } = await pool.query<CompetitionRow>(
    // A competition is followed until a minute after it is settled, so the final standings are published.
    `SELECT id, name, starting_balance, leverage, end_date <= now() AS ended
       FROM competitions
      WHERE start_date <= now() AND (settled_at IS NULL OR settled_at > now() - interval '60 seconds')`,
  );
  let portfolios = 0;
  for (const competition of rows) {
    try {
      portfolios += competition.ended ? await publishFinal(competition) : await updateCompetition(competition);
    } catch (err) {
      // One bad competition must not stall the others.
      logger.error({ err, competition: competition.name }, 'Leaderboard update failed');
    }
  }
  return { competitions: rows.length, portfolios };
}

async function tick(): Promise<void> {
  // Held for slightly less than one interval: with several replicas, exactly one runs each pass.
  const ttl = Math.max(1_000, config.leaderboard.intervalMs - 500);
  const acquired = await redis.set(keys.workerLock, INSTANCE_ID, 'PX', ttl, 'NX');
  if (!acquired) return;

  const started = Date.now();
  const result = await runOnce();
  logger.debug(`Leaderboards refreshed: ${result.portfolios} portfolios in ${result.competitions} competitions (${Date.now() - started}ms)`);
}

async function main(): Promise<void> {
  // One pass at a time: a few connections are plenty, and the rest of the server's allowance stays with the API.
  pool.options.max = Math.min(pool.options.max ?? 5, 5);
  await waitForDatabase();
  logger.info(`Leaderboard worker started (every ${config.leaderboard.intervalMs / 1000}s)`);

  let running = false;
  const safeTick = async () => {
    if (running) return; // previous pass still going: skip rather than overlap
    running = true;
    try {
      await tick();
    } catch (err) {
      logger.error({ err }, 'Leaderboard pass failed');
    } finally {
      running = false;
    }
  };

  await safeTick();
  const timer = setInterval(() => void safeTick(), config.leaderboard.intervalMs);

  const shutdown = async () => {
    clearInterval(timer);
    await pool.end().catch(() => undefined);
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled promise rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception, restarting');
    process.exit(1);
  });
}

main().catch((err) => {
  logger.fatal(err, 'Leaderboard worker failed to start');
  process.exit(1);
});

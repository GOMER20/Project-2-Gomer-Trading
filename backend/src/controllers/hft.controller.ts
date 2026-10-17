import fs from 'node:fs/promises';
import path from 'node:path';
import type { RequestHandler } from 'express';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { valuePortfolio } from '../engine/accounting.js';
import { engine } from '../engine/matchingEngine.js';
import { hft, venues } from '../hft/index.js';
import { logger } from '../lib/logger.js';
import { market } from '../market/marketData.js';

/**
 * GET /api/hft (owner): how HFT is doing. `status` is this server's side of it
 * (whether HFT is running, and what has been copied to it); `stats` is what
 * HFT measured about itself in its current session, or null while it is down.
 */
export const status: RequestHandler = async (_req, res) => {
  res.json({ status: hft.status(), stats: await hft.stats(), venues: venues.status() });
};

// --- HFT Strategy ----------------------------------------------------------------

/** A status older than this means the program is not running (it writes one every second). */
const STALE_MS = 5_000;

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The program's account, found from the trader and competition its status names. */
async function strategyAccount(status: Record<string, unknown> | null): Promise<string | null> {
  const trader = typeof status?.trader === 'string' ? status.trader : null;
  const hex = typeof status?.competition === 'string' ? status.competition : '';
  if (!trader || !/^[0-9a-f]{32}$/.test(hex)) return null;
  const competition = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const { rows } = await pool.query<{ id: string }>(
    'SELECT p.id FROM portfolios p JOIN users u ON u.id = p.user_id WHERE u.trader_id = $1 AND p.competition_id = $2',
    [trader, competition],
  );
  return rows[0]?.id ?? null;
}

function isRunning(status: Record<string, unknown> | null): boolean {
  const updated = typeof status?.updated === 'string' ? Date.parse(status.updated) : NaN;
  return status !== null && status.state !== 'stopped' && Number.isFinite(updated) && Date.now() - updated < STALE_MS;
}

/**
 * GET /api/hft/strategy (owner): HFT Strategy, the market-making program from
 * Project 1, as it last said it was doing (the status.json it writes every
 * second while it runs), its account as the exchange holds it, and its latest
 * session report.
 */
export const strategy: RequestHandler = async (_req, res) => {
  const dir = config.hft.strategyDir;
  const status = await readJson(path.join(dir, 'status.json'));
  const portfolioId = await strategyAccount(status);
  const account = portfolioId ? await engine.account(portfolioId) : null;
  let latest: string | null = null;
  try {
    latest = await fs.readFile(path.join(dir, 'latest.md'), 'utf8');
  } catch {
    // no session finished yet
  }
  const markOf = (ticker: string) => market.getMark(ticker);
  const valuation = account ? valuePortfolio(account.cash, account.positions, markOf, account.rules.leverage) : null;
  res.json({
    dir,
    running: isRunning(status),
    killPending: await fs
      .access(path.join(dir, 'kill'))
      .then(() => true)
      .catch(() => false),
    status,
    latest,
    account:
      account && valuation
        ? {
            portfolioId: account.id,
            competitionId: account.competitionId,
            fillModel: account.rules.fillModel,
            startingBalance: account.startingBalance.toNumber(),
            equity: valuation.equity.toDecimalPlaces(2).toNumber(),
            pnl: valuation.equity.minus(account.startingBalance).toDecimalPlaces(2).toNumber(),
            cash: account.cash.toDecimalPlaces(2).toNumber(),
            workingOrders: [...account.working.values()].filter((order) => order.status === 'OPEN').length,
            positions: [...account.positions].map(([ticker, position]) => ({
              ticker,
              quantity: position.quantity,
              averagePrice: position.averagePrice.toDecimalPlaces(4).toNumber(),
              mark: markOf(ticker)?.toNumber() ?? null,
            })),
          }
        : null,
  });
};

/**
 * POST /api/hft/strategy/kill (owner): the kill switch. HFT Strategy is told to
 * stop (it looks for a file named `kill` in its folder every second), and it
 * withdraws its orders, closes its positions and writes its report. If it is
 * not running, the exchange cancels its account's orders and closes its
 * positions itself, so that nothing is left behind either way.
 */
export const killStrategy: RequestHandler = async (_req, res) => {
  const dir = config.hft.strategyDir;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'kill'), `${new Date().toISOString()}\n`);
  const status = await readJson(path.join(dir, 'status.json'));
  const running = isRunning(status);
  let closed: { cancelled: number; closing: number } | null = null;
  if (!running) {
    const portfolioId = await strategyAccount(status);
    if (portfolioId) closed = await engine.closeOut(portfolioId, 'Kill switch');
  }
  logger.warn({ running, closed }, 'HFT Strategy kill switch pressed');
  res.json({ told: running, closed });
};

const MAX_SESSIONS = 40;

/**
 * GET /api/hft/sessions (owner): the statistics HFT wrote at the end of each
 * session it ran, newest first. They are kept in its folder (the latest few)
 * and in history/ (older ones), a few kilobytes each.
 */
export const sessions: RequestHandler = async (_req, res) => {
  const dir = config.hft.dataDir;
  const found = new Map<string, string>();
  for (const folder of [path.join(dir, 'history'), dir]) {
    try {
      for (const name of await fs.readdir(folder)) if (/^hft-session-.*\.stats\.json$/.test(name)) found.set(name, path.join(folder, name));
    } catch {
      // no such folder yet
    }
  }
  const names = [...found.keys()].sort().reverse().slice(0, MAX_SESSIONS);
  const loaded = await Promise.all(
    names.map(async (name) => {
      try {
        const stats = JSON.parse(await fs.readFile(found.get(name)!, 'utf8')) as Record<string, unknown>;
        return { name: name.replace(/\.stats\.json$/, ''), stats };
      } catch {
        return null;
      }
    }),
  );
  res.json({ sessions: loaded.filter(Boolean) });
};

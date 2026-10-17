import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { engine } from '../engine/matchingEngine.js';
import { registry } from '../gateway/session.js';
import { logger } from '../lib/logger.js';
import { marketHours, sessionsBefore } from '../market/usMarketHours.js';
import { toOrderDto, type OrderDto, type OrderSide } from '../types.js';
import { getPortfolio, type PortfolioDto } from './portfolio.service.js';

/**
 * Everything about AT, the trading algorithm, for its window.
 *
 * Two sources, kept apart because they answer different questions:
 *  - what AT actually did on this exchange, from the exchange's own records
 *    (its accounts, every fill, its open orders, whether it is connected);
 *  - what AT measures about itself, from the reports it writes in its own
 *    folder (each live session's statistics and loss review, and the research
 *    that chose its settings). Only on the machine AT runs on.
 *
 * AT is found by the label of its API keys ("AT", "AT (Demo Trading Challenge)").
 */

/** One finished trade: a position (or part of one) opened and then closed by one order. */
export interface AtTrade {
  ticker: string;
  direction: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  openedAt: string;
  closedAt: string;
  /** Profit or loss on the trade, before commission. */
  pnl: number;
  /** New York date of the session it closed in. */
  session: string;
}

export interface AtSummary {
  trades: number;
  wins: number;
  losses: number;
  /** wins / trades, or null with no trades. */
  winRate: number | null;
  /** Sum of the trades' results, less every commission paid. */
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  avgWin: number | null;
  avgLoss: number | null;
  /** Gross profit over gross loss; null without a loss. */
  profitFactor: number | null;
  best: number | null;
  worst: number | null;
  longestLosingStreak: number;
  avgHoldSeconds: number | null;
  /** Share of trades that were long. */
  longShare: number | null;
}

export interface AtSessionRow {
  session: string;
  trades: number;
  wins: number;
  winRate: number | null;
  pnl: number;
}

export interface AtFill {
  ticker: string;
  side: OrderSide;
  quantity: number;
  price: number;
  realizedPnl: number;
  executedAt: string;
}

export interface AtAccount {
  portfolioId: string;
  traderId: string;
  competition: { id: string; name: string; startDate: string; endDate: string; status: 'UPCOMING' | 'ACTIVE' | 'ENDED'; startingBalance: number };
  /** The API keys pinned to this competition now. None: AT used to trade here. */
  keys: Array<{ id: string; label: string; enabled: boolean; lastUsedAt: string | null }>;
  connection: { connected: boolean; connections: number; transports: string[]; since: string | null; ordersThisConnection: number };
  portfolio: PortfolioDto | null;
  summary: AtSummary;
  /** The session in progress, or the latest one. */
  thisSession: AtSummary & { session: string };
  sessions: AtSessionRow[];
  /** Running total of the trades' results, one point per trade, oldest first. */
  curve: Array<{ time: number; pnl: number }>;
  /** Newest first. */
  trades: AtTrade[];
  /** Newest first. */
  fills: AtFill[];
  workingOrders: OrderDto[];
}

export interface AtReportSession {
  /** The run's folder name: a session date, or a date and time for a trial. */
  name: string;
  stats: Record<string, unknown> | null;
  review: Record<string, unknown> | null;
  /** The run's report, as written (Markdown). */
  report: string | null;
}

export interface AtReports {
  home: string;
  /** The last thing AT's scheduler wrote, e.g. "US market opens Mon 19 Oct at 19:00 (local time). Waiting." */
  agent: { line: string | null; at: string | null };
  research: {
    holdout: Record<string, unknown> | null;
    previousWinRate: number | null;
    randomEntryWinRate: number | null;
    steadiness: Record<string, unknown> | null;
    configuration: string | null;
  } | null;
  sessions: AtReportSession[];
}

export interface AtDashboard {
  label: string;
  found: boolean;
  accounts: AtAccount[];
  reports: AtReports | null;
  asOf: string;
}

const MAX_TRADES = 300;
const MAX_FILLS = 60;
const MAX_REPORT_SESSIONS = 30;
const MAX_REPORT_BYTES = 40_000;

const newYorkDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const sessionOf = (at: Date) => newYorkDate.format(at);
const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface ExecutionRow {
  order_id: string;
  ticker: string;
  side: OrderSide;
  quantity: number;
  price: string;
  commission: string;
  realized_pnl: string;
  executed_at: Date;
}

/**
 * Turns fills into finished trades. Per symbol it follows the position: a fill
 * on the same side opens or adds, a fill on the other side closes. Each order
 * that closes something is one trade; its result is the realized profit the
 * exchange booked on those fills.
 */
export function tradesFrom(executions: ExecutionRow[]): { trades: AtTrade[]; commissions: number } {
  const trades: AtTrade[] = [];
  const open = new Map<string, { quantity: number; openedAt: Date }>();
  let closing: { orderId: string; trade: AtTrade; exitValue: number } | null = null;
  let commissions = 0;

  const finish = () => {
    if (!closing) return;
    const { trade, exitValue } = closing;
    trade.exitPrice = round(exitValue / trade.quantity, 4);
    // realized = (exit - entry) x quantity for a long, (entry - exit) x quantity for a short
    trade.entryPrice = round(trade.direction === 'LONG' ? trade.exitPrice - trade.pnl / trade.quantity : trade.exitPrice + trade.pnl / trade.quantity, 4);
    trade.pnl = round(trade.pnl);
    trades.push(trade);
    closing = null;
  };

  for (const row of executions) {
    commissions += Number(row.commission);
    const signed = row.side === 'BUY' ? row.quantity : -row.quantity;
    const position = open.get(row.ticker) ?? { quantity: 0, openedAt: row.executed_at };
    const reduces = position.quantity !== 0 && Math.sign(position.quantity) !== Math.sign(signed);

    if (closing && (closing.orderId !== row.order_id || !reduces)) finish();
    if (reduces) {
      const closed = Math.min(Math.abs(signed), Math.abs(position.quantity));
      if (!closing) {
        closing = {
          orderId: row.order_id,
          exitValue: 0,
          trade: {
            ticker: row.ticker,
            direction: position.quantity > 0 ? 'LONG' : 'SHORT',
            quantity: 0,
            entryPrice: 0,
            exitPrice: 0,
            openedAt: position.openedAt.toISOString(),
            closedAt: row.executed_at.toISOString(),
            pnl: 0,
            session: sessionOf(row.executed_at),
          },
        };
      }
      closing.trade.quantity += closed;
      closing.exitValue += closed * Number(row.price);
      closing.trade.pnl += Number(row.realized_pnl);
      closing.trade.closedAt = row.executed_at.toISOString();
      closing.trade.session = sessionOf(row.executed_at);
    }

    const before = position.quantity;
    position.quantity += signed;
    // Opened from flat, or turned from long to short (or back) in one fill: a new position starts here.
    if (before === 0 || (position.quantity !== 0 && Math.sign(position.quantity) !== Math.sign(before))) position.openedAt = row.executed_at;
    if (position.quantity === 0) {
      open.delete(row.ticker);
      finish();
    } else {
      open.set(row.ticker, position);
    }
  }
  finish();
  return { trades, commissions };
}

export function summarise(trades: AtTrade[], commissions = 0): AtSummary {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = losses.reduce((sum, t) => sum + t.pnl, 0);
  let streak = 0;
  let longest = 0;
  for (const trade of trades) {
    streak = trade.pnl < 0 ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }
  const held = trades.map((t) => (Date.parse(t.closedAt) - Date.parse(t.openedAt)) / 1000);
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : null,
    netPnl: round(grossProfit + grossLoss - commissions),
    grossProfit: round(grossProfit),
    grossLoss: round(grossLoss),
    avgWin: wins.length ? round(grossProfit / wins.length) : null,
    avgLoss: losses.length ? round(grossLoss / losses.length) : null,
    profitFactor: grossLoss < 0 ? round(grossProfit / -grossLoss, 3) : null,
    best: trades.length ? round(Math.max(...trades.map((t) => t.pnl))) : null,
    worst: trades.length ? round(Math.min(...trades.map((t) => t.pnl))) : null,
    longestLosingStreak: longest,
    avgHoldSeconds: held.length ? Math.round(held.reduce((a, b) => a + b, 0) / held.length) : null,
    longShare: trades.length ? trades.filter((t) => t.direction === 'LONG').length / trades.length : null,
  };
}

function bySession(trades: AtTrade[]): AtSessionRow[] {
  const rows = new Map<string, AtSessionRow>();
  for (const trade of trades) {
    const row = rows.get(trade.session) ?? { session: trade.session, trades: 0, wins: 0, winRate: null, pnl: 0 };
    row.trades++;
    if (trade.pnl > 0) row.wins++;
    row.pnl += trade.pnl;
    rows.set(trade.session, row);
  }
  return [...rows.values()]
    .map((row) => ({ ...row, pnl: round(row.pnl), winRate: row.trades ? row.wins / row.trades : null }))
    .sort((a, b) => b.session.localeCompare(a.session));
}

/** The New York date of the session in progress, or of the latest one when the market is shut. */
function currentSession(now = new Date()): string {
  const hours = marketHours(now, 1);
  return hours.open ? hours.session.date : (sessionsBefore(now, 1)[0]?.date ?? hours.session.date);
}

interface AccountRow {
  portfolio_id: string;
  user_id: string;
  trader_id: string;
  competition_id: string;
  competition_name: string;
  start_date: Date;
  end_date: Date;
  starting_balance: string;
}

interface KeyRow {
  id: string;
  label: string;
  user_id: string;
  competition_id: string;
  enabled: boolean;
  last_used_at: Date | null;
}

async function account(row: AccountRow, keys: KeyRow[], brief: boolean): Promise<AtAccount> {
  const now = new Date();
  // Answers are given before they are written; wait for the writing so every fill is here.
  await engine.drained();
  const { rows: executions } = await pool.query<ExecutionRow>(
    `SELECT order_id, ticker, side, quantity, price, commission, realized_pnl, executed_at
       FROM executions WHERE portfolio_id = $1 ORDER BY executed_at, id`,
    [row.portfolio_id],
  );
  const { trades, commissions } = tradesFrom(executions);
  const session = currentSession(now);

  let portfolio: PortfolioDto | null = null;
  let workingOrders: OrderDto[] = [];
  try {
    portfolio = await getPortfolio(row.user_id, row.competition_id);
    const live = await engine.accountFor(row.user_id, row.competition_id);
    workingOrders = live ? [...live.working.values()].map(toOrderDto) : [];
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'AT account could not be valued');
  }

  const sessions = keys.flatMap((key) => registry.forKey(key.id));
  let running = 0;
  return {
    portfolioId: row.portfolio_id,
    traderId: row.trader_id,
    competition: {
      id: row.competition_id,
      name: row.competition_name,
      startDate: row.start_date.toISOString(),
      endDate: row.end_date.toISOString(),
      status: now < row.start_date ? 'UPCOMING' : now > row.end_date ? 'ENDED' : 'ACTIVE',
      startingBalance: Number(row.starting_balance),
    },
    keys: keys.map((key) => ({ id: key.id, label: key.label, enabled: key.enabled, lastUsedAt: key.last_used_at?.toISOString() ?? null })),
    connection: {
      connected: sessions.length > 0,
      connections: sessions.length,
      transports: [...new Set(sessions.map((s) => s.transport))],
      since: sessions.length ? new Date(Math.min(...sessions.map((s) => s.connectedAt))).toISOString() : null,
      ordersThisConnection: sessions.reduce((sum, s) => sum + s.counters.orders, 0),
    },
    portfolio,
    summary: summarise(trades, commissions),
    thisSession: { ...summarise(trades.filter((t) => t.session === session)), session },
    sessions: bySession(trades),
    curve: brief ? [] : trades.map((t) => ({ time: Math.floor(Date.parse(t.closedAt) / 1000), pnl: round((running += t.pnl)) })),
    trades: brief ? [] : trades.slice(-MAX_TRADES).reverse(),
    fills: brief
      ? []
      : executions
          .slice(-MAX_FILLS)
          .reverse()
          .map((e) => ({ ticker: e.ticker, side: e.side, quantity: e.quantity, price: Number(e.price), realizedPnl: Number(e.realized_pnl), executedAt: e.executed_at.toISOString() })),
    workingOrders,
  };
}

// --- AT's own reports --------------------------------------------------------

/** AT is written in Python, whose JSON may contain NaN and Infinity. */
function parseLoose(text: string): unknown {
  return JSON.parse(text.replace(/\bNaN\b|-?\bInfinity\b/g, 'null'));
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = parseLoose(await fs.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readText(file: string, limit = MAX_REPORT_BYTES): Promise<string | null> {
  try {
    const text = await fs.readFile(file, 'utf8');
    return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
  } catch {
    return null;
  }
}

async function readReports(home: string): Promise<AtReports | null> {
  const runs = path.join(home, 'runs');
  try {
    await fs.access(runs);
  } catch {
    return null;
  }

  let agent: AtReports['agent'] = { line: null, at: null };
  try {
    const log = path.join(runs, 'at-agent.log');
    const [text, stat] = await Promise.all([readText(log, 1_000_000), fs.stat(log)]);
    const lines = (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    // Lines look like "17 Oct 06:11:14 at.run US market opens ...": keep what it says.
    const last = lines.at(-1) ?? null;
    agent = { line: last ? last.replace(/^\d{1,2} \w{3} \d{2}:\d{2}:\d{2} \S+ /, '') : null, at: stat.mtime.toISOString() };
  } catch {
    // no scheduler log yet
  }

  const results = await readJson(path.join(home, 'reports', 'backtest_results.json'));
  const pick = (value: unknown) => (value && typeof value === 'object' ? (value as Record<string, unknown>) : null);
  const winRate = (value: unknown) => {
    const rate = pick(value)?.win_rate;
    return typeof rate === 'number' ? rate : null;
  };
  const research = results
    ? {
        holdout: pick(results.holdout),
        previousWinRate: winRate(results.holdout_previous),
        randomEntryWinRate: winRate(results.random_entry),
        steadiness: pick(results.steadiness),
        configuration: typeof pick(results.final_config)?.playbook === 'string' ? (pick(results.final_config)!.playbook as string) : null,
      }
    : null;

  const sessions: AtReportSession[] = [];
  try {
    const entries = await fs.readdir(runs, { withFileTypes: true });
    const names = entries
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}/.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse()
      .slice(0, MAX_REPORT_SESSIONS);
    for (const name of names) {
      const dir = path.join(runs, name);
      const [stats, review, report] = await Promise.all([readJson(path.join(dir, 'stats.json')), readJson(path.join(dir, 'loss_review.json')), readText(path.join(dir, 'report.md'))]);
      sessions.push({ name, stats, review, report });
    }
  } catch {
    // an unreadable folder shows as no sessions
  }

  return { home, agent, research, sessions };
}

// --- the dashboard -------------------------------------------------------------

/** @param brief leave out the long lists and AT's reports (for the small box on the terminal) */
export async function getAtDashboard(brief = false): Promise<AtDashboard> {
  const label = config.at.label;
  const { rows: allKeys } = await pool.query<KeyRow>('SELECT id, label, user_id, competition_id, enabled, last_used_at FROM api_keys ORDER BY created_at');
  const pattern = new RegExp(`^${escape(label)}(\\b|$)`, 'i');
  const keys = allKeys.filter((key) => pattern.test(key.label));
  const userIds = [...new Set(keys.map((key) => key.user_id))];

  let accounts: AtAccount[] = [];
  if (userIds.length) {
    // Every account AT has, including competitions it has since been moved out of.
    const { rows } = await pool.query<AccountRow>(
      `SELECT p.id AS portfolio_id, p.user_id, u.trader_id, c.id AS competition_id, c.name AS competition_name, c.start_date, c.end_date, c.starting_balance
         FROM portfolios p
         JOIN users u ON u.id = p.user_id
         JOIN competitions c ON c.id = p.competition_id
        WHERE p.user_id = ANY($1::uuid[])
        ORDER BY c.end_date DESC`,
      [userIds],
    );
    accounts = await Promise.all(rows.map((row) => account(row, keys.filter((k) => k.user_id === row.user_id && k.competition_id === row.competition_id), brief)));
    // Where AT trades now first, then where it traded before, busiest first.
    accounts.sort((a, b) => Number(b.keys.length > 0) - Number(a.keys.length > 0) || b.summary.trades - a.summary.trades);
  }

  return {
    label,
    found: keys.length > 0,
    accounts,
    reports: !brief && config.at.home ? await readReports(config.at.home) : null,
    asOf: new Date().toISOString(),
  };
}

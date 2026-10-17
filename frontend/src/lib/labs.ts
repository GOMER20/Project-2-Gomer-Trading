'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, API_URL, errorMessage } from './api';
import { desktopBridge } from './desktop';
import type { Order, Portfolio } from './types';

/**
 * The AT and HFT windows: their data, and opening them.
 *
 * AT is the trading algorithm that trades on this exchange through the bot
 * gateway; HFT is the order book engine that runs beside it. Both are shown to
 * the owner of the exchange only (see the server's isOwner).
 */

export type LabWindow = 'at' | 'hft';

/** Opens a window of its own: through the desktop app when there is one, otherwise as a browser window. */
export function openLabWindow(name: LabWindow): void {
  const desktop = desktopBridge();
  if (desktop?.openWindow) return desktop.openWindow(name);
  const opened = window.open(`/${name}`, `gomer-${name}`, 'popup,width=1320,height=880');
  // A blocked pop-up still gets there, in this tab.
  if (!opened) window.location.assign(`/${name}`);
}

/**
 * Loads `path` now and every `everyMs`, keeping the last good answer through a failed refresh.
 * Signed in as the current session, or with `token` when one is given (null: wait for it).
 */
export function usePoll<T>(path: string, everyMs: number, token?: string | null): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    if (token === null) return;
    const request =
      token === undefined
        ? api<T>(path)
        : fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }).then(async (response) => {
            const body = await response.json().catch(() => null);
            if (!response.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
            return body as T;
          });
    request
      .then((loaded) => {
        setData(loaded);
        setError(null);
      })
      .catch((err) => setError(errorMessage(err)));
  }, [path, token]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, everyMs);
    return () => clearInterval(timer);
  }, [reload, everyMs]);
  return { data, error, reload };
}

// --- AT --------------------------------------------------------------------------

export interface AtTrade {
  ticker: string;
  direction: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  openedAt: string;
  closedAt: string;
  pnl: number;
  session: string;
}

export interface AtSummary {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  avgWin: number | null;
  avgLoss: number | null;
  profitFactor: number | null;
  best: number | null;
  worst: number | null;
  longestLosingStreak: number;
  avgHoldSeconds: number | null;
  longShare: number | null;
}

export interface AtAccount {
  portfolioId: string;
  traderId: string;
  competition: {
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    status: 'UPCOMING' | 'ACTIVE' | 'ENDED';
    startingBalance: number;
  };
  keys: Array<{
    id: string;
    label: string;
    enabled: boolean;
    lastUsedAt: string | null;
  }>;
  connection: {
    connected: boolean;
    connections: number;
    transports: string[];
    since: string | null;
    ordersThisConnection: number;
  };
  portfolio: Portfolio | null;
  summary: AtSummary;
  thisSession: AtSummary & { session: string };
  sessions: Array<{
    session: string;
    trades: number;
    wins: number;
    winRate: number | null;
    pnl: number;
  }>;
  curve: Array<{ time: number; pnl: number }>;
  trades: AtTrade[];
  fills: Array<{
    ticker: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    price: number;
    realizedPnl: number;
    executedAt: string;
  }>;
  workingOrders: Order[];
}

/** Statistics AT writes about a run (Python names, as AT writes them). */
export type AtStats = Partial<
  Record<
    | 'trades'
    | 'win_rate'
    | 'win_rate_ci_low'
    | 'win_rate_ci_high'
    | 'net_pnl'
    | 'profit_factor'
    | 'expectancy'
    | 'expectancy_bps'
    | 'max_drawdown'
    | 'avg_win'
    | 'avg_loss'
    | 'payoff_ratio'
    | 'best_trade'
    | 'worst_trade'
    | 'longest_losing_streak'
    | 'days'
    | 'trades_per_day'
    | 'session_return'
    | 'starting_equity'
    | 'ending_equity',
    number | null
  >
> & {
  exits?: Record<string, { trades: number; win_rate: number | null; pnl: number }>;
};

export interface AtReports {
  home: string;
  agent: { line: string | null; at: string | null };
  research: {
    holdout: AtStats | null;
    previousWinRate: number | null;
    randomEntryWinRate: number | null;
    steadiness: Partial<Record<'overall' | 'half_hour_p5' | 'half_hours_below_70' | 'session_min' | 'session_median' | 'sessions_below_80' | 'sessions' | 'trades_per_session', number | null>> | null;
    configuration: string | null;
  } | null;
  sessions: Array<{
    name: string;
    stats: AtStats | null;
    review:
      | (Record<string, unknown> & {
          update_recommended?: boolean;
          trades?: number;
        })
      | null;
    report: string | null;
  }>;
}

export interface AtDashboard {
  label: string;
  found: boolean;
  accounts: AtAccount[];
  reports: AtReports | null;
  asOf: string;
}

// --- HFT -------------------------------------------------------------------------

/** How long HFT took over something, in nanoseconds. */
export interface HftTiming {
  count: number;
  mean_ns: number;
  p50_ns: number;
  p90_ns: number;
  p99_ns: number;
  p999_ns: number;
  max_ns: number;
}

export interface HftStats {
  session: number;
  started: string;
  uptime_seconds: number;
  orders: number;
  cancels: number;
  quotes: number;
  quotes_refused: number;
  accepted: number;
  rejected: number;
  trades: number;
  trades_between_clients: number;
  shares: number;
  house_rejected: number;
  engine_commands: number;
  events_dropped: number;
  digest: string;
  order_time: HftTiming;
  quote_time: HftTiming;
  busiest_second: number;
  resting_client_orders: number;
  resting_house_orders: number;
}

export interface HftStatusLite {
  mode: 'off' | 'test';
  state: 'off' | 'unavailable' | 'starting' | 'running' | 'down';
  detail: string | null;
  restarts: number;
  symbols: string[];
  marketSession: string | null;
}

/** A time in whichever unit reads best: "740 ns", "12.4 µs", "3.1 ms". */
export function span(nanoseconds: number): string {
  if (nanoseconds < 1_000) return `${Math.round(nanoseconds)} ns`;
  if (nanoseconds < 1_000_000) return `${(nanoseconds / 1_000).toFixed(1)} µs`;
  if (nanoseconds < 1_000_000_000) return `${(nanoseconds / 1_000_000).toFixed(1)} ms`;
  return `${(nanoseconds / 1_000_000_000).toFixed(2)} s`;
}

/** "63.6%" */
export const percent = (share: number | null | undefined, places = 1) => (share == null || !Number.isFinite(share) ? '—' : `${(share * 100).toFixed(places)}%`);

/** "63.6% (14 of 22 trades)" */
export function successRate(summary: { wins: number; trades: number; winRate: number | null }): string {
  if (!summary.trades) return 'no trades yet';
  return `${percent(summary.winRate)} (${summary.wins} of ${summary.trades} trade${summary.trades === 1 ? '' : 's'})`;
}

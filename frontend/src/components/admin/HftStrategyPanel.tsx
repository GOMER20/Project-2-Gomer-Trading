'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { localMoment, pnlColor, price, shares, signedUsd, usd } from '@/lib/format';

/** One summary of trades, as backtest/report.hpp in Project 1 writes it. */
interface Summary {
  success_rate: number;
  success_text: string;
  success_low: number;
  success_high: number;
  trades: number;
  wins: number;
  net: number;
  per_trade: number;
  t_stat: number;
  worst: number;
  max_drawdown: number;
  fill_rate: number;
  adverse_1s_cents: number;
  adverse_5s_cents: number;
}

/** What HFT Strategy writes to status.json once a second while it runs. */
interface StrategyStatus {
  state: 'waiting for the market' | 'trading' | 'stopping' | 'stopped';
  reason: string;
  started: string;
  updated: string;
  trader: string;
  symbols: number;
  symbols_trading: number;
  pnl: number;
  summary: Summary;
  holdings: Array<{ symbol: string; shares: number; entry: number; mark: number }>;
  counters: { entries: number; entries_filled: number; entries_withdrawn: number; target_exits: number; time_stops: number; kill_switches: number; rejects: number };
  latency_us: { median: number; p99: number };
  session_kill_switch: boolean;
  disk_bytes: number;
}

interface Account {
  fillModel: 'standard' | 'hft';
  startingBalance: number;
  equity: number;
  pnl: number;
  cash: number;
  workingOrders: number;
  positions: Array<{ ticker: string; quantity: number; averagePrice: number; mark: number | null }>;
}

interface Loaded {
  dir: string;
  running: boolean;
  killPending: boolean;
  status: StrategyStatus | null;
  latest: string | null;
  account: Account | null;
}

function Figure({ title, value, note, tone = 'text-ink', wrap = false }: { title: string; value: string; note?: string; tone?: string; wrap?: boolean }) {
  return (
    <div className="min-w-0 border-b border-r border-line/60 px-3 py-2">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-faint">{title}</dt>
      <dd className={`num mt-0.5 text-sm ${wrap ? 'leading-snug' : 'truncate'} ${tone}`}>{value}</dd>
      {note ? <dd className="mt-0.5 truncate text-[10px] text-faint">{note}</dd> : null}
    </div>
  );
}

const ms = (microseconds: number) => (microseconds >= 1_000 ? `${(microseconds / 1_000).toFixed(2)} ms` : `${microseconds} µs`);

/** The first lines of a report: its title and the success rate. */
const headline = (report: string) =>
  report
    .split('\n')
    .filter((line) => line.startsWith('# ') || line.startsWith('**Success'))
    .map((line) => line.replace(/^# /, '').replace(/\*\*/g, ''))
    .join(' · ');

/**
 * HFT Strategy, the market maker from Project 1 trading here as a program in
 * a realistic sandbox: whether it is running, its live profit and loss, what
 * it holds, its success rate, and the kill switch. The program is started by
 * hand on this Mac (hftbot); this panel watches it and can stop it.
 */
export function HftStrategyPanel() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setLoaded(await api<Loaded>('/api/hft/strategy'));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 2_000);
    return () => clearInterval(timer);
  }, [reload]);

  async function kill() {
    setConfirming(false);
    try {
      const answer = await api<{ told: boolean; closed: { cancelled: number; closing: number } | null }>('/api/hft/strategy/kill', { method: 'POST' });
      setNotice(
        answer.told
          ? 'Told HFT Strategy to stop: it is withdrawing its orders and closing its positions.'
          : answer.closed
            ? `HFT Strategy was not running, so the exchange cancelled ${shares(answer.closed.cancelled)} orders and is closing ${shares(answer.closed.closing)} positions.`
            : 'HFT Strategy is not running, and it has no account to close.',
      );
      void reload();
    } catch (err) {
      setNotice(errorMessage(err));
    }
  }

  if (error) return <p className="px-3 py-3 text-xs text-down">{error}</p>;
  if (!loaded) return <p className="px-3 py-3 text-xs text-faint">Loading…</p>;

  const { status, account } = loaded;
  const summary = status?.summary;
  const state = loaded.running ? (status?.state === 'stopping' ? 'Stopping' : status?.state === 'trading' ? 'Trading' : 'Waiting for the market') : 'Not running';
  const dot = loaded.running ? (status?.state === 'trading' ? 'bg-up' : 'bg-accent') : 'bg-line';
  const pnl = account?.pnl ?? status?.pnl ?? 0;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line/60 px-3 py-2 text-xs">
        <span>
          <span className={`mr-2 inline-block size-1.5 rounded-full align-middle ${dot}`} />
          <span className="font-semibold text-ink">{state}</span>
          {account?.fillModel === 'hft' ? <span className="ml-2 rounded-sm border border-line px-1 py-px text-[10px] font-semibold uppercase tracking-wider text-dim">Realistic sandbox</span> : null}
        </span>
        {status ? (
          <span className="text-[11px] text-dim">
            {status.trader} · since {localMoment(status.started)} · watching {status.symbols_trading} of {status.symbols} symbols
            {!loaded.running && status.reason ? ` · stopped by ${status.reason}` : ''}
          </span>
        ) : (
          <span className="text-[11px] text-dim">It has not run yet.</span>
        )}
        <span className="ml-auto">
          {confirming ? (
            <span className="flex items-center gap-2">
              <span className="text-[11px] text-down">Withdraw every order and close every position?</span>
              <button type="button" onClick={() => void kill()} className="rounded-sm bg-down px-2 py-0.5 text-[11px] font-semibold text-white">
                Yes, stop it
              </button>
              <button type="button" onClick={() => setConfirming(false)} className="text-[11px] text-dim hover:underline">
                No
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={!loaded.running && !(account && (account.positions.length > 0 || account.workingOrders > 0))}
              className="rounded-sm border border-down px-2 py-0.5 text-[11px] font-semibold text-down disabled:cursor-not-allowed disabled:opacity-40"
            >
              Kill switch
            </button>
          )}
        </span>
      </div>
      {notice ? <p className="border-b border-line/60 px-3 py-2 text-[11px] text-dim">{notice}</p> : null}
      {loaded.killPending && loaded.running ? <p className="border-b border-line/60 px-3 py-2 text-[11px] text-down">Kill switch pressed: waiting for HFT Strategy to stop…</p> : null}

      <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        <Figure
          title="Success rate"
          wrap
          value={summary ? summary.success_text : '—'}
          note={summary && summary.trades > 0 ? `likely ${(summary.success_low * 100).toFixed(0)}–${(summary.success_high * 100).toFixed(0)}%` : 'no trades yet'}
        />
        <Figure title="Live P&L" value={signedUsd(pnl)} tone={pnlColor(pnl)} note={account ? `equity ${usd(account.equity)}` : undefined} />
        <Figure title="Per trade" value={summary && summary.trades > 0 ? signedUsd(summary.per_trade) : '—'} note={summary && summary.trades > 1 ? `t = ${summary.t_stat.toFixed(2)}` : undefined} />
        <Figure title="Worst trade" value={summary && summary.trades > 0 ? signedUsd(summary.worst) : '—'} note={summary ? `max drawdown ${usd(summary.max_drawdown)}` : undefined} />
        <Figure
          title="Fill rate"
          value={summary ? `${(summary.fill_rate * 100).toFixed(1)}%` : '—'}
          note={summary ? `adverse ${summary.adverse_1s_cents.toFixed(2)}¢ / ${summary.adverse_5s_cents.toFixed(2)}¢ a share` : undefined}
        />
        <Figure title="Order to report" value={status ? ms(status.latency_us.median) : '—'} note={status ? `99 in 100 under ${ms(status.latency_us.p99)}` : undefined} />
      </dl>

      <div className="grid gap-0 lg:grid-cols-2">
        <div className="border-b border-line/60 px-3 py-2 lg:border-r">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">Inventory{account ? ` · ${shares(account.workingOrders)} orders working` : ''}</p>
          {account && account.positions.length > 0 ? (
            <table className="num w-full text-[11px]">
              <thead>
                <tr className="text-left text-faint">
                  <th className="font-normal">Symbol</th>
                  <th className="text-right font-normal">Shares</th>
                  <th className="text-right font-normal">Average</th>
                  <th className="text-right font-normal">Mark</th>
                </tr>
              </thead>
              <tbody>
                {account.positions.map((position) => (
                  <tr key={position.ticker} className="text-dim">
                    <td className="font-sans text-ink">{position.ticker}</td>
                    <td className={`text-right ${position.quantity < 0 ? 'text-down' : 'text-up'}`}>{shares(position.quantity)}</td>
                    <td className="text-right">{price(position.averagePrice)}</td>
                    <td className="text-right">{price(position.mark)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-[11px] text-faint">Flat: nothing held.</p>
          )}
        </div>
        <div className="border-b border-line/60 px-3 py-2">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">What it did</p>
          {status ? (
            <p className="num text-[11px] leading-relaxed text-dim">
              {shares(status.counters.entries)} entries sent, {shares(status.counters.entries_filled)} filled, {shares(status.counters.entries_withdrawn)} withdrawn ·{' '}
              {shares(status.counters.target_exits)} at target, {shares(status.counters.time_stops)} time stops · {shares(status.counters.rejects)} refused by the gateway
              {status.session_kill_switch ? ' · its session loss limit has stopped it for today' : ''}
            </p>
          ) : (
            <p className="text-[11px] text-faint">—</p>
          )}
          {loaded.latest ? <p className="mt-1 text-[11px] text-faint">Last session: {headline(loaded.latest)}</p> : null}
        </div>
      </div>

      <p className="px-3 py-2 text-[11px] leading-relaxed text-faint">
        HFT Strategy is a program from Project 1 that makes markets in the cheapest listings, in a sandbox competition whose fills HFT decides. It is started by hand on this Mac with <span className="num">hftbot</span>, never
        by itself, and writes its status, its reports and the market it saw to <span className="num break-all">{loaded.dir}</span>
        {status ? ` (${(status.disk_bytes / 1e6).toFixed(1)} MB)` : ''}. Paper trading: no real money.
      </p>
    </div>
  );
}

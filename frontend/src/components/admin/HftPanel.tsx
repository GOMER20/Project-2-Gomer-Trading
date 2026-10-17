'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { duration, shares } from '@/lib/format';

/** How long HFT took over something, in nanoseconds: see hft/src/hft/stats.hpp. */
interface Timing {
  count: number;
  mean_ns: number;
  p50_ns: number;
  p90_ns: number;
  p99_ns: number;
  p999_ns: number;
  max_ns: number;
}

interface HftStats {
  session: number;
  started: string;
  uptime_seconds: number;
  orders: number;
  cancels: number;
  quotes: number;
  quotes_refused: number;
  accepted: number;
  rejected: number;
  cancelled: number;
  cancel_rejected: number;
  trades: number;
  trades_between_clients: number;
  shares: number;
  notional_ticks: number;
  house_rejected: number;
  engine_commands: number;
  events_dropped: number;
  digest: string;
  recording: boolean;
  recording_file: string;
  commands_recorded: number;
  recording_stopped: boolean;
  order_time: Timing;
  quote_time: Timing;
  busiest_second: number;
  resting_client_orders: number;
  resting_house_orders: number;
}

interface HftStatus {
  mode: 'off' | 'test';
  state: 'off' | 'unavailable' | 'starting' | 'running' | 'down';
  detail: string | null;
  since: number;
  restarts: number;
  symbols: string[];
  marketSession: string | null;
  counters: {
    quotesSent: number;
    quotesSkipped: number;
    ordersSent: number;
    cancelsSent: number;
    ordersNotCopied: number;
    accepted: number;
    rejected: number;
    fills: number;
    sharesFilled: number;
    exchangeFills: number;
    exchangeSharesFilled: number;
  };
  dataDir: string;
  disk: { recordLimitMb: number; keepSessions: number; budgetMb: number; usedMb: number; notRecording: boolean };
}

/** A realistic sandbox's own HFT, which decides its fills: see backend/src/hft/hftVenue.ts. */
interface VenueStatus {
  competitionId: string;
  state: 'idle' | 'starting' | 'running' | 'down' | 'unavailable';
  detail: string | null;
  restarts: number;
  workingOrders: number;
  counters: { quotes: number; prints: number; printShares: number; printSharesToTraders: number; orders: number; cancels: number; fills: number; sharesFilled: number; refused: number };
  disk: { budgetMb: number; usedMb: number };
}

/** A time in whichever unit reads best: "740 ns", "12.4 µs", "3.1 ms". */
function span(nanoseconds: number): string {
  if (nanoseconds < 1_000) return `${Math.round(nanoseconds)} ns`;
  if (nanoseconds < 1_000_000) return `${(nanoseconds / 1_000).toFixed(1)} µs`;
  if (nanoseconds < 1_000_000_000) return `${(nanoseconds / 1_000_000).toFixed(1)} ms`;
  return `${(nanoseconds / 1_000_000_000).toFixed(2)} s`;
}

/** "1 fill", "2 fills". */
const count = (value: number, one: string, many = `${one}s`) => `${shares(value)} ${value === 1 ? one : many}`;

const STATE: Record<HftStatus['state'], { text: string; dot: string }> = {
  running: { text: 'Running', dot: 'bg-up' },
  starting: { text: 'Starting', dot: 'bg-accent' },
  down: { text: 'Down, restarting', dot: 'bg-down' },
  unavailable: { text: 'Not installed', dot: 'bg-line' },
  off: { text: 'Switched off', dot: 'bg-line' },
};

function Figure({ title, value, note }: { title: string; value: string; note?: string }) {
  return (
    <div className="min-w-0 border-b border-r border-line/60 px-3 py-2">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-faint">{title}</dt>
      <dd className="num mt-0.5 truncate text-sm text-ink">{value}</dd>
      {note ? <dd className="mt-0.5 truncate text-[10px] text-faint">{note}</dd> : null}
    </div>
  );
}

/**
 * HFT, the order book engine running beside the exchange in test mode: whether
 * it is up, what it has been sent, what it did with it, and how fast.
 */
export function HftPanel() {
  const [status, setStatus] = useState<HftStatus | null>(null);
  const [stats, setStats] = useState<HftStats | null>(null);
  const [venues, setVenues] = useState<VenueStatus[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const loaded = await api<{ status: HftStatus; stats: HftStats | null; venues?: VenueStatus[] }>('/api/hft');
      setStatus(loaded.status);
      setStats(loaded.stats);
      setVenues(loaded.venues ?? []);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 3_000);
    return () => clearInterval(timer);
  }, [reload]);

  if (error) return <p className="px-3 py-3 text-xs text-down">{error}</p>;
  if (!status) return <p className="px-3 py-3 text-xs text-faint">Loading…</p>;

  const state = STATE[status.state];
  const counters = status.counters;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line/60 px-3 py-2 text-xs">
        <span>
          <span className={`mr-2 inline-block size-1.5 rounded-full align-middle ${state.dot}`} />
          <span className="font-semibold text-ink">{state.text}</span>
          {status.mode === 'test' ? <span className="ml-2 rounded-sm border border-line px-1 py-px text-[10px] font-semibold uppercase tracking-wider text-dim">Test mode</span> : null}
        </span>
        {status.state === 'running' && stats ? (
          <span className="text-[11px] text-dim">
            for {duration(stats.uptime_seconds * 1000)} · {status.symbols.length} symbols · {status.marketSession ? `market session of ${status.marketSession}` : 'started while the market was shut'}
            {status.restarts > 0 ? ` · restarted ${status.restarts} time${status.restarts === 1 ? '' : 's'}` : ''}
          </span>
        ) : status.detail ? (
          <span className="text-[11px] text-dim">{status.detail}</span>
        ) : null}
      </div>

      <p className="border-b border-line/60 px-3 py-2 text-[11px] leading-relaxed text-faint">
        HFT is the order book matching engine. In test mode it is sent a copy of every price and every order, matches them in a real order book of its own, and measures itself. What traders are filled at
        still comes from the exchange&apos;s own engine, so nothing here can affect an account.
      </p>

      {stats ? (
        <>
          <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
            <Figure title="Orders" value={shares(stats.orders)} note={count(stats.cancels, 'cancel')} />
            <Figure title="Trades" value={shares(stats.trades)} note={`${shares(stats.trades_between_clients)} between traders`} />
            <Figure title="Shares traded" value={shares(stats.shares)} />
            <Figure title="Price updates" value={shares(stats.quotes)} note={`${shares(stats.engine_commands)} book changes`} />
            <Figure title="Resting now" value={shares(stats.resting_client_orders)} note={`and ${shares(stats.resting_house_orders)} of the house's`} />
            <Figure title="Busiest second" value={shares(stats.busiest_second)} note="messages" />
          </dl>
          <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
            <Figure title="Time per order" value={stats.order_time.count ? span(stats.order_time.p50_ns) : '—'} note="typical" />
            <Figure title="99 in 100 under" value={stats.order_time.count ? span(stats.order_time.p99_ns) : '—'} />
            <Figure title="999 in 1,000 under" value={stats.order_time.count ? span(stats.order_time.p999_ns) : '—'} />
            <Figure title="Slowest order" value={stats.order_time.count ? span(stats.order_time.max_ns) : '—'} />
            <Figure title="Per price update" value={stats.quote_time.count ? span(stats.quote_time.p50_ns) : '—'} note="typical" />
            <Figure
              title="Refused or lost"
              value={shares(stats.rejected + stats.events_dropped + stats.house_rejected + stats.quotes_refused)}
              note={stats.events_dropped === 0 ? 'nothing lost' : `${shares(stats.events_dropped)} events lost`}
            />
          </dl>
        </>
      ) : null}

      <dl className="num grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 px-3 py-2 text-[11px] text-dim">
        <dt className="font-sans text-faint">Copied to HFT</dt>
        <dd>
          {count(counters.ordersSent, 'order')}, {count(counters.cancelsSent, 'cancel')}, {count(counters.quotesSent, 'price update')}
          {counters.ordersNotCopied > 0 ? <span className="font-sans text-faint"> ({count(counters.ordersNotCopied, 'order')} left out: no book for the symbol, or placed before this session began)</span> : null}
        </dd>
        <dt className="font-sans text-faint">Filled by the exchange</dt>
        <dd>
          {count(counters.exchangeSharesFilled, 'share')} in {count(counters.exchangeFills, 'fill')}
        </dd>
        <dt className="font-sans text-faint">Filled by HFT</dt>
        <dd>
          {count(counters.sharesFilled, 'share')} in {count(counters.fills, 'fill')} <span className="font-sans text-faint">(its own book, so the two need not agree)</span>
        </dd>
        {stats ? (
          <>
            <dt className="font-sans text-faint">Recording</dt>
            <dd className="break-all">
              {stats.recording ? count(stats.commands_recorded, 'command') : 'off'}
              {stats.recording_stopped ? <span className="font-sans text-faint"> (reached its size limit; the session goes on unrecorded)</span> : null}
            </dd>
            <dt className="font-sans text-faint">Fingerprint</dt>
            <dd>
              {stats.digest} <span className="font-sans text-faint">(a replay of the recording must arrive at the same one)</span>
            </dd>
          </>
        ) : null}
        <dt className="font-sans text-faint">Disk</dt>
        <dd>
          {status.disk.usedMb} MB used, of {status.disk.budgetMb} MB at most{' '}
          <span className="font-sans text-faint">
            ({status.disk.recordLimitMb} MB a session, {status.disk.keepSessions} sessions kept
            {status.disk.notRecording ? '; this session is not being recorded because the disk is nearly full' : ''})
          </span>
        </dd>
        <dt className="font-sans text-faint">Files</dt>
        <dd className="break-all">{status.dataDir}</dd>
        {venues.map((venue) => (
          <Fragment key={venue.competitionId}>
            <dt className="font-sans text-faint">Realistic sandbox</dt>
            <dd>
              <span className="font-sans">{venue.state === 'running' ? 'deciding fills' : venue.state}</span> · {count(venue.workingOrders, 'order')} working · {count(venue.counters.sharesFilled, 'share')} filled in{' '}
              {count(venue.counters.fills, 'fill')} · {count(venue.counters.prints, 'market trade')} sent to the queue ({count(venue.counters.printSharesToTraders, 'share')} reached traders) · {venue.disk.usedMb} of {venue.disk.budgetMb} MB
              {venue.detail ? <span className="font-sans text-faint"> ({venue.detail})</span> : null}
            </dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

'use client';

import { useMemo } from 'react';
import { HftPanel } from '@/components/admin/HftPanel';
import { EmptyState, Panel } from '@/components/ui/Panel';
import { dateTime, duration, shares } from '@/lib/format';
import { span, usePoll, type HftStats, type HftStatusLite } from '@/lib/labs';
import { Tile, WindowHeader } from './AtWindow';
import { TwoLineChart } from './LabChart';

/**
 * HFT's own window: the order book engine. The live panel is the one in the
 * admin console; below it, every session HFT has finished, so its speed and
 * reliability can be compared from one day to the next.
 */

const th = 'px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wider text-faint';
const td = 'num px-2 py-1 text-[11px] text-ink';

interface PastSession {
  name: string;
  stats: HftStats;
}

/** "hft-session-20261013-133149-1" -> its start, from the stats or the name. */
const startOf = (session: PastSession) => {
  const fromStats = Date.parse(session.stats.started);
  if (Number.isFinite(fromStats)) return fromStats;
  const m = /(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(session.name);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : 0;
};
const lost = (s: HftStats) => s.rejected + s.events_dropped + s.house_rejected + s.quotes_refused;

export function HftWindow() {
  const live = usePoll<{ status: HftStatusLite; stats: HftStats | null }>('/api/hft', 3_000);
  const past = usePoll<{ sessions: PastSession[] }>('/api/hft/sessions', 30_000);
  const sessions = useMemo(() => [...(past.data?.sessions ?? [])].sort((a, b) => startOf(b) - startOf(a)), [past.data]);
  const timed = useMemo(() => sessions.filter((s) => s.stats.order_time?.count > 0).reverse(), [sessions]);
  const totals = sessions.reduce((sum, s) => ({ orders: sum.orders + s.stats.orders, trades: sum.trades + s.stats.trades, shares: sum.shares + s.stats.shares, lost: sum.lost + lost(s.stats) }), { orders: 0, trades: 0, shares: 0, lost: 0 });
  const typical = useMemo(() => ({ name: 'Typical order', points: timed.map((s) => ({ time: startOf(s) / 1000, value: s.stats.order_time.p50_ns })) }), [timed]);
  const slow = useMemo(() => ({ name: '99 in 100 under', points: timed.map((s) => ({ time: startOf(s) / 1000, value: s.stats.order_time.p99_ns })) }), [timed]);

  const state = live.data?.status.state;
  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <WindowHeader
        title="High-frequency trading · HFT"
        subtitle="HFT is the order book matching engine (Project 1, written in C++), running beside Gomer Trading's exchange. It updates every few seconds."
        right={
          <span className="flex items-center gap-1.5 rounded-sm border border-line px-2 py-1">
            <span className={`size-1.5 rounded-full ${state === 'running' ? 'bg-up' : state === 'starting' || state === 'down' ? 'bg-accent' : 'bg-faint'}`} />
            {state ? { running: 'Running', starting: 'Starting', down: 'Down, restarting', unavailable: 'Not installed', off: 'Switched off' }[state] : 'Loading…'}
            {live.data?.status.mode === 'test' ? ' · test mode' : ''}
          </span>
        }
      />

      <main className="flex flex-col gap-1 p-1">
        <section className="grid grid-cols-2 gap-1 md:grid-cols-4">
          <Tile title="Sessions recorded" value={shares(sessions.length)} note="a new one starts at each US market open" />
          <Tile title="Orders matched" value={shares(totals.orders)} note={`${shares(totals.trades)} trades, ${shares(totals.shares)} shares`} />
          <Tile
            title="Fastest typical order"
            value={timed.length ? span(Math.min(...timed.map((s) => s.stats.order_time.p50_ns))) : '—'}
            note={timed.length ? `slowest typical ${span(Math.max(...timed.map((s) => s.stats.order_time.p50_ns)))}` : 'no timed orders yet'}
          />
          <Tile title="Refused or lost" value={shares(totals.lost)} note="across every recorded session" tone={totals.lost ? 'text-accent' : 'text-up'} />
        </section>

        <Panel title="Now">
          <HftPanel />
        </Panel>

        <div className="grid gap-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Panel title="Time per order, session by session" className="h-80">
            {timed.length ? <TwoLineChart first={typical} second={slow} format={span} /> : <EmptyState>Appears once a session with orders has finished.</EmptyState>}
          </Panel>
          <Panel title="What the numbers mean" className="h-80">
            <dl className="space-y-2 overflow-auto p-3 text-[11px] leading-relaxed text-dim">
              <div>
                <dt className="font-semibold text-ink">Time per order</dt>
                <dd>How long HFT takes to match one order in its book, measured inside the engine. “Typical” is the median; “99 in 100 under” means only 1 order in 100 took longer.</dd>
              </div>
              <div>
                <dt className="font-semibold text-ink">Test mode</dt>
                <dd>HFT is sent a copy of every price and order and matches them in a book of its own. What traders are filled at still comes from the exchange&apos;s engine, so nothing here can affect an account.</dd>
              </div>
              <div>
                <dt className="font-semibold text-ink">Fingerprint</dt>
                <dd>Each session is recorded. Replaying the recording must arrive at the same fingerprint, which proves the engine is deterministic.</dd>
              </div>
              <div>
                <dt className="font-semibold text-ink">Refused or lost</dt>
                <dd>Orders HFT refused and events it could not deliver. Zero is the goal.</dd>
              </div>
            </dl>
          </Panel>
        </div>

        <Panel title={`Sessions, newest first (${sessions.length})`}>
          {!sessions.length ? (
            <EmptyState>{past.error ?? 'No finished sessions yet.'}</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={th}>Started</th>
                    <th className={`${th} text-right`}>Ran for</th>
                    <th className={`${th} text-right`}>Orders</th>
                    <th className={`${th} text-right`}>Trades</th>
                    <th className={`${th} text-right`}>Shares</th>
                    <th className={`${th} text-right`}>Price updates</th>
                    <th className={`${th} text-right`}>Typical order</th>
                    <th className={`${th} text-right`}>99 in 100 under</th>
                    <th className={`${th} text-right`}>Slowest</th>
                    <th className={`${th} text-right`}>Busiest second</th>
                    <th className={`${th} text-right`}>Refused or lost</th>
                    <th className={th}>Fingerprint</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => {
                    const t = s.stats.order_time;
                    return (
                      <tr key={s.name} className="border-t border-line/50">
                        <td className={td}>{dateTime(new Date(startOf(s)).toISOString())}</td>
                        <td className={`${td} text-right text-dim`}>
                          {live.data?.stats?.started === s.stats.started ? <span className="font-sans text-up">running now · </span> : null}
                          {duration(s.stats.uptime_seconds * 1000)}
                        </td>
                        <td className={`${td} text-right`}>{shares(s.stats.orders)}</td>
                        <td className={`${td} text-right`}>{shares(s.stats.trades)}</td>
                        <td className={`${td} text-right`}>{shares(s.stats.shares)}</td>
                        <td className={`${td} text-right text-dim`}>{shares(s.stats.quotes)}</td>
                        <td className={`${td} text-right`}>{t?.count ? span(t.p50_ns) : '—'}</td>
                        <td className={`${td} text-right`}>{t?.count ? span(t.p99_ns) : '—'}</td>
                        <td className={`${td} text-right text-dim`}>{t?.count ? span(t.max_ns) : '—'}</td>
                        <td className={`${td} text-right text-dim`}>{shares(s.stats.busiest_second)}</td>
                        <td className={`${td} text-right ${lost(s.stats) ? 'text-accent' : 'text-up'}`}>{shares(lost(s.stats))}</td>
                        <td className={`${td} max-w-40 truncate text-faint`} title={s.stats.digest}>
                          {s.stats.digest}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </main>
    </div>
  );
}

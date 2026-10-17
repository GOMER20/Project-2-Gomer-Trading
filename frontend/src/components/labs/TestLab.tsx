'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { DesktopBridge } from '@/lib/desktop';
import { pnlColor, shares, signedUsd } from '@/lib/format';
import { openLabWindow, percent, span, usePoll, type AtDashboard, type HftStats, type HftStatusLite, type LabWindow } from '@/lib/labs';

/**
 * The Test Lab, beside the sign-in boxes on the opening screen of the desktop
 * app: a box for AT (the trading algorithm) level with the first of them and a
 * box for HFT (the order book engine) level with the second, each with a few
 * live figures and a button that opens its window.
 *
 * Only the desktop app shows it, to the person at this Mac. Its figures are
 * read with the app's own sign-in for its owner, held here in memory: nothing
 * is signed in until a button is used.
 */

function Figure({ title, value, tone = 'text-ink' }: { title: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-faint">{title}</dt>
      <dd className={`num truncate text-sm ${tone}`}>{value}</dd>
    </div>
  );
}

function Box({ name, title, about, status, children }: { name: LabWindow; title: string; about: string; status: ReactNode; children: ReactNode }) {
  return (
    <section className="flex h-full flex-col rounded-sm border border-line bg-panel p-5">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink">{title}</h2>
      <p className="mt-1 text-[11px] leading-relaxed text-dim">{about}</p>
      <div className="mt-3 text-[11px] text-dim">{status}</div>
      <div className="mt-3 flex-1">{children}</div>
      <button
        type="button"
        onClick={() => openLabWindow(name)}
        className="mt-4 h-10 w-full rounded-sm border border-accent/70 bg-accent/10 text-sm font-semibold text-accent transition hover:bg-accent/20"
      >
        Open {name.toUpperCase()} window ↗
      </button>
    </section>
  );
}

function Dot({ on }: { on: 'up' | 'wait' | 'off' }) {
  return <span className={`mr-1.5 inline-block size-1.5 rounded-full align-middle ${on === 'up' ? 'bg-up' : on === 'wait' ? 'bg-accent' : 'bg-faint'}`} />;
}

function AtBox({ token }: { token: string | null }) {
  const { data, error } = usePoll<AtDashboard>('/api/at?brief=1', 10_000, token);
  const totals = data?.accounts.reduce((sum, a) => ({ trades: sum.trades + a.summary.trades, wins: sum.wins + a.summary.wins, pnl: sum.pnl + a.summary.netPnl }), { trades: 0, wins: 0, pnl: 0 });
  const connected = data?.accounts.some((a) => a.connection.connected);
  const session = data?.accounts[0]?.thisSession;

  return (
    <Box
      name="at"
      title="Algorithmic Trading · AT"
      about="The trading algorithm (Project 3). It trades here on its own through the bot gateway; see its success rate, every trade and its reports."
      status={
        !data ? (
          (error ?? 'Loading…')
        ) : !data.found ? (
          'Not set up on this exchange yet.'
        ) : (
          <>
            <Dot on={connected ? 'up' : 'off'} />
            {connected ? 'Connected and trading now' : 'Not connected right now'}
          </>
        )
      }
    >
      {data?.found && totals ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
          <div className="col-span-2">
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-faint">Success rate</dt>
            <dd className="num text-2xl leading-tight text-ink">{totals.trades ? percent(totals.wins / totals.trades) : '—'}</dd>
            <dd className="text-[10px] text-faint">{totals.trades ? `${shares(totals.wins)} of ${shares(totals.trades)} trades won` : 'no finished trades yet'}</dd>
          </div>
          <Figure title="Net result" value={signedUsd(totals.pnl)} tone={pnlColor(totals.pnl)} />
          <Figure title={session ? `Session ${session.session.slice(5)}` : 'This session'} value={session?.trades ? `${percent(session.winRate)} · ${session.trades}` : '—'} />
        </dl>
      ) : null}
    </Box>
  );
}

const HFT_STATE: Record<HftStatusLite['state'], { text: string; on: 'up' | 'wait' | 'off' }> = {
  running: { text: 'Running', on: 'up' },
  starting: { text: 'Starting', on: 'wait' },
  down: { text: 'Down, restarting', on: 'wait' },
  unavailable: { text: 'Not installed', on: 'off' },
  off: { text: 'Switched off', on: 'off' },
};

function HftBox({ token }: { token: string | null }) {
  const { data, error } = usePoll<{ status: HftStatusLite; stats: HftStats | null }>('/api/hft', 5_000, token);
  const stats = data?.stats;
  const timed = Boolean(stats && stats.order_time.count > 0);

  return (
    <Box
      name="hft"
      title="High-Frequency Trading · HFT"
      about="The order book engine (Project 1, C++), running beside the exchange in test mode; see how fast it matches every order, session by session."
      status={
        !data ? (
          (error ?? 'Loading…')
        ) : (
          <>
            <Dot on={HFT_STATE[data.status.state].on} />
            {HFT_STATE[data.status.state].text}
            {data.status.mode === 'test' ? ' · test mode' : ''}
          </>
        )
      }
    >
      {stats ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
          <div className="col-span-2">
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-faint">Time per order</dt>
            <dd className="num text-2xl leading-tight text-ink">{timed ? span(stats.order_time.p50_ns) : '—'}</dd>
            <dd className="text-[10px] text-faint">{timed ? `typical; 99 in 100 under ${span(stats.order_time.p99_ns)}` : 'no orders this session yet'}</dd>
          </div>
          <Figure title="Orders" value={shares(stats.orders)} />
          <Figure title="Trades" value={shares(stats.trades)} />
        </dl>
      ) : null}
    </Box>
  );
}

/** The desktop app's sign-in for its owner, held in memory only, so the Test Lab can show live figures before anyone signs in. */
export function useOwnerToken(desktop: DesktopBridge | undefined): string | null {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    desktop
      .signIn('trader')
      .then((session) => !cancelled && setToken(session.token))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [desktop]);
  return token;
}

export function TestLabHeader() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex size-9 items-center justify-center rounded-sm border border-accent text-[13px] font-black tracking-tighter text-accent">LAB</span>
      <div>
        <h1 className="text-base font-semibold tracking-wide text-ink">TEST LAB</h1>
        <p className="text-xs text-dim">Run tests: algorithmic and high-frequency trading</p>
      </div>
    </div>
  );
}

export { AtBox, HftBox };

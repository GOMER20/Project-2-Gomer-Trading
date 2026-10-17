'use client';

import Link from 'next/link';
import { useState } from 'react';
import { duration, localMoment, markOf, newYorkMoment, pnlColor, signedPct, signedUsd, timeRemaining, usd } from '@/lib/format';
import { desktopBridge } from '@/lib/desktop';
import { useHydrated, useNow } from '@/lib/hooks';
import type { Competition, MarketHours, Portfolio, Quote } from '@/lib/types';
import { useAuthStore } from '@/store/auth';
import { useMarketStore, type FeedStatus } from '@/store/market';
import { useTradingStore } from '@/store/trading';
import { useUiStore } from '@/store/ui';
import { openLabWindow } from '@/lib/labs';
import { PasswordDialog } from './PasswordDialog';

/** Net asset value from the last server snapshot, re-marked with the live quotes. */
function liveEquity(portfolio: Portfolio | null, quotes: Record<string, Quote>): number | null {
  if (!portfolio) return null;
  let equity = portfolio.cash;
  for (const position of portfolio.positions) {
    equity += position.quantity * (markOf(quotes[position.ticker]) ?? position.currentPrice);
  }
  return Math.round(equity * 100) / 100;
}

/** Equity as a percentage of gross exposure, from the live quotes. Null with nothing held. */
function liveMarginPct(portfolio: Portfolio | null, quotes: Record<string, Quote>): number | null {
  if (!portfolio || portfolio.positions.length === 0) return null;
  let equity = portfolio.cash;
  let exposure = 0;
  for (const position of portfolio.positions) {
    const mark = markOf(quotes[position.ticker]) ?? position.currentPrice;
    equity += position.quantity * mark;
    exposure += Math.abs(position.quantity) * mark;
  }
  return exposure > 0 ? Math.round((equity / exposure) * 1000) / 10 : null;
}

function Stat({ label, value, tone = 'text-ink', sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div className="flex shrink-0 flex-col justify-center px-3">
      <span className="text-[10px] font-medium uppercase tracking-wider text-faint">{label}</span>
      <span className={`num whitespace-nowrap text-[13px] font-semibold leading-tight ${tone}`}>
        {value}
        {sub ? <span className="ml-1.5 text-[11px] font-normal">{sub}</span> : null}
      </span>
    </div>
  );
}

const FEED: Record<FeedStatus, { label: string; dot: string }> = {
  live: { label: 'Live', dot: 'bg-up' },
  connecting: { label: 'Connecting', dot: 'bg-accent animate-pulse' },
  reconnecting: { label: 'Reconnecting', dot: 'bg-accent animate-pulse' },
  offline: { label: 'Offline', dot: 'bg-down' },
};

/** Quotes older than this, on every symbol at once, mean the exchange is not trading. */
const MARKET_CLOSED_AFTER_MS = 3 * 60_000;

function newestQuoteAge(quotes: Record<string, Quote>): number | null {
  let newest = 0;
  for (const symbol in quotes) newest = Math.max(newest, quotes[symbol]!.ts);
  return newest > 0 ? Date.now() - newest : null;
}

const BADGE = {
  simulated: 'border-accent/50 text-accent',
  live: 'border-up/50 text-up',
  quiet: 'border-line text-dim',
  problem: 'border-down/60 text-down',
} as const;

/** Connection to our server, plus what kind of prices are on screen and whether they are moving. */
function FeedBadge() {
  const status = useMarketStore((s) => s.status);
  const provider = useMarketStore((s) => s.provider);
  const health = useMarketStore((s) => s.feed);
  // A boolean selector: re-renders when the market flips between trading and not, not on every tick.
  const closed = useMarketStore((s) => (newestQuoteAge(s.quotes) ?? 0) > MARKET_CLOSED_AFTER_MS);
  useNow(15_000); // quotes stop arriving when the market closes, so time has to drive the re-check
  const desktop = useHydrated() ? desktopBridge() : undefined;
  const connection = FEED[status];
  const hours = useMarketStore((s) => s.hours);

  let badge: { label: string; tone: keyof typeof BADGE; title: string } | null = null;
  if (provider === 'simulated' && health?.state === 'closed') {
    const next = hours ? currentSession(hours, Date.now()).session : null;
    badge = {
      label: 'Market closed',
      tone: 'quiet',
      title: [
        `The practice market keeps US stock exchange hours and is closed now${next ? `. It opens at ${localMoment(next.opensAt)} your time` : ''}.`,
        'Prices are from the last close. Market orders are unavailable until it opens; limit and stop orders will wait.',
        desktop ? 'Click to change its hours or connect real-time prices.' : '',
      ]
        .filter(Boolean)
        .join(' '),
    };
  } else if (provider === 'simulated') {
    badge = {
      label: 'Simulated market',
      tone: 'simulated',
      title: desktop
        ? "These prices come from Gomer Trading's own practice market, not a real exchange. Click to change its hours or connect real-time prices."
        : "These prices come from Gomer Trading's own practice market, not a real exchange. Add a market-data key to .env for real-time prices.",
    };
  } else if (provider) {
    if (health?.state === 'error') badge = { label: 'Price feed problem', tone: 'problem', title: health.detail ?? 'The live price feed is not working.' };
    else if (health?.state === 'connecting') badge = { label: 'Connecting to prices', tone: 'quiet', title: 'Connecting to the live price feed.' };
    else if (closed) badge = { label: 'Market closed', tone: 'quiet', title: 'Showing the last prices from the most recent session. Market orders are unavailable until the market opens; limit orders will wait.' };
    else badge = { label: 'Real-time prices', tone: 'live', title: 'Live exchange quotes through your market-data key.' };
  }

  const className = `rounded-xs border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider ${badge ? BADGE[badge.tone] : ''}`;
  return (
    <div className="flex items-center gap-2">
      <span className="flex items-center gap-1.5 text-[11px] text-dim">
        <span className={`size-1.5 rounded-full ${connection.dot}`} />
        {connection.label}
      </span>
      {badge && desktop ? (
        <button type="button" title={badge.title} onClick={() => desktop.openMarketData()} className={`${className} hover:brightness-125`}>
          {badge.label}
        </button>
      ) : badge ? (
        <span title={badge.title} className={className}>
          {badge.label}
        </span>
      ) : null}
    </div>
  );
}

/** The session in progress or the next one, worked out against the clock so it stays right between refreshes. */
export function currentSession(hours: MarketHours, now: number) {
  const session = [hours.session, ...hours.upcoming].find((candidate) => Date.parse(candidate.closesAt) > now) ?? hours.session;
  return { session, open: Date.parse(session.opensAt) <= now };
}

/** When the US stock market opens and closes, in the trader's own time zone. */
function MarketClock() {
  const hours = useMarketStore((s) => s.hours);
  const simulated = useMarketStore((s) => s.provider === 'simulated');
  const now = useNow(30_000);
  if (!hours) return null;

  const { session, open } = currentSession(hours, now);
  const moment = open ? session.closesAt : session.opensAt;
  const early = session.earlyClose ? ' (early close)' : '';
  const title = [
    open
      ? `The US stock market is open. It closes at ${localMoment(session.closesAt, now)} your time (${newYorkMoment(session.closesAt)})${early}, in ${duration(Date.parse(session.closesAt) - now)}.`
      : `The US stock market is closed${hours.holiday ? ` for ${hours.holiday}` : ''}. It opens at ${localMoment(session.opensAt, now)} your time (${newYorkMoment(session.opensAt)}), in ${duration(Date.parse(session.opensAt) - now)}, and closes at ${localMoment(session.closesAt, now)}${early}.`,
    !simulated
      ? 'Real-time prices only move during these hours.'
      : hours.alwaysOpen
        ? 'The practice market you are on now is set to run around the clock; these hours apply once it keeps exchange hours or real-time prices are connected.'
        : 'The practice market you are on keeps these hours, like the real exchanges.',
  ].join(' ');

  return (
    <span title={title} className="hidden items-center gap-1.5 whitespace-nowrap text-[11px] text-dim lg:flex">
      <span className={`size-1.5 rounded-full ${open ? 'bg-up' : 'bg-faint'}`} />
      US market {open ? 'open, closes' : 'opens'} <span className="num text-ink">{localMoment(moment, now)}</span>
    </span>
  );
}

function Countdown({ competition }: { competition: Competition }) {
  const now = useNow(1000);
  if (competition.status === 'UPCOMING') return <span className="text-[11px] text-accent">Starts {new Date(competition.startDate).toLocaleString()}</span>;
  return <span className="num text-[11px] text-dim">{timeRemaining(competition.endDate, now)}</span>;
}

export function TopBar({ competition }: { competition: Competition | undefined }) {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [changingPassword, setChangingPassword] = useState(false);
  const competitions = useTradingStore((s) => s.competitions);
  const portfolio = useTradingStore((s) => s.portfolio);
  const setCompetition = useUiStore((s) => s.setCompetition);
  // A primitive selector: the bar re-renders only when the computed equity actually changes.
  const equity = useMarketStore((s) => liveEquity(portfolio, s.quotes));

  const marginPct = useMarketStore((s) => liveMarginPct(portfolio, s.quotes));
  const callAt = (portfolio?.maintenanceMargin ?? 0) * 100;
  // Only worth showing when the account borrows or is short: otherwise it sits at 100% and can never be called.
  const showMargin = marginPct !== null && callAt > 0 && marginPct < 99.5;

  const enrolled = competitions.filter((c) => c.enrolled);
  const totalPnl = equity !== null && portfolio ? equity - portfolio.startingBalance : null;
  const returnPct = totalPnl !== null && portfolio ? (totalPnl / portfolio.startingBalance) * 100 : null;
  const unrealized = equity !== null && portfolio ? equity - portfolio.cash - portfolio.positions.reduce((sum, p) => sum + p.averagePrice * p.quantity, 0) : null;

  return (
    <header className="flex shrink-0 flex-wrap items-stretch border-b border-line bg-panel">
      <div className="flex h-12 items-center gap-2.5 border-r border-line px-3">
        <span className="flex size-7 items-center justify-center rounded-sm bg-accent text-[11px] font-black tracking-tighter text-surface">GT</span>
        {/* Stacked so the name costs no more width than one word. */}
        <span className="flex flex-col gap-0.5 leading-none">
          <span className="text-[11px] font-bold tracking-[0.2em] text-ink">GOMER</span>
          <span className="text-[9px] font-semibold tracking-[0.24em] text-dim">TRADING</span>
        </span>
      </div>

      <div className="flex h-12 min-w-0 items-center gap-2.5 border-r border-line px-3">
        {enrolled.length > 0 ? (
          <select
            aria-label="Competition"
            value={competition?.id ?? ''}
            onChange={(e) => setCompetition(e.target.value)}
            className="h-7 max-w-56 truncate rounded-sm border border-line bg-surface px-2 text-xs text-ink focus:border-info focus:outline-none"
          >
            {enrolled.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.status === 'ACTIVE' ? '' : ` (${c.status.toLowerCase()})`}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-xs text-dim">No competition</span>
        )}
        {competition ? <Countdown competition={competition} /> : null}
      </div>

      {/* Own row below xl so the figures never get squeezed; scrolls sideways on phones. */}
      <div className="order-last flex h-12 basis-full items-stretch divide-x divide-line overflow-x-auto border-t border-line xl:order-none xl:flex-1 xl:basis-0 xl:border-t-0">
        <Stat label="Total equity" value={equity === null ? '—' : usd(equity)} />
        <Stat
          label="Total P&L"
          value={totalPnl === null ? '—' : signedUsd(totalPnl)}
          sub={returnPct === null ? undefined : signedPct(returnPct)}
          tone={pnlColor(totalPnl ?? 0)}
        />
        <Stat label="Unrealized" value={unrealized === null ? '—' : signedUsd(unrealized)} tone={pnlColor(Math.round((unrealized ?? 0) * 100) / 100)} />
        <Stat label="Realized" value={portfolio ? signedUsd(portfolio.realizedPnl) : '—'} tone={pnlColor(portfolio?.realizedPnl ?? 0)} />
        <Stat label="Cash" value={portfolio ? usd(portfolio.cash) : '—'} />
        <Stat label="Buying power" value={portfolio ? usd(portfolio.buyingPower) : '—'} tone="text-info" />
        {showMargin ? (
          <span title={`Your equity as a share of everything you hold. If it falls below ${callAt.toFixed(0)}% your working orders are cancelled and your positions are closed at the market.`}>
            <Stat
              label="Margin"
              value={`${marginPct.toFixed(0)}%`}
              sub={`call at ${callAt.toFixed(0)}%`}
              tone={marginPct < callAt * 1.15 ? 'text-down' : marginPct < callAt * 1.5 ? 'text-accent' : 'text-ink'}
            />
          </span>
        ) : null}
      </div>
      {showMargin && marginPct < callAt * 1.15 ? (
        <div role="alert" className="order-last w-full border-t border-down/40 bg-down/10 px-3 py-1 text-xs text-down">
          Margin warning: your equity is {marginPct.toFixed(1)}% of your positions. Below {callAt.toFixed(0)}% everything is closed at the market. Reduce a position to move away from it.
        </div>
      ) : null}

      <div className="ml-auto flex h-12 items-center gap-3 border-l border-line px-3">
        <MarketClock />
        <FeedBadge />
        <span className="num text-xs font-semibold text-ink" title={user?.displayName}>
          {user?.traderId}
        </span>
        {user?.owner ? (
          // The AT and HFT windows, also in the opening screen's Test Lab and the app's Trading menu.
          <span className="flex items-center gap-2">
            <button type="button" onClick={() => openLabWindow('at')} title="Open the algorithmic trading (AT) window" className="text-xs text-accent hover:underline">
              AT ↗
            </button>
            <button type="button" onClick={() => openLabWindow('hft')} title="Open the high-frequency trading (HFT) window" className="text-xs text-accent hover:underline">
              HFT ↗
            </button>
          </span>
        ) : null}
        {user?.role === 'ADMIN' ? (
          <Link href="/admin" className="text-xs text-info hover:underline">
            Admin
          </Link>
        ) : null}
        <button type="button" onClick={() => setChangingPassword(true)} title="Change your password" className="text-[11px] text-dim hover:text-ink">
          Password
        </button>
        <button type="button" onClick={logout} className="rounded-sm border border-line px-2 py-1 text-[11px] text-dim hover:border-down hover:text-down">
          Log out
        </button>
      </div>
      {changingPassword ? <PasswordDialog onClose={() => setChangingPassword(false)} /> : null}
    </header>
  );
}

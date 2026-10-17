'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { signedPct } from '@/lib/format';
import type { MarketHours } from '@/lib/types';
import { desktopBridge } from '@/lib/desktop';
import { socket, useQuoteSubscription } from '@/lib/socket';
import { useAuthStore } from '@/store/auth';
import { useMarketStore } from '@/store/market';
import { useTradingStore } from '@/store/trading';
import { useUiStore } from '@/store/ui';
import { Blotter } from './Blotter';
import { ChartPanel } from './ChartPanel';
import { DepthLadder } from './DepthLadder';
import { PriceAlertWatcher, useAlertSymbols } from './Alerts';
import { Leaderboard } from './Leaderboard';
import { ResultsDialog, winnerNames } from './ResultsDialog';
import { Tape } from './Tape';
import { OrderTicket } from './OrderTicket';
import { Toasts } from './Toasts';
import { TopBar } from './TopBar';
import { Watchlist } from './Watchlist';

const PORTFOLIO_REFRESH_MS = 5_000;
const LEADERBOARD_REFRESH_MS = 10_000;

/** Holds one symbol's quote subscription for as long as it is mounted. */
function Subscription({ symbol }: { symbol: string }) {
  useQuoteSubscription([symbol]);
  return null;
}

/**
 * The trading workspace.
 *
 *   ┌──────────────────────────── account bar ────────────────────────────┐
 *   │ watchlist │ chart                               │ order ticket      │
 *   │           ├─────────────────────────────────────┼───────────────────┤
 *   │           │ positions / orders                  │ leaderboard       │
 *   └───────────┴─────────────────────────────────────┴───────────────────┘
 */
/** Under the watchlist: the Level 2 book, or the tape of trades, for the symbol on screen. */
function MarketPanel() {
  const panel = useUiStore((s) => s.marketPanel);
  const setPanel = useUiStore((s) => s.setMarketPanel);
  const tab = (id: 'depth' | 'tape', label: string) => (
    <button
      type="button"
      onClick={() => setPanel(id)}
      aria-pressed={panel === id}
      className={`rounded-xs px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider ${panel === id ? 'bg-accent text-surface' : 'text-dim hover:text-ink'}`}
    >
      {label}
    </button>
  );
  const tabs = (
    <>
      {tab('depth', 'L2')}
      {tab('tape', 'Tape')}
    </>
  );
  return panel === 'tape' ? <Tape actions={tabs} /> : <DepthLadder actions={tabs} />;
}

export function Terminal() {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const competitionId = useUiStore((s) => s.competitionId);
  const symbol = useUiStore((s) => s.symbol);
  const watchlist = useUiStore((s) => s.watchlist);
  const competitions = useTradingStore((s) => s.competitions);
  const competitionsLoaded = useTradingStore((s) => s.competitionsLoaded);
  const positions = useTradingStore((s) => s.portfolio?.positions);
  const feedProblem = useMarketStore((s) => (s.feed?.state === 'error' ? (s.feed.detail ?? 'The live price feed is not working.') : null));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showResults, setShowResults] = useState(false);
  const closeResults = useCallback(() => setShowResults(false), []);
  const winners = useTradingStore((s) => (s.results?.competition.final ? s.results.winners : null));

  const competition = competitions.find((c) => c.id === competitionId && c.enrolled);

  // One WebSocket for the whole session.
  useEffect(() => {
    if (!token) return;
    socket.connect(token);
    return () => socket.disconnect();
  }, [token]);

  useEffect(() => {
    useTradingStore
      .getState()
      .loadCompetitions()
      .then(() => setLoadError(null))
      .catch((err) => setLoadError(errorMessage(err)));
    return () => useTradingStore.getState().reset();
  }, [token]);

  // US market hours, for the clock in the top bar. They change at most twice a day.
  useEffect(() => {
    const refresh = () => void api<MarketHours>('/api/market/hours').then(useMarketStore.getState().setHours).catch(() => undefined);
    refresh();
    const timer = setInterval(refresh, 5 * 60_000);
    return () => clearInterval(timer);
  }, []);

  // A competition starts, ends and becomes final on the server's clock; check in on it regularly.
  useEffect(() => {
    const timer = setInterval(() => void useTradingStore.getState().loadCompetitions().catch(() => undefined), 20_000);
    return () => clearInterval(timer);
  }, []);

  // Once the result is final, fetch it (for the winner banner) and the settled account.
  const isFinal = competition?.final ?? false;
  useEffect(() => {
    if (!competition?.id || !isFinal) return;
    const store = useTradingStore.getState();
    void store.refreshResults(competition.id).catch(() => undefined);
    void store.refreshPortfolio(competition.id).catch(() => undefined);
    void store.refreshOrders(competition.id).catch(() => undefined);
  }, [competition?.id, isFinal]);

  // Everything that belongs to the selected competition.
  const activeId = competition?.id;
  useEffect(() => {
    if (!activeId) return;
    const store = useTradingStore.getState();
    const quiet = () => undefined; // polling retries on its own; a 401 already logs out
    const refreshPortfolio = () => void store.refreshPortfolio(activeId).catch(quiet);
    const refreshLeaderboard = () => void store.refreshLeaderboard(activeId).catch(quiet);

    store.clearAccount();
    refreshPortfolio();
    refreshLeaderboard();
    void store.refreshOrders(activeId).catch(quiet);
    socket.followLeaderboard(activeId);

    // The WebSocket pushes order and leaderboard updates; polling keeps buying
    // power fresh as prices move and covers any missed push.
    const portfolioTimer = setInterval(refreshPortfolio, PORTFOLIO_REFRESH_MS);
    const leaderboardTimer = setInterval(refreshLeaderboard, LEADERBOARD_REFRESH_MS);
    return () => {
      clearInterval(portfolioTimer);
      clearInterval(leaderboardTimer);
      socket.followLeaderboard(null);
    };
  }, [activeId]);

  const alertSymbols = useAlertSymbols();
  // Quotes keep coming for everything on screen, everything held, and everything with a price alert waiting.
  const streamed = [...new Set([...watchlist, symbol, ...(positions?.map((p) => p.ticker) ?? []), ...alertSymbols])];

  return (
    <div className="flex min-h-dvh flex-col bg-surface lg:h-dvh lg:min-h-[640px]">
      {streamed.map((s) => (
        <Subscription key={s} symbol={s} />
      ))}
      <PriceAlertWatcher />
      <TopBar competition={competition} />

      {loadError ? (
        <div role="alert" className="border-b border-down/40 bg-down/10 px-3 py-1.5 text-xs text-down">
          {loadError}
        </div>
      ) : null}
      {feedProblem ? (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 border-b border-down/40 bg-down/10 px-3 py-1.5 text-xs text-down">
          <span>Live prices are not updating. {feedProblem}</span>
          {desktopBridge() ? (
            <button type="button" onClick={() => desktopBridge()?.openMarketData()} className="underline">
              Open Market Data settings
            </button>
          ) : null}
        </div>
      ) : null}
      {competition && isFinal ? (
        <div className="flex flex-wrap items-center gap-x-3 border-b border-accent/40 bg-accent/10 px-3 py-1.5 text-xs text-accent">
          <span>
            <strong className="font-semibold">{competition.name} has ended.</strong>{' '}
            {winners?.length ? `${winners.length > 1 ? 'Winners' : 'Winner'}: ${winnerNames(winners)} (${signedPct(winners[0]!.returnPct)}).` : 'The standings are final.'}
          </span>
          <button type="button" onClick={() => setShowResults(true)} className="font-semibold underline">
            View results
          </button>
        </div>
      ) : null}
      {competitionsLoaded && !competition ? (
        <div className="border-b border-accent/40 bg-accent/10 px-3 py-1.5 text-xs text-accent">
          You are not enrolled in a competition yet, so trading is disabled.{' '}
          {user?.role === 'ADMIN' ? (
            <Link href="/admin" className="underline">
              Create one and enrol traders in the admin console.
            </Link>
          ) : (
            'Ask the administrator to add your Trader ID.'
          )}
        </div>
      ) : null}

      {/* Three fixed columns on desktop; on small screens the panels stack and the page scrolls. */}
      <main className="grid flex-1 grid-cols-1 gap-1 p-1 lg:min-h-0 lg:grid-cols-[230px_minmax(0,1fr)_300px] lg:overflow-hidden">
        <div className="order-3 flex flex-col gap-1 lg:order-none lg:min-h-0">
          <div className="h-80 shrink-0 lg:h-auto lg:min-h-0 lg:flex-[3] lg:shrink">
            <Watchlist />
          </div>
          <div className="h-64 shrink-0 lg:h-auto lg:min-h-0 lg:flex-[2] lg:shrink">
            <MarketPanel />
          </div>
        </div>
        <div className="order-1 flex flex-col gap-1 lg:order-none lg:min-h-0">
          <div className="h-96 shrink-0 lg:h-auto lg:min-h-0 lg:flex-[3] lg:shrink">
            <ChartPanel />
          </div>
          <div className="h-72 shrink-0 lg:h-auto lg:min-h-0 lg:flex-[2] lg:shrink">
            <Blotter competition={competition} />
          </div>
        </div>
        <div className="order-2 flex flex-col gap-1 lg:order-none lg:min-h-0">
          <div className="shrink-0">
            <OrderTicket competition={competition} />
          </div>
          <div className="h-96 shrink-0 lg:h-auto lg:min-h-0 lg:flex-1 lg:shrink">
            <Leaderboard active={Boolean(competition)} final={isFinal} onShowResults={() => setShowResults(true)} />
          </div>
        </div>
      </main>
      {showResults && competition ? <ResultsDialog competitionId={competition.id} onClose={closeResults} /> : null}
      <Toasts />
    </div>
  );
}

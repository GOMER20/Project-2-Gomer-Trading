'use client';

import { useEffect } from 'react';
import { dateTime, pnlColor, signedPct, signedUsd, usd } from '@/lib/format';
import type { Standing } from '@/lib/types';
import { useAuthStore } from '@/store/auth';
import { useTradingStore } from '@/store/trading';

const th = 'whitespace-nowrap px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-wider text-faint';
const td = 'num whitespace-nowrap px-2.5 py-1.5 text-xs';
const MEDAL = ['text-accent', 'text-ink', 'text-[#c98a4b]'];

const pct = (value: number | null) => (value === null ? '—' : `${value.toFixed(0)}%`);
const ratio = (value: number | null) => (value === null ? '—' : value.toFixed(2));
const money = (value: number | null) => (value === null ? '—' : signedUsd(value));

export const winnerNames = (winners: Standing[]) => winners.map((w) => w.displayName).join(' and ');

/** Full standings with every trader's record. Names the winner once the competition is final. */
export function ResultsDialog({ competitionId, onClose }: { competitionId: string; onClose: () => void }) {
  const results = useTradingStore((s) => s.results);
  const me = useAuthStore((s) => s.user?.traderId);

  useEffect(() => {
    const refresh = () => void useTradingStore.getState().refreshResults(competitionId).catch(() => undefined);
    refresh();
    const timer = setInterval(refresh, 10_000);
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      clearInterval(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [competitionId, onClose]);

  const final = results?.competition.final ?? false;
  const winners = results?.winners ?? [];

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Competition results"
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-sm border border-line bg-panel shadow-2xl shadow-black"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-line bg-raised px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-ink">{results?.competition.name ?? 'Competition'}</h2>
            <p className="mt-0.5 text-[11px] text-dim">
              {final ? 'Final results' : 'Standings so far'}
              {results ? ` · ${dateTime(results.competition.startDate)} to ${dateTime(results.competition.endDate)} · ${usd(results.competition.startingBalance)} starting balance` : ''}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-sm border border-line px-2 py-0.5 text-xs text-dim hover:text-ink">
            Close
          </button>
        </header>

        {final && winners.length > 0 ? (
          <div className="shrink-0 border-b border-accent/40 bg-accent/10 px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-accent">{winners.length > 1 ? 'Winners (tie)' : 'Winner'}</p>
            <p className="mt-0.5 text-lg font-semibold text-ink">{winnerNames(winners)}</p>
            <p className="num text-xs text-dim">
              finished on {usd(winners[0]!.equity)}, <span className={pnlColor(winners[0]!.pnl)}>{signedPct(winners[0]!.returnPct)}</span>
            </p>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto">
          {!results ? (
            <p className="px-4 py-8 text-center text-xs text-faint">Loading results…</p>
          ) : (
            <table className="w-full border-collapse">
              <thead className="sticky top-0 bg-panel">
                <tr>
                  <th className={`${th} text-left`}>#</th>
                  <th className={`${th} text-left`}>Trader</th>
                  <th className={`${th} text-right`}>Equity</th>
                  <th className={`${th} text-right`}>Return</th>
                  <th className={`${th} text-right`}>P&amp;L</th>
                  <th className={`${th} text-right`}>Trades</th>
                  <th className={`${th} text-right`} title="Share of closing trades that made money">Win rate</th>
                  <th className={`${th} text-right`} title="Gross profit divided by gross loss">Profit factor</th>
                  <th className={`${th} text-right`}>Best trade</th>
                  <th className={`${th} text-right`}>Worst trade</th>
                </tr>
              </thead>
              <tbody>
                {results.standings.map((row) => (
                  <tr key={row.traderId} className={`border-b border-line/60 ${row.traderId === me ? 'bg-accent/10' : ''}`}>
                    <td className={`${td} font-bold ${MEDAL[row.rank - 1] ?? 'text-faint'}`}>{row.rank}</td>
                    <td className={`${td} font-sans`}>
                      <span className="text-ink">{row.displayName}</span>
                      <span className="num ml-2 text-[10px] text-faint">{row.traderId}</span>
                      {row.traderId === me ? <span className="ml-2 text-[10px] font-semibold uppercase text-accent">you</span> : null}
                    </td>
                    <td className={`${td} text-right text-ink`}>{usd(row.equity)}</td>
                    <td className={`${td} text-right font-semibold ${pnlColor(row.pnl)}`}>{signedPct(row.returnPct)}</td>
                    <td className={`${td} text-right ${pnlColor(row.pnl)}`}>{signedUsd(row.pnl)}</td>
                    <td className={`${td} text-right text-dim`}>{row.trades}</td>
                    <td className={`${td} text-right text-dim`}>{pct(row.winRate)}</td>
                    <td className={`${td} text-right text-dim`}>{ratio(row.profitFactor)}</td>
                    <td className={`${td} text-right ${pnlColor(row.bestTrade ?? 0)}`}>{money(row.bestTrade)}</td>
                    <td className={`${td} text-right ${pnlColor(row.worstTrade ?? 0)}`}>{money(row.worstTrade)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p className="shrink-0 border-t border-line px-4 py-2 text-[10px] text-faint">
          {final
            ? 'When the competition ended every open position was closed at the final price, so these results are settled and will not change.'
            : 'Equity is updated every ten seconds. The winner is the trader with the highest equity when the competition ends.'}
        </p>
      </div>
    </div>
  );
}

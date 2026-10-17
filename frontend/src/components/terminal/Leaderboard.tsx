'use client';

import { pnlColor, signedPct, usd } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import type { LeaderboardEntry } from '@/lib/types';
import { useAuthStore } from '@/store/auth';
import { useTradingStore } from '@/store/trading';
import { EmptyState, Panel } from '../ui/Panel';

const RANK_COLOR = ['text-accent', 'text-ink', 'text-[#c98a4b]'];

function Row({ entry, mine }: { entry: LeaderboardEntry; mine: boolean }) {
  return (
    <tr className={`border-b border-line/60 ${mine ? 'bg-accent/10' : ''}`}>
      <td className={`num border-l-2 py-1.5 pl-2 pr-1 text-xs font-bold ${mine ? 'border-accent' : 'border-transparent'} ${RANK_COLOR[entry.rank - 1] ?? 'text-faint'}`}>
        {entry.rank}
      </td>
      <td className="max-w-0 py-1.5 pr-2 text-xs">
        {/* A long name is shortened; the "you" tag always stays in view. */}
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`truncate ${mine ? 'font-semibold text-ink' : 'text-ink/90'}`} title={entry.displayName}>
            {entry.displayName}
          </span>
          {mine ? <span className="shrink-0 text-[10px] font-semibold uppercase text-accent">you</span> : null}
        </span>
      </td>
      <td className="num py-1.5 pr-2 text-right text-xs text-ink" title={entry.startingBalance ? `Started with ${usd(entry.startingBalance)}` : undefined}>
        {usd(entry.equity)}
      </td>
      <td className={`num py-1.5 pr-2 text-right text-xs ${pnlColor(entry.pnl)}`}>{signedPct(entry.returnPct)}</td>
    </tr>
  );
}

function Freshness({ updatedAt }: { updatedAt: string | null }) {
  const now = useNow(1000);
  if (!updatedAt) return null;
  const seconds = Math.max(0, Math.round((now - Date.parse(updatedAt)) / 1000));
  return <span className="num text-[10px] normal-case tracking-normal text-faint">{seconds < 2 ? 'just now' : `${seconds}s ago`}</span>;
}

/** Top traders by return on the money each started with, read from the Redis sorted set the worker maintains. */
export function Leaderboard({ active, final, onShowResults }: { active: boolean; final: boolean; onShowResults: () => void }) {
  const board = useTradingStore((s) => s.leaderboard);
  const traderId = useAuthStore((s) => s.user?.traderId);
  const outside = board?.me && !board.entries.some((e) => e.traderId === board.me!.traderId) ? board.me : null;

  return (
    <Panel
      title={final ? 'Final standings' : 'Leaderboard'}
      className="h-full"
      actions={
        <>
          {final ? <span className="rounded-xs bg-accent/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-accent">Final</span> : <Freshness updatedAt={board?.updatedAt ?? null} />}
          {active ? (
            <button type="button" onClick={onShowResults} className="rounded-xs border border-line px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-dim hover:text-ink">
              {final ? 'Results' : 'Full table'}
            </button>
          ) : null}
        </>
      }
    >
      {!active ? (
        <EmptyState>Standings appear once you are in a competition.</EmptyState>
      ) : !board ? (
        <EmptyState>Loading standings…</EmptyState>
      ) : board.entries.length === 0 ? (
        <EmptyState>No traders in this competition yet.</EmptyState>
      ) : (
        <div className="flex h-full flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <table className="w-full table-fixed border-collapse">
              <thead className="sticky top-0 bg-panel">
                <tr className="text-[10px] uppercase tracking-wider text-faint">
                  <th className="w-8 py-1 pl-2.5 text-left font-medium">#</th>
                  <th className="py-1 text-left font-medium">Trader</th>
                  <th className="w-24 py-1 pr-2 text-right font-medium">Equity</th>
                  <th className="w-16 py-1 pr-2 text-right font-medium">Return</th>
                </tr>
              </thead>
              <tbody>
                {board.entries.map((entry) => (
                  <Row key={entry.traderId} entry={entry} mine={entry.traderId === traderId} />
                ))}
                {outside ? (
                  <>
                    <tr aria-hidden>
                      <td colSpan={4} className="py-0.5 text-center text-[10px] leading-none text-faint">
                        ⋮
                      </td>
                    </tr>
                    <Row entry={outside} mine />
                  </>
                ) : null}
              </tbody>
            </table>
          </div>
          <p className="shrink-0 border-t border-line px-2.5 py-1 text-[10px] text-faint">
            {board.participants} trader{board.participants === 1 ? '' : 's'} · ranked by return
          </p>
        </div>
      )}
    </Panel>
  );
}

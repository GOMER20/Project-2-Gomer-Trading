'use client';

import { useEffect, type ReactNode } from 'react';
import { price, shares } from '@/lib/format';
import { socket } from '@/lib/socket';
import type { DepthLevel } from '@/lib/types';
import { useMarketStore } from '@/store/market';
import { useTicketStore } from '@/store/ticket';
import { useUiStore } from '@/store/ui';
import { EmptyState, Panel } from '../ui/Panel';

const ROWS = 10;

/** One side of one row: a size bar growing from the middle, the size, and the price as a button. */
function Cell({ level, side, widest }: { level: DepthLevel | undefined; side: 'bid' | 'ask'; widest: number }) {
  const pick = useTicketStore((s) => s.pick);
  if (!level) return <div className="flex-1" />;
  const [levelPrice, size] = level;
  const bid = side === 'bid';
  return (
    <button
      type="button"
      onClick={() => pick(levelPrice)}
      title={`Load ${price(levelPrice)} into the order ticket`}
      className={`relative flex h-[18px] flex-1 items-center justify-between gap-2 px-2 text-[11px] hover:brightness-150 ${bid ? '' : 'flex-row-reverse'}`}
    >
      <span aria-hidden className={`absolute inset-y-px ${bid ? 'right-0 bg-up/15' : 'left-0 bg-down/15'}`} style={{ width: `${Math.max(2, (size / widest) * 100)}%` }} />
      <span className="num relative text-dim">{shares(size)}</span>
      <span className={`num relative font-semibold ${bid ? 'text-up' : 'text-down'}`}>{price(levelPrice)}</span>
    </button>
  );
}

/**
 * Level 2: how many shares are bid and offered at each price around the market.
 * Orders trade against this book, so it shows what a large order would pay.
 * Clicking a price loads it into the order ticket.
 */
export function DepthLadder({ actions }: { actions?: ReactNode }) {
  const symbol = useUiStore((s) => s.symbol);
  const depth = useMarketStore((s) => (s.depth?.symbol === symbol ? s.depth : null));

  useEffect(() => {
    socket.watchDepth(symbol);
    return () => socket.watchDepth(null);
  }, [symbol]);

  const bids = depth?.bids.slice(0, ROWS) ?? [];
  const asks = depth?.asks.slice(0, ROWS) ?? [];
  const widest = Math.max(1, ...bids.map((level) => level[1]), ...asks.map((level) => level[1]));
  const total = (levels: DepthLevel[]) => levels.reduce((sum, level) => sum + level[1], 0);

  return (
    <Panel title={<>Level 2 · <span className="text-ink">{symbol}</span></>} actions={actions} className="h-full">
      {!depth || (bids.length === 0 && asks.length === 0) ? (
        <EmptyState>The order book appears here when the market is quoting.</EmptyState>
      ) : (
        <div className="flex h-full flex-col">
          <div className="flex shrink-0 text-[10px] uppercase tracking-wider text-faint">
            <span className="flex flex-1 justify-between px-2 py-1">
              <span>Size</span>
              <span>Bid</span>
            </span>
            <span className="flex flex-1 justify-between px-2 py-1">
              <span>Ask</span>
              <span>Size</span>
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {Array.from({ length: Math.max(bids.length, asks.length) }, (_, row) => (
              <div key={row} className="flex border-b border-line/30">
                <Cell level={bids[row]} side="bid" widest={widest} />
                <Cell level={asks[row]} side="ask" widest={widest} />
              </div>
            ))}
          </div>
          <div className="shrink-0 border-t border-line px-2 py-1 text-[10px] text-faint" title="Only the best bid and offer come from the price feed. The levels behind them are modelled, and orders trade against them.">
            <p className="num flex justify-between">
              <span>{shares(total(bids))} bid</span>
              <span>{shares(total(asks))} offered</span>
            </p>
            <p className="text-center">Levels behind the best prices are modelled</p>
          </div>
        </div>
      )}
    </Panel>
  );
}

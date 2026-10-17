'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { price, shares } from '@/lib/format';
import { useMarketStore } from '@/store/market';
import { useUiStore } from '@/store/ui';
import { EmptyState, Panel } from '../ui/Panel';

interface Print {
  id: number;
  time: string;
  price: number;
  size: number | null;
  /** 1 = traded higher than the previous print, -1 = lower, 0 = same. */
  direction: -1 | 0 | 1;
}

const MAX_PRINTS = 80;
const clock = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/** Time & sales: each trade in the selected symbol as it prints, newest first. */
export function Tape({ actions }: { actions?: ReactNode }) {
  const symbol = useUiStore((s) => s.symbol);
  const [prints, setPrints] = useState<Print[]>([]);

  // Restart the tape when the symbol changes (state reset during render, the React-endorsed way).
  const [shown, setShown] = useState(symbol);
  if (shown !== symbol) {
    setShown(symbol);
    setPrints([]);
  }

  useEffect(() => {
    let lastPrice = 0;
    let lastSize: number | undefined;
    let lastTs = 0;
    let next = 0;
    return useMarketStore.subscribe((state) => {
      const quote = state.quotes[symbol];
      // A new print is a change in the last trade; bid/ask updates alone do not count.
      if (!quote || !(quote.last > 0) || quote.ts === lastTs || (quote.last === lastPrice && quote.lastSize === lastSize)) return;
      const direction = lastPrice === 0 ? 0 : (Math.sign(quote.last - lastPrice) as -1 | 0 | 1);
      const first = lastTs === 0; // the quote already on screen is not a new trade
      lastPrice = quote.last;
      lastSize = quote.lastSize;
      lastTs = quote.ts;
      if (first) return;
      const print: Print = { id: next++, time: clock.format(quote.ts), price: quote.last, size: quote.lastSize ?? null, direction };
      setPrints((current) => [print, ...current].slice(0, MAX_PRINTS));
    });
  }, [symbol]);

  return (
    <Panel title={<>Time &amp; Sales · <span className="text-ink">{symbol}</span></>} actions={actions} className="h-full">
      {prints.length === 0 ? (
        <EmptyState>Trades appear here as they print.</EmptyState>
      ) : (
        <div className="h-full overflow-y-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-panel">
              <tr className="text-[10px] uppercase tracking-wider text-faint">
                <th className="py-1 pl-2.5 text-left font-medium">Time</th>
                <th className="py-1 text-right font-medium">Price</th>
                <th className="py-1 pr-2.5 text-right font-medium">Size</th>
              </tr>
            </thead>
            <tbody>
              {prints.map((print) => (
                <tr key={print.id} className="border-b border-line/40">
                  <td className="num py-0.5 pl-2.5 text-[11px] text-faint">{print.time}</td>
                  <td className={`num py-0.5 text-right text-[11px] ${print.direction > 0 ? 'text-up' : print.direction < 0 ? 'text-down' : 'text-dim'}`}>{price(print.price)}</td>
                  <td className="num py-0.5 pr-2.5 text-right text-[11px] text-dim">{print.size === null ? '—' : shares(print.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

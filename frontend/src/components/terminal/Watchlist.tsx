'use client';

import { useState, type FormEvent } from 'react';
import { price, signedPct, SYMBOL_PATTERN } from '@/lib/format';
import { useTickFlash } from '@/lib/hooks';
import { useMarketStore } from '@/store/market';
import { useUiStore } from '@/store/ui';
import { Panel } from '../ui/Panel';

function Row({ symbol, selected }: { symbol: string; selected: boolean }) {
  const quote = useMarketStore((s) => s.quotes[symbol]);
  const unknown = useMarketStore((s) => s.unknown[symbol]);
  const setSymbol = useUiStore((s) => s.setSymbol);
  const remove = useUiStore((s) => s.removeFromWatchlist);
  const flash = useTickFlash(quote?.last);

  const change = quote?.prevClose ? ((quote.last - quote.prevClose) / quote.prevClose) * 100 : null;
  const tone = change === null ? 'text-dim' : change > 0 ? 'text-up' : change < 0 ? 'text-down' : 'text-dim';

  return (
    <tr
      onClick={() => setSymbol(symbol)}
      className={`group cursor-pointer border-b border-line/60 ${selected ? 'bg-hover' : 'hover:bg-raised'}`}
      aria-selected={selected}
    >
      <td className={`border-l-2 py-1.5 pl-2 text-xs font-semibold ${selected ? 'border-accent text-ink' : 'border-transparent text-ink/90'}`}>
        {symbol}
      </td>
      <td className="py-1.5 text-right">
        <span key={flash.key} className={`num rounded-xs px-1 text-xs ${flash.className}`}>
          {unknown ? <span className="text-faint">no data</span> : price(quote?.last)}
        </span>
      </td>
      <td className={`num py-1.5 text-right text-xs ${tone}`}>{change === null ? '—' : signedPct(change)}</td>
      <td className="w-6 py-1.5 pr-1 text-right">
        <button
          type="button"
          aria-label={`Remove ${symbol} from watchlist`}
          onClick={(e) => {
            e.stopPropagation();
            remove(symbol);
          }}
          className="px-1 text-faint opacity-0 hover:text-down focus-visible:opacity-100 group-hover:opacity-100"
        >
          ×
        </button>
      </td>
    </tr>
  );
}

export function Watchlist() {
  const watchlist = useUiStore((s) => s.watchlist);
  const selected = useUiStore((s) => s.symbol);
  const add = useUiStore((s) => s.addToWatchlist);
  const setSymbol = useUiStore((s) => s.setSymbol);
  const [draft, setDraft] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    const symbol = draft.trim().toUpperCase();
    if (!SYMBOL_PATTERN.test(symbol)) return;
    add(symbol);
    setSymbol(symbol);
    setDraft('');
  }

  return (
    <Panel title="Watchlist" className="h-full">
      <div className="flex h-full flex-col">
        <form onSubmit={submit} className="flex shrink-0 gap-1 border-b border-line p-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value.toUpperCase())}
            placeholder="Add symbol"
            aria-label="Add symbol to watchlist"
            maxLength={10}
            spellCheck={false}
            className="num h-7 min-w-0 flex-1 rounded-sm border border-line bg-surface px-2 text-xs text-ink placeholder:text-faint focus:border-info focus:outline-none"
          />
          <button type="submit" className="h-7 rounded-sm border border-line bg-raised px-2.5 text-xs text-dim hover:text-ink">
            Add
          </button>
        </form>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-panel">
              <tr className="text-[10px] uppercase tracking-wider text-faint">
                <th className="py-1 pl-2.5 text-left font-medium">Symbol</th>
                <th className="py-1 pr-1 text-right font-medium">Last</th>
                <th className="py-1 text-right font-medium">Chg</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {watchlist.map((symbol) => (
                <Row key={symbol} symbol={symbol} selected={symbol === selected} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Panel>
  );
}

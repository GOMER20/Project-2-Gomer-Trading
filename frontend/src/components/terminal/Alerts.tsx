'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { allowPopups, chime, signal } from '@/lib/alerts';
import { dateTime, markOf, price } from '@/lib/format';
import { useAlertStore, type PriceAlert } from '@/store/alerts';
import { useAuthStore } from '@/store/auth';
import { useMarketStore } from '@/store/market';
import { useTradingStore } from '@/store/trading';
import { useUiStore } from '@/store/ui';
import { EmptyState } from '../ui/Panel';

/**
 * Price alerts and the alert switches.
 *
 * A price alert is checked here, in the terminal, against every quote that
 * arrives, so it works while the terminal is open (the desktop app keeps it
 * open in the Dock). It goes off once: a message on screen, a chime, and a
 * system notification when the app is not in front.
 */

const reached = (alert: PriceAlert, mark: number) => (alert.direction === 'above' ? mark >= alert.price : mark <= alert.price);

/** The symbols with an alert waiting, for the terminal to keep their quotes coming. */
export function useAlertSymbols(): string[] {
  const traderId = useAuthStore((s) => s.user?.traderId);
  const alerts = useAlertStore((s) => s.priceAlerts);
  return [...new Set(alerts.filter((a) => a.traderId === traderId && !a.triggeredAt).map((a) => a.symbol))];
}

/** Watches every quote for the waiting alerts. Renders nothing. */
export function PriceAlertWatcher() {
  const traderId = useAuthStore((s) => s.user?.traderId);
  useEffect(() => {
    const check = (quotes: ReturnType<typeof useMarketStore.getState>['quotes']) => {
      const { priceAlerts, triggerPriceAlert } = useAlertStore.getState();
      for (const alert of priceAlerts) {
        if (alert.traderId !== traderId || alert.triggeredAt) continue;
        const mark = markOf(quotes[alert.symbol]);
        if (mark === null || !reached(alert, mark)) continue;
        triggerPriceAlert(alert.id, mark);
        const title = `Price alert: ${alert.symbol} ${alert.direction === 'above' ? 'rose' : 'fell'} to ${price(mark)}`;
        const detail = `You asked to be told at ${price(alert.price)}.`;
        useTradingStore.getState().toast({ tone: alert.direction === 'above' ? 'up' : 'down', title, detail });
        signal('alert', title, detail);
      }
    };
    check(useMarketStore.getState().quotes);
    return useMarketStore.subscribe((state, previous) => {
      if (state.quotes !== previous.quotes) check(state.quotes);
    });
  }, [traderId]);
  return null;
}

function Switch({ on, onChange, label, note }: { on: boolean; onChange: (on: boolean) => void; label: string; note?: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[11px] text-dim">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} className="size-3.5 accent-[var(--color-accent)]" />
      <span className="text-ink">{label}</span>
      {note ? <span className="text-faint">{note}</span> : null}
    </label>
  );
}

export function AlertsPanel() {
  const traderId = useAuthStore((s) => s.user?.traderId) ?? '';
  const symbol = useUiStore((s) => s.symbol);
  const quote = useMarketStore((s) => s.quotes[symbol]);
  const { sound, popups, priceAlerts, setSound, setPopups, addPriceAlert, removePriceAlert } = useAlertStore();
  const [target, setTarget] = useState('');
  const [popupNote, setPopupNote] = useState<string | null>(null);
  const mark = markOf(quote);
  const value = Number(target);
  const valid = target !== '' && Number.isFinite(value) && value > 0 && mark !== null && value !== mark;
  const mine = priceAlerts.filter((a) => a.traderId === traderId);
  const waiting = mine.filter((a) => !a.triggeredAt);
  const gone = mine.filter((a) => a.triggeredAt).slice(-20).reverse();

  function add(event: FormEvent) {
    event.preventDefault();
    if (!valid || mark === null) return;
    addPriceAlert({ traderId, symbol, direction: value > mark ? 'above' : 'below', price: Math.round(value * 100) / 100 });
    setTarget('');
  }

  async function switchPopups(on: boolean) {
    setPopups(on);
    if (!on) return setPopupNote(null);
    const answer = await allowPopups();
    setPopupNote(answer === 'denied' ? 'This browser is blocking notifications for this site; allow them in its settings.' : null);
  }

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-b border-line/60 px-3 py-2">
        <Switch on={sound} onChange={setSound} label="Sound" note="a chime on every fill and alert" />
        <Switch on={popups} onChange={(on) => void switchPopups(on)} label="Pop-ups" note="a notification when the app is not in front" />
        <button type="button" onClick={() => chime('fill')} className="text-[11px] text-info hover:underline">
          Play the sound
        </button>
        {popupNote ? <span className="w-full text-[11px] text-accent">{popupNote}</span> : null}
      </div>

      <form onSubmit={add} className="flex flex-wrap items-center gap-2 border-b border-line/60 px-3 py-2 text-[11px]">
        <span className="text-dim">
          Tell me when <span className="font-semibold text-ink">{symbol}</span> {mark !== null ? <span className="num text-faint">(now {price(mark)})</span> : null} reaches
        </span>
        <input
          type="number"
          step="0.01"
          min="0.01"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={mark !== null ? price(mark) : 'price'}
          aria-label={`Alert price for ${symbol}`}
          className="num h-7 w-28 rounded-sm border border-line bg-surface px-2 text-xs text-ink focus:border-info focus:outline-none"
        />
        <button type="submit" disabled={!valid} className="h-7 rounded-sm bg-accent px-3 text-xs font-semibold text-surface hover:brightness-110 disabled:opacity-40">
          Add alert
        </button>
        {valid && mark !== null ? <span className="text-faint">when it {value > mark ? 'rises' : 'falls'} to {price(value)}</span> : null}
      </form>

      {waiting.length === 0 && gone.length === 0 ? (
        <EmptyState>No price alerts. Pick a symbol, type a price and add one: you are told the moment it gets there.</EmptyState>
      ) : (
        <table className="w-full">
          <tbody>
            {waiting.map((a) => (
              <tr key={a.id} className="border-b border-line/50">
                <td className="num px-3 py-1.5 text-[11px] font-semibold text-ink">{a.symbol}</td>
                <td className="px-2 py-1.5 text-[11px] text-dim">
                  {a.direction === 'above' ? 'rises to' : 'falls to'} <span className="num text-ink">{price(a.price)}</span>
                </td>
                <td className="px-2 py-1.5 text-[11px] text-faint">waiting · set {dateTime(a.createdAt)}</td>
                <td className="px-3 py-1.5 text-right">
                  <button type="button" onClick={() => removePriceAlert(a.id)} className="text-[11px] text-dim hover:text-down">
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {gone.map((a) => (
              <tr key={a.id} className="border-b border-line/50 opacity-70">
                <td className="num px-3 py-1.5 text-[11px] text-ink">{a.symbol}</td>
                <td className="px-2 py-1.5 text-[11px] text-dim">
                  {a.direction === 'above' ? 'rose to' : 'fell to'} <span className="num text-ink">{price(a.triggeredPrice)}</span>
                </td>
                <td className="px-2 py-1.5 text-[11px] text-faint">✓ went off {a.triggeredAt ? dateTime(a.triggeredAt) : ''}</td>
                <td className="px-3 py-1.5 text-right">
                  <button type="button" onClick={() => removePriceAlert(a.id)} className="text-[11px] text-dim hover:text-ink">
                    Clear
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

'use client';

import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '@/lib/api';
import { signedUsd, usd } from '@/lib/format';

/** Amounts offered with one click; any other amount can be typed. */
export const MONEY_PRESETS = [100_000, 1_000_000, 10_000_000, 100_000_000];

/** "$100K", "$1M", "$10M" */
export const shortUsd = (value: number) =>
  value >= 1_000_000_000 ? `$${value / 1_000_000_000}B` : value >= 1_000_000 ? `$${value / 1_000_000}M` : value >= 1_000 ? `$${value / 1_000}K` : usd(value);

/** One-click amounts for a money field. */
export function MoneyPresets({ value, onPick }: { value: number; onPick: (amount: number) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {MONEY_PRESETS.map((amount) => (
        <button
          key={amount}
          type="button"
          onClick={() => onPick(amount)}
          aria-pressed={value === amount}
          className={`num h-6 rounded-sm border px-2 text-[11px] ${value === amount ? 'border-accent bg-accent/10 text-accent' : 'border-line text-dim hover:text-ink'}`}
        >
          {shortUsd(amount)}
        </button>
      ))}
    </div>
  );
}

/**
 * The money a competition's accounts start with, and the switch to change it.
 * Every account in the competition has its cash moved by the difference, so
 * profits and losses so far are kept; traders who join later get the new amount.
 */
export function StartingMoney({ competitionId, competitionName, current, onChanged }: { competitionId: string; competitionName: string; current: number; onChanged?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(String(current));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const value = Number(amount);
  const valid = Number.isFinite(value) && value >= 100 && value <= 1_000_000_000;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      const changed = await api<{ previous: number; startingBalance: number; accounts: number }>(`/api/competitions/${competitionId}/balance`, { method: 'PUT', body: { startingBalance: value } });
      const moved = changed.startingBalance - changed.previous;
      setNotice({
        ok: true,
        text: `${competitionName} now starts with ${usd(changed.startingBalance)}. ${changed.accounts} account${changed.accounts === 1 ? '' : 's'} had ${signedUsd(moved)} added to cash; profits and losses so far are unchanged.`,
      });
      setEditing(false);
      onChanged?.();
    } catch (err) {
      setNotice({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="text-[11px]">
      {editing ? (
        <form onSubmit={save} className="flex flex-wrap items-center gap-2">
          <span className="text-faint">Starting money</span>
          <MoneyPresets value={value} onPick={(picked) => setAmount(String(picked))} />
          <input
            type="number"
            min={100}
            max={1_000_000_000}
            step={1000}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label="Starting money in dollars"
            className="num h-7 w-36 rounded-sm border border-line bg-surface px-2 text-xs text-ink focus:border-info focus:outline-none"
          />
          <button type="submit" disabled={!valid || busy || value === current} className="h-7 rounded-sm bg-accent px-3 text-xs font-semibold text-surface hover:brightness-110 disabled:opacity-40">
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={() => setEditing(false)} className="h-7 rounded-sm border border-line px-2 text-xs text-dim hover:text-ink">
            Cancel
          </button>
          <span className="w-full text-faint">Every account in this competition gets the difference added to (or taken from) its cash, so what each has made or lost so far stays the same.</span>
        </form>
      ) : (
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-faint">Starting money</span>
          <span className="num text-ink">{usd(current)}</span>
          <button
            type="button"
            onClick={() => {
              setAmount(String(current));
              setNotice(null);
              setEditing(true);
            }}
            className="rounded-sm border border-line px-2 py-0.5 text-dim hover:border-accent hover:text-accent"
          >
            Change
          </button>
        </span>
      )}
      {notice ? <p className={`mt-1 ${notice.ok ? 'text-up' : 'text-down'}`}>{notice.text}</p> : null}
    </div>
  );
}

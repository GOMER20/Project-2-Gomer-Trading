const usdFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const timeFormat = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export const usd = (value: number) => usdFormat.format(value);

/** Currency with an explicit sign, for P&L: +$1,234.50 / -$87.20 */
export const signedUsd = (value: number) => `${value > 0 ? '+' : value < 0 ? '-' : ''}${usdFormat.format(Math.abs(value))}`;

export const signedPct = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;

/** Share prices: two decimals, four below a dollar. */
export const price = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value) || value <= 0) return '—';
  return value < 1 ? value.toFixed(4) : value.toFixed(2);
};

export const shares = (value: number) => intFormat.format(value);

export const clock = (iso: string) => timeFormat.format(new Date(iso));
export const dateTime = (iso: string) => dateFormat.format(new Date(iso));

/** Tailwind text colour for a signed number. */
export const pnlColor = (value: number) => (value > 0 ? 'text-up' : value < 0 ? 'text-down' : 'text-dim');

/** Price used to value a position, matching the backend: last trade, else the midpoint. */
export function markOf(quote: { bid: number; ask: number; last: number } | undefined): number | null {
  if (!quote) return null;
  if (quote.last > 0) return quote.last;
  return quote.bid > 0 && quote.ask > 0 ? (quote.bid + quote.ask) / 2 : null;
}

export function timeRemaining(endIso: string, now: number): string {
  const ms = Date.parse(endIso) - now;
  if (ms <= 0) return 'ended';
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${minutes}m ${Math.floor((ms % 60_000) / 1000)}s left`;
}

const localTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const localDay = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const newYorkTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });

/** A moment in the viewer's own time zone: "7:00 PM" today, "Mon 7:00 PM" on another day. */
export function localMoment(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date(now).toDateString();
  return sameDay ? localTime.format(date) : `${localDay.format(date)} ${localTime.format(date)}`;
}

/** The same moment as New York clocks show it, for anyone comparing with exchange hours. */
export const newYorkMoment = (iso: string) => `${newYorkTime.format(new Date(iso))} New York`;

/** "5h 12m", "42m", "under a minute". */
export function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

export const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.]{0,9}$/;

/**
 * When the US stock market (NYSE / Nasdaq) is open.
 *
 * Everything is computed from the rules the exchanges publish, in New York
 * time, and returned as absolute instants, so a trader anywhere sees the right
 * moment in their own time zone and daylight-saving changes on either side
 * take care of themselves. Checked against NYSE's 2026 and 2027 calendars.
 *
 * Not covered: unscheduled closures (a day of mourning, a market-wide halt).
 * The live quote feed is the final word on those.
 */

export interface Session {
  /** New York calendar date of the session, YYYY-MM-DD. */
  date: string;
  opensAt: Date;
  closesAt: Date;
  /** True on the few days trading stops at 1:00 pm New York time. */
  earlyClose: boolean;
}

export interface MarketHours {
  open: boolean;
  /** The session in progress, or the next one. */
  session: Session;
  /** Name of the holiday if the market is closed for one today (New York date). */
  holiday: string | null;
  /** The next few sessions after `session`. */
  upcoming: Session[];
}

const DAY_MS = 86_400_000;
const OPEN = { hour: 9, minute: 30 };
const CLOSE = { hour: 16, minute: 0 };
const EARLY_CLOSE = { hour: 13, minute: 0 };

const newYork = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** New York wall-clock fields for an instant. */
function inNewYork(instant: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts: Record<string, number> = {};
  for (const part of newYork.formatToParts(new Date(instant))) if (part.type !== 'literal') parts[part.type] = Number(part.value);
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute!, second: parts.second! };
}

/** The instant at which New York clocks read the given wall time. */
function newYorkInstant(year: number, month: number, day: number, hour: number, minute: number): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (instant: number) => {
    const p = inNewYork(instant);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant;
  };
  // Two passes settle the offset even right after a clock change.
  const first = wall - offsetAt(wall);
  return new Date(wall - offsetAt(first));
}

// --- calendar arithmetic on plain dates (noon UTC stands in for "that day") ----

const utc = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day, 12));
const key = (date: Date) => date.toISOString().slice(0, 10);
const weekday = (date: Date) => date.getUTCDay(); // 0 = Sunday
const shift = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

function nthWeekday(year: number, month: number, day: number, n: number): Date {
  const first = utc(year, month, 1);
  return shift(first, ((day - weekday(first) + 7) % 7) + (n - 1) * 7);
}

function lastWeekday(year: number, month: number, day: number): Date {
  const last = shift(utc(year, month + 1, 1), -1);
  return shift(last, -((weekday(last) - day + 7) % 7));
}

/** Easter Sunday (Gregorian), by the anonymous algorithm. */
function easter(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(year, month, day);
}

/** A fixed-date holiday moves to Friday when it falls on Saturday and to Monday when it falls on Sunday. */
function observed(date: Date): Date {
  if (weekday(date) === 6) return shift(date, -1);
  if (weekday(date) === 0) return shift(date, 1);
  return date;
}

/** Days the market is closed in a year, by New York date. */
export function holidays(year: number): Map<string, string> {
  const days = new Map<string, string>();
  const add = (date: Date, name: string) => days.set(key(date), name);

  // New Year's Day on a Saturday is simply not observed: the Friday before stays a trading day.
  const newYear = utc(year, 1, 1);
  if (weekday(newYear) !== 6) add(observed(newYear), "New Year's Day");
  add(nthWeekday(year, 1, 1, 3), 'Martin Luther King, Jr. Day');
  add(nthWeekday(year, 2, 1, 3), "Washington's Birthday");
  add(shift(easter(year), -2), 'Good Friday');
  add(lastWeekday(year, 5, 1), 'Memorial Day');
  add(observed(utc(year, 6, 19)), 'Juneteenth');
  add(observed(utc(year, 7, 4)), 'Independence Day');
  add(nthWeekday(year, 9, 1, 1), 'Labor Day');
  add(nthWeekday(year, 11, 4, 4), 'Thanksgiving Day');
  add(observed(utc(year, 12, 25)), 'Christmas Day');
  return days;
}

/** Days trading stops at 1:00 pm: after Thanksgiving, and the eves of Independence Day and Christmas when they are trading days. */
export function earlyCloses(year: number): Set<string> {
  const closed = holidays(year);
  const isTradingDay = (date: Date) => weekday(date) !== 0 && weekday(date) !== 6 && !closed.has(key(date));
  const days = new Set<string>([key(shift(nthWeekday(year, 11, 4, 4), 1))]);
  for (const eve of [utc(year, 7, 3), utc(year, 12, 24)]) if (isTradingDay(eve)) days.add(key(eve));
  return days;
}

/** The trading session on a New York date, or null when the market is closed that day. */
export function sessionOn(year: number, month: number, day: number): Session | null {
  const date = utc(year, month, day);
  if (weekday(date) === 0 || weekday(date) === 6 || holidays(year).has(key(date))) return null;
  const earlyClose = earlyCloses(year).has(key(date));
  const close = earlyClose ? EARLY_CLOSE : CLOSE;
  return {
    date: key(date),
    opensAt: newYorkInstant(year, month, day, OPEN.hour, OPEN.minute),
    closesAt: newYorkInstant(year, month, day, close.hour, close.minute),
    earlyClose,
  };
}

/** Whether the market is open at `now`, and the sessions from here on. */
export function marketHours(now = new Date(), count = 5): MarketHours {
  const today = inNewYork(now.getTime());
  const start = utc(today.year, today.month, today.day);
  const sessions: Session[] = [];
  // Two weeks always contains more than `count` sessions, however the holidays fall.
  for (let offset = 0; offset < 21 && sessions.length < count + 1; offset++) {
    const date = shift(start, offset);
    const session = sessionOn(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    if (session && session.closesAt > now) sessions.push(session);
  }
  const [session, ...upcoming] = sessions as [Session, ...Session[]];
  return {
    open: session.opensAt <= now,
    session,
    holiday: holidays(today.year).get(key(start)) ?? null,
    upcoming: upcoming.slice(0, count),
  };
}

/** The most recent sessions that opened before `before`, newest first. The first one may still be in progress. */
export function sessionsBefore(before = new Date(), count = 5): Session[] {
  const today = inNewYork(before.getTime());
  const start = utc(today.year, today.month, today.day);
  const sessions: Session[] = [];
  // The longest closure on the calendar is a four-day weekend, so this always finds them.
  for (let offset = 0; offset < count * 2 + 10 && sessions.length < count; offset++) {
    const date = shift(start, -offset);
    const session = sessionOn(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    if (session && session.opensAt < before) sessions.push(session);
  }
  return sessions;
}

/** Calendar days from one session date (YYYY-MM-DD) to another: 1 for an ordinary night, 3 across a weekend. */
export function nightsBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(`${later}T12:00:00Z`) - Date.parse(`${earlier}T12:00:00Z`)) / DAY_MS);
}

import { pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { TIMEFRAMES, type Bar, type Quote, type Timeframe } from '../types.js';
import { MarketModel, type ModelState } from './model.js';
import type { FeedStatus, MarketDataProvider, QuoteUpdate } from './provider.js';
import { LISTINGS, type Listing } from './universe.js';
import { marketHours, nightsBetween, sessionsBefore, type Session } from './usMarketHours.js';

/**
 * Gomer Trading's built-in market. It needs no account and no network, and is
 * what the platform trades on until a real-time data key is connected.
 *
 * The prices are produced by MarketModel (see model.ts) and are NOT real-world
 * prices. This class gives the model a clock, turns its prices into Level 1
 * quotes and one-minute bars, and gives the market a memory: its state and its
 * chart history are kept in Postgres, so it carries on where it stopped
 * instead of starting over on every launch.
 *
 * It keeps the hours of the US stock exchanges: prices move from the opening
 * bell to the close on trading days and stand still through nights, weekends
 * and holidays, and each session opens away from the last close, the way real
 * stocks do. Set to 'always', it never closes instead, for practice at any hour.
 */

const TICK_MS = 500;
const SAVE_MS = 10_000;
/** Chart history invented for a symbol the first time it is ever looked at: this much around the clock, or this many sessions. */
const BACKFILL_MINUTES = 2 * 24 * 60;
const BACKFILL_SESSIONS = 5;
const HISTORY_LIMIT = 6_000;
const KEEP_BARS_DAYS = 14;

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Local calendar day; "today's change" is measured from the last price of the previous one. */
const localDay = (at = new Date()) => `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;

function gaussian(): number {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

interface Book {
  listing: Listing;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  last: number;
  lastSize: number;
  prevClose: number;
  ts: number;
  /** Bars formed since this process started, oldest first. The final one is still forming. */
  live: Bar[];
  /** Older bars from the database, loaded the first time a chart asks for them. */
  history: Promise<Bar[]> | null;
}

interface SavedState {
  day: string;
  model: ModelState;
  closes: Record<string, { prevClose: number; last: number }>;
  /** New York date of the session the market last traded in. */
  session?: string | null;
  /** The hours the market was keeping when this was saved. */
  hours?: PracticeHours;
  /** When prices last moved. */
  at?: number;
}

export type PracticeHours = 'exchange' | 'always';

export interface PracticeMarketOptions {
  /** 'exchange' keeps US market hours (the default); 'always' never closes. */
  hours?: PracticeHours;
  /** What the exchange's calendar takes the time to be. Only replaced in tests. */
  calendar?: () => number;
}

/** Every trading minute (epoch seconds) of the last `sessions` sessions before `end`, oldest first. */
export function sessionMinutesBefore(end: number, sessions: number): number[] {
  const minutes: number[] = [];
  for (const session of sessionsBefore(new Date(end * 1000), sessions).reverse()) {
    const closes = Math.min(end, Math.floor(session.closesAt.getTime() / 1000));
    for (let time = Math.floor(session.opensAt.getTime() / 1000); time < closes; time += 60) minutes.push(time);
  }
  return minutes;
}

export class SimulatedProvider implements MarketDataProvider {
  readonly name = 'simulated' as const;
  private readonly keepsHours: boolean;
  private readonly calendar: () => number;
  /** The session in progress, or the next one. Not used by a market that never closes. */
  private session: Session | null = null;
  private open = false;
  /** New York date of the session this market last traded in. */
  private traded: string | null = null;
  /** When prices last moved. */
  private movedAt = 0;
  /** Settles once bars drawn outside trading hours, by a market that used to run around the clock, are gone. */
  private tidied: Promise<void> = Promise.resolve();
  private onStatus: (status: FeedStatus) => void = () => undefined;
  private model = new MarketModel(LISTINGS);
  private readonly books = new Map<string, Book>();
  private readonly streaming = new Set<string>();
  /** Finished bars waiting to be written. */
  private unsaved: Array<{ symbol: string; bar: Bar }> = [];
  private day = localDay();
  private ticks = 0;
  private timers: NodeJS.Timeout[] = [];
  private onUpdate: (update: QuoteUpdate) => void = () => undefined;

  constructor(options: PracticeMarketOptions = {}) {
    this.keepsHours = (options.hours ?? 'exchange') === 'exchange';
    this.calendar = options.calendar ?? (() => Date.now());
  }

  async start(onUpdate: (update: QuoteUpdate) => void, onStatus: (status: FeedStatus) => void): Promise<void> {
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;
    const saved = await this.load();
    this.model = new MarketModel(LISTINGS, Math.random, saved?.model);
    this.traded = saved?.session ?? null;

    const now = Date.now();
    const today = this.calendar();
    const shut = this.keepsHours && !marketHours(new Date(today), 1).open;
    // A quote carries the moment its price last moved, so a market that is shut shows prices as old as they are.
    const lastClose = sessionsBefore(new Date(today), 2).find((session) => session.closesAt.getTime() <= today)?.closesAt.getTime();
    this.movedAt = shut ? Math.min(now, saved?.at ?? lastClose ?? now) : now;

    for (const listing of LISTINGS) {
      const price = round2(this.model.priceOf(listing.symbol));
      const remembered = saved?.closes[listing.symbol];
      const prevClose = remembered
        ? this.keepsHours || saved.day === this.day
          ? remembered.prevClose // the reference only moves on when a new session opens (around the clock: at midnight)
          : remembered.last // a new day: yesterday's last price is the reference
        : round2(price * (1 - 0.006 * Math.sqrt(listing.vol + 0.3) * gaussian()));
      const book: Book = { listing, bid: 0, ask: 0, bidSize: 0, askSize: 0, last: price, lastSize: 100, prevClose, ts: this.movedAt, live: [], history: null };
      this.requote(book, price, 1);
      // While the market is shut the last trade is the one it closed on, not a new one.
      if (shut && remembered && remembered.last >= book.bid && remembered.last <= book.ask) book.last = remembered.last;
      this.books.set(listing.symbol, book);
    }

    logger.info(saved ? 'Built-in market resumed from its saved state' : 'Built-in market opened for the first time');
    if (this.keepsHours) {
      if (saved?.hours !== 'exchange') this.tidied = this.dropOffHoursBars();
      this.session = marketHours(new Date(today), 1).session;
      if (!this.inSession(today)) {
        this.announceClosed();
        void this.save();
      }
    } else {
      this.open = true;
      onStatus({ state: 'streaming' });
    }

    this.timers = [
      setInterval(() => this.tick(), TICK_MS),
      // A market that is shut has nothing new to remember.
      setInterval(() => (this.open || this.unsaved.length > 0 ? void this.save() : undefined), SAVE_MS),
    ];
    for (const timer of this.timers) timer.unref();
    void this.prune();
  }

  async stop(): Promise<void> {
    this.timers.forEach(clearInterval);
    await this.save(true);
  }

  subscribe(symbols: string[]): void {
    for (const symbol of symbols) if (this.books.has(symbol)) this.streaming.add(symbol);
  }

  unsubscribe(symbols: string[]): void {
    for (const symbol of symbols) this.streaming.delete(symbol);
  }

  async fetchSnapshot(symbol: string): Promise<Quote | null> {
    const book = this.books.get(symbol);
    return book ? this.toQuote(symbol, book) : null;
  }

  async fetchBars(symbol: string, timeframe: Timeframe, limit: number): Promise<Bar[]> {
    const book = this.books.get(symbol);
    if (!book) return [];
    book.history ??= this.loadHistory(symbol, book);
    const firstLive = book.live[0]?.time ?? Infinity;
    const bars = [...(await book.history).filter((bar) => bar.time < firstLive), ...book.live];

    const seconds = TIMEFRAMES[timeframe];
    if (seconds === 60) return bars.slice(-limit);
    const out: Bar[] = [];
    for (const bar of bars) {
      const bucket = Math.floor(bar.time / seconds) * seconds;
      const current = out[out.length - 1];
      if (current && current.time === bucket) {
        current.high = Math.max(current.high, bar.high);
        current.low = Math.min(current.low, bar.low);
        current.close = bar.close;
        current.volume += bar.volume;
      } else {
        out.push({ ...bar, time: bucket });
      }
    }
    return out.slice(-limit);
  }

  listSymbols(): Array<{ symbol: string; name: string }> {
    return LISTINGS.map(({ symbol, name }) => ({ symbol, name }));
  }

  /** Orders move this market: buying lifts the price, selling presses it, and the push fades. */
  applyFlow(symbol: string, signedQuantity: number): void {
    this.model.applyFlow(symbol, signedQuantity);
  }

  // --- the clock -------------------------------------------------------------

  private tick(): void {
    const now = Date.now();
    if (this.keepsHours) {
      if (!this.inSession(this.calendar())) return;
    } else if (++this.ticks % 120 === 0 && localDay() !== this.day) {
      // Around the clock there is no opening bell, so "today's change" rolls over at local midnight. Checked once a minute.
      this.day = localDay();
      for (const book of this.books.values()) book.prevClose = book.last;
    }

    const { activity } = this.model.step();
    this.movedAt = now;
    for (const [symbol, book] of this.books) {
      const busy = activity.get(symbol) ?? 1;
      this.requote(book, this.model.priceOf(symbol), busy);
      book.ts = now;
      this.record(symbol, book, now, busy);
      if (this.streaming.has(symbol)) {
        this.onUpdate({ symbol, bid: book.bid, ask: book.ask, bidSize: book.bidSize, askSize: book.askSize, last: book.last, lastSize: book.lastSize, prevClose: book.prevClose, ts: now });
      }
    }
  }

  /**
   * Follows the exchange's clock: rings the closing bell, waits out the night,
   * the weekend or the holiday, and opens the next session. True while the
   * market is trading. Written so a Mac that slept through a close, or through
   * several days, wakes up in the right state.
   */
  private inSession(now: number): boolean {
    let session = this.session!;
    if (now >= session.closesAt.getTime()) {
      const finished = session;
      session = this.session = marketHours(new Date(now), 1).session;
      if (this.open) this.closeSession(finished);
    }
    if (now < session.opensAt.getTime()) return false;
    if (!this.open) this.openSession(session);
    return true;
  }

  private openSession(session: Session): void {
    if (this.traded !== session.date) {
      // A new day. The last price of the previous session is what "today's change" is measured
      // from, and prices open wherever the news since then puts them.
      const nights = this.traded ? Math.max(1, nightsBetween(this.traded, session.date)) : 1;
      for (const book of this.books.values()) book.prevClose = book.last;
      this.model.reopen(Math.min(1.6, 1 + 0.15 * (nights - 1)));
      this.traded = session.date;
      logger.info(`Built-in market: opening bell for ${session.date}${session.earlyClose ? ' (early close)' : ''}`);
    }
    this.open = true;
    this.onStatus({ state: 'streaming' });
  }

  private closeSession(session: Session): void {
    this.open = false;
    // The day's last bar is complete. Write it now, not when the next session starts.
    for (const [symbol, book] of this.books) {
      const last = book.live[book.live.length - 1];
      if (last) this.unsaved.push({ symbol, bar: last });
    }
    logger.info(`Built-in market: closing bell for ${session.date}`);
    this.announceClosed();
    void this.save();
  }

  private announceClosed(): void {
    this.onStatus({ state: 'closed', detail: 'The practice market keeps US stock exchange hours and is closed now. Prices are from the last close.' });
  }

  /** Builds the Level 1 quote around a price. Stormier trading means a wider spread and thinner size. */
  private requote(book: Book, price: number, busy: number): void {
    const spread = Math.max(0.01, round2(price * 0.00008 * Math.min(3, Math.max(1, busy))));
    book.bid = round2(price - spread / 2);
    book.ask = round2(book.bid + spread);
    const depth = Math.max(1, Math.round(12 / Math.max(0.6, busy)));
    book.bidSize = 100 * (1 + Math.floor(Math.random() * depth * 2));
    book.askSize = 100 * (1 + Math.floor(Math.random() * depth * 2));
    book.last = Math.random() < 0.5 ? book.bid : book.ask;
    book.lastSize = Math.max(1, Math.round(busy * (20 + Math.random() * 380)));
  }

  private record(symbol: string, book: Book, now: number, busy: number): void {
    const minute = Math.floor(now / 60_000) * 60;
    const volume = Math.round(book.lastSize * (1 + busy));
    const current = book.live[book.live.length - 1];
    if (current && current.time === minute) {
      current.high = Math.max(current.high, book.last);
      current.low = Math.min(current.low, book.last);
      current.close = book.last;
      current.volume += volume;
      return;
    }
    if (current) this.unsaved.push({ symbol, bar: current });
    // A bar opens where the one before it closed, unless trading stopped in between (a new session, or a gap in running).
    const open = current && minute - current.time <= 120 ? current.close : book.last;
    book.live.push({ time: minute, open, high: Math.max(open, book.last), low: Math.min(open, book.last), close: book.last, volume });
    if (book.live.length > HISTORY_LIMIT) book.live.splice(0, book.live.length - HISTORY_LIMIT);
  }

  private toQuote(symbol: string, book: Book): Quote {
    return { symbol, bid: book.bid, ask: book.ask, bidSize: book.bidSize, askSize: book.askSize, last: book.last, lastSize: book.lastSize, prevClose: book.prevClose, ts: book.ts };
  }

  // --- memory ----------------------------------------------------------------
  // All of it is best effort: if the database is unavailable the market keeps
  // trading from memory and simply has less to remember next time.

  private async load(): Promise<SavedState | null> {
    try {
      const { rows } = await pool.query<{ state: SavedState }>('SELECT state FROM market_engine WHERE id');
      const state = rows[0]?.state;
      return state?.model && state.closes ? state : null;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Could not load the saved market state; starting fresh');
      return null;
    }
  }

  private async save(final = false): Promise<void> {
    const bars = this.unsaved;
    this.unsaved = [];
    // On shutdown the forming bars are written too, so a restart inside the same minute continues them.
    if (final) for (const [symbol, book] of this.books) if (book.live.length) bars.push({ symbol, bar: book.live[book.live.length - 1]! });

    const state: SavedState = {
      day: this.day,
      session: this.traded,
      hours: this.keepsHours ? 'exchange' : 'always',
      at: this.movedAt,
      model: this.model.snapshot(),
      closes: Object.fromEntries([...this.books].map(([symbol, book]) => [symbol, { prevClose: book.prevClose, last: book.last }])),
    };
    try {
      await pool.query(
        `INSERT INTO market_engine (id, state) VALUES (TRUE, $1)
         ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
        [JSON.stringify(state)],
      );
      await this.writeBars(bars);
    } catch (err) {
      this.unsaved.unshift(...bars.slice(0, 5_000)); // try again next time, without growing forever
      logger.warn({ err: (err as Error).message }, 'Could not save the market state');
    }
  }

  private async writeBars(bars: Array<{ symbol: string; bar: Bar }>): Promise<void> {
    for (let i = 0; i < bars.length; i += 2_000) {
      const chunk = bars.slice(i, i + 2_000);
      await pool.query(
        `INSERT INTO market_bars (symbol, time, open, high, low, close, volume)
         SELECT * FROM unnest($1::text[], $2::bigint[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[], $7::bigint[])
         ON CONFLICT (symbol, time) DO UPDATE
            SET high = GREATEST(market_bars.high, EXCLUDED.high), low = LEAST(market_bars.low, EXCLUDED.low),
                close = EXCLUDED.close, volume = GREATEST(market_bars.volume, EXCLUDED.volume)`,
        [
          chunk.map((b) => b.symbol),
          chunk.map((b) => b.bar.time),
          chunk.map((b) => b.bar.open),
          chunk.map((b) => b.bar.high),
          chunk.map((b) => b.bar.low),
          chunk.map((b) => b.bar.close),
          chunk.map((b) => Math.round(b.bar.volume)),
        ],
      );
    }
  }

  /** Bars from earlier runs. A symbol with almost none gets a plausible past drawn in, once. */
  private async loadHistory(symbol: string, book: Book): Promise<Bar[]> {
    await this.tidied;
    try {
      const { rows } = await pool.query<{ time: string; open: string; high: string; low: string; close: string; volume: string }>(
        'SELECT time, open, high, low, close, volume FROM market_bars WHERE symbol = $1 ORDER BY time DESC LIMIT $2',
        [symbol, HISTORY_LIMIT],
      );
      const stored = rows
        .map((r) => ({ time: Number(r.time), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) }))
        .reverse();
      if (stored.length >= 60) return stored;

      const backfill = this.backfill(book, stored[0]);
      await this.writeBars(backfill.map((bar) => ({ symbol, bar })));
      return [...backfill, ...stored];
    } catch (err) {
      logger.warn({ err: (err as Error).message, symbol }, 'Could not load chart history');
      return this.backfill(book, undefined);
    }
  }

  /**
   * Walks backwards from the earliest known price so the invented past joins
   * the real record. A market that keeps exchange hours gets bars for trading
   * minutes only, with a jump between one session's close and the next open.
   */
  private backfill(book: Book, earliest: Bar | undefined): Bar[] {
    const { listing } = book;
    const sigma = Math.hypot(0.00164 * listing.vol, 0.00066 * listing.beta, 0.0005);
    const overnight = Math.hypot(0.007 * listing.vol, 0.004 * listing.beta, 0.003);
    const end = earliest?.time ?? book.live[0]?.time ?? Math.floor(Date.now() / 60_000) * 60;
    const times = this.keepsHours
      ? sessionMinutesBefore(end, BACKFILL_SESSIONS)
      : Array.from({ length: BACKFILL_MINUTES }, (_, i) => end - (BACKFILL_MINUTES - i) * 60);

    const bars = new Array<Bar>(times.length);
    let price = earliest?.open ?? book.live[0]?.open ?? book.last;
    for (let i = times.length - 1; i >= 0; i--) {
      // Trading stopped between this bar and the one after it: the next session did not open where this one closed.
      if ((times[i + 1] ?? end) - times[i]! > 60) price /= Math.exp(overnight * gaussian());
      const close = round2(price);
      price /= Math.exp(sigma * gaussian() - 0.0024 * Math.log(listing.price / price));
      const open = round2(price);
      const wick = Math.abs(gaussian()) * sigma * 0.6;
      bars[i] = {
        time: times[i]!,
        open,
        close,
        high: round2(Math.max(open, close) * (1 + wick)),
        low: round2(Math.min(open, close) * (1 - wick)),
        volume: Math.round(2_000 + Math.random() * 30_000),
      };
    }
    return bars;
  }

  /** Removes bars drawn while the exchange was shut, left behind by a market that used to run around the clock. */
  private async dropOffHoursBars(): Promise<void> {
    // More sessions than the chart history is kept for, so nothing inside a session is ever touched.
    const sessions = sessionsBefore(new Date(), KEEP_BARS_DAYS + 4);
    const seconds = (at: Date) => Math.floor(at.getTime() / 1000);
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM market_bars bar
          WHERE NOT EXISTS (
            SELECT 1 FROM unnest($1::bigint[], $2::bigint[]) AS session(opens, closes)
             WHERE bar.time >= session.opens AND bar.time < session.closes)`,
        [sessions.map((s) => seconds(s.opensAt)), sessions.map((s) => seconds(s.closesAt))],
      );
      if (rowCount) logger.info(`Built-in market now keeps exchange hours: removed ${rowCount} chart bars from outside trading hours`);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Could not tidy the chart history');
    }
  }

  private async prune(): Promise<void> {
    try {
      await pool.query('DELETE FROM market_bars WHERE time < $1', [Math.floor(Date.now() / 1000) - KEEP_BARS_DAYS * 86_400]);
    } catch {
      // nothing to prune, or no database yet
    }
  }
}

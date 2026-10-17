import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedStatus, QuoteUpdate } from '../src/market/provider.js';
import type { PracticeMarketOptions, SimulatedProvider as SimulatedProviderClass } from '../src/market/simulatedProvider.js';
import { LISTINGS } from '../src/market/universe.js';
import { sessionOn } from '../src/market/usMarketHours.js';

// The market keeps its memory in Postgres on a best-effort basis; here it has none.
vi.mock('../src/db/pool.js', () => ({ pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } }));

// The provider logs through the app logger, which needs a valid configuration.
process.env.JWT_SECRET ??= 'unit-test-secret-unit-test-secret-0123456789';
process.env.LOG_LEVEL = 'silent';

let SimulatedProvider: typeof SimulatedProviderClass;
let sessionMinutesBefore: (end: number, sessions: number) => number[];
beforeAll(async () => {
  ({ SimulatedProvider, sessionMinutesBefore } = await import('../src/market/simulatedProvider.js'));
});

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const at = (iso: string) => Date.parse(iso);
/** True when an instant (ms) falls inside a US trading session. */
function inSession(instant: number): boolean {
  const ny = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
  const [year, month, day] = ny.split('-').map(Number) as [number, number, number];
  const session = sessionOn(year, month, day);
  return session !== null && instant >= session.opensAt.getTime() && instant < session.closesAt.getTime();
}

describe('the practice market keeping exchange hours', () => {
  let provider: SimulatedProviderClass;
  let updates: QuoteUpdate[];
  let statuses: FeedStatus[];

  async function open(now: string, options: PracticeMarketOptions = {}) {
    vi.setSystemTime(at(now));
    provider = new SimulatedProvider(options);
    updates = [];
    statuses = [];
    await provider.start(
      (update) => updates.push(update),
      (status) => statuses.push(status),
    );
    provider.subscribe(['AAPL', 'GME', 'SPY']);
  }
  const state = () => statuses[statuses.length - 1]?.state;
  /** The midpoint of every listed stock right now. */
  const snapshotAll = async () => {
    const prices: Record<string, number> = {};
    for (const { symbol } of LISTINGS) {
      const quote = (await provider.fetchSnapshot(symbol))!;
      prices[symbol] = (quote.bid + quote.ask) / 2;
    }
    return prices;
  };
  const latest = (symbol: string) => updates.filter((u) => u.symbol === symbol).at(-1)!;

  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    await provider.stop();
    vi.useRealTimers();
  });

  it('is closed on a Saturday: nothing moves, and prices are dated to the last close', async () => {
    await open('2026-10-10T09:00:00Z'); // Saturday afternoon in India
    expect(state()).toBe('closed');
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(updates).toHaveLength(0);
    const quote = (await provider.fetchSnapshot('AAPL'))!;
    expect(quote.bid).toBeGreaterThan(0);
    expect(quote.ts).toBe(at('2026-10-09T20:00:00Z'));
  });

  it('rings the closing bell: prices stop at 4:00 pm New York time and the feed says so', async () => {
    await open('2026-10-09T19:58:00Z'); // Friday, two minutes before the close
    expect(state()).toBe('streaming');
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(state()).toBe('closed');
    expect(updates.length).toBeGreaterThan(100);
    expect(Math.max(...updates.map((u) => u.ts))).toBeLessThan(at('2026-10-09T20:00:00Z'));
    expect(Math.max(...updates.map((u) => u.ts))).toBeGreaterThan(at('2026-10-09T19:59:58Z'));
  });

  it('opens on Monday away from Friday\'s close, and measures the day from that close', async () => {
    await open('2026-10-09T19:59:00Z');
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(state()).toBe('closed');
    const friday = Object.fromEntries(['AAPL', 'GME', 'SPY'].map((s) => [s, latest(s)]));
    const closes = await snapshotAll();
    updates.length = 0;

    // The weekend passes with the Mac asleep, then it wakes just before the open.
    vi.setSystemTime(at('2026-10-12T13:29:00Z'));
    await vi.advanceTimersByTimeAsync(30 * SECOND);
    expect(updates).toHaveLength(0);
    expect(state()).toBe('closed');

    await vi.advanceTimersByTimeAsync(40 * SECOND);
    expect(state()).toBe('streaming');
    expect(Math.min(...updates.map((u) => u.ts))).toBeGreaterThanOrEqual(at('2026-10-12T13:30:00Z'));
    for (const symbol of ['AAPL', 'GME', 'SPY']) {
      const first = updates.find((u) => u.symbol === symbol)!;
      // The reference for "today's change" is the last trade of the previous session.
      expect(first.prevClose).toBe(friday[symbol]!.last);
    }
    // Every stock opens somewhere new, none absurdly far. Any one of them can open almost flat by
    // chance, so this looks at all of them: most must have moved.
    const opens = await snapshotAll();
    const gaps = Object.keys(closes).map((symbol) => Math.abs(Math.log(opens[symbol]! / closes[symbol]!)));
    expect(Math.max(...gaps)).toBeLessThan(0.25);
    expect(gaps.filter((gap) => gap > 0.0005).length).toBeGreaterThan(gaps.length / 2);
  });

  it('gaps once per session: a restart in the middle of the day carries on from where it was', async () => {
    await open('2026-10-12T13:29:50Z');
    await vi.advanceTimersByTimeAsync(30 * SECOND);
    expect(state()).toBe('streaming');
    const reference = latest('AAPL').prevClose;
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(latest('AAPL').prevClose).toBe(reference);
    expect(statuses.filter((s) => s.state === 'streaming')).toHaveLength(1);
  });

  it('stays shut on a holiday and closes at 1:00 pm on an early-close day', async () => {
    await open('2026-11-26T15:00:00Z'); // Thanksgiving
    expect(state()).toBe('closed');
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(updates).toHaveLength(0);
    await provider.stop();

    await open('2026-11-27T17:59:00Z'); // the Friday after: trading stops at 1:00 pm New York time
    expect(state()).toBe('streaming');
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(state()).toBe('closed');
    expect(Math.max(...updates.map((u) => u.ts))).toBeLessThan(at('2026-11-27T18:00:00Z'));
  });

  it('draws chart history for trading minutes only', async () => {
    await open('2026-10-10T09:00:00Z');
    const bars = await provider.fetchBars('AAPL', '1Min', 6000);
    expect(bars).toHaveLength(5 * 390); // five full sessions
    expect(bars.every((bar) => inSession(bar.time * 1000))).toBe(true);
    expect(bars.at(-1)!.time * 1000).toBe(at('2026-10-09T19:59:00Z'));
    expect(bars[0]!.time * 1000).toBe(at('2026-10-05T13:30:00Z'));
    // Times only move forward, and prices stay on the same page from bar to bar.
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i]!.time).toBeGreaterThan(bars[i - 1]!.time);
      expect(Math.abs(Math.log(bars[i]!.open / bars[i - 1]!.close))).toBeLessThan(0.2);
    }
    // Inside a session a bar opens where the last one closed; between sessions it usually does not.
    const overnight = bars.filter((bar, i) => i > 0 && bar.time - bars[i - 1]!.time > 60);
    expect(overnight).toHaveLength(4);
    // Daily candles come out as one per session.
    expect(await provider.fetchBars('AAPL', '1Day', 100)).toHaveLength(5);
  });

  it('records new bars only while trading', async () => {
    await open('2026-10-09T19:57:10Z');
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    const bars = await provider.fetchBars('AAPL', '1Min', 6000);
    expect(bars.at(-1)!.time * 1000).toBe(at('2026-10-09T19:59:00Z'));
    expect(bars.every((bar) => inSession(bar.time * 1000))).toBe(true);
  });

  it('can be told to run around the clock instead', async () => {
    await open('2026-10-10T09:00:00Z', { hours: 'always' });
    expect(state()).toBe('streaming');
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(updates.length).toBeGreaterThan(100);
    expect((await provider.fetchBars('AAPL', '1Min', 6000)).length).toBeGreaterThan(2000);
  });

  it('follows the calendar it is given', async () => {
    // Really Saturday, but the calendar says Monday, just before the open.
    const started = at('2026-10-10T09:00:00Z');
    await open('2026-10-10T09:00:00Z', { calendar: () => at('2026-10-12T13:29:30Z') + (Date.now() - started) });
    expect(state()).toBe('closed');
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(state()).toBe('streaming');
    expect(updates.length).toBeGreaterThan(10);
  });
});

describe('sessionMinutesBefore', () => {
  it('stops at the given moment inside a session', () => {
    const minutes = sessionMinutesBefore(at('2026-10-09T13:40:00Z') / 1000, 2);
    expect(minutes).toHaveLength(390 + 10);
    expect(minutes[0]! * 1000).toBe(at('2026-10-08T13:30:00Z'));
    expect(minutes.at(-1)! * 1000).toBe(at('2026-10-09T13:39:00Z'));
  });
});

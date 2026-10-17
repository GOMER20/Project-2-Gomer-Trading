import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bookFor, houseQuote, houseSize, HOUSE_LEVELS, inBook, toCents } from '../src/hft/house.js';
import { HftMirror, type HftMirrorOptions, type OrderEventLike } from '../src/hft/hftMirror.js';
import type { OrderDto, Quote } from '../src/types.js';

const BINARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hft', 'bin', 'hft');

// --- The house's ladder ---------------------------------------------------------

describe('bookFor', () => {
  it('reaches two and a half times the price, from one cent up', () => {
    expect(bookFor('AAPL', 228.5)).toEqual({ symbol: 'AAPL', minPrice: 1, numLevels: 57_125, maxOrders: 4_096 });
  });

  it('never reaches less than $200, however cheap the stock', () => {
    expect(bookFor('F', 10.7).numLevels).toBe(20_000);
  });

  it('stops at the most prices one book can hold', () => {
    expect(bookFor('BRK', 5_000).numLevels).toBe(262_144);
  });

  it('gives a symbol with no price yet a book reaching $1,000', () => {
    expect(bookFor('NEW', 0).numLevels).toBe(100_000);
  });

  it('knows which prices a book takes', () => {
    const book = bookFor('F', 10.7);
    expect(inBook(book, 1)).toBe(true);
    expect(inBook(book, 20_000)).toBe(true);
    expect(inBook(book, 20_001)).toBe(false);
    expect(inBook(book, 0)).toBe(false);
  });
});

describe('houseQuote', () => {
  const quote = { symbol: 'AAPL', bid: 228.49, ask: 228.51, bidSize: 500, askSize: 3 };
  const book = bookFor('AAPL', 228.5);

  it('starts each side at the quote, with the size the quote shows', () => {
    const house = houseQuote(quote, book)!;
    expect(house.bids[0]).toEqual({ price: 22_849, quantity: 500 });
    // A size under 100 is in round lots.
    expect(house.asks[0]).toEqual({ price: 22_851, quantity: 300 });
  });

  it('adds a level every cent away from the touch, best first', () => {
    const house = houseQuote(quote, book)!;
    expect(house.bids).toHaveLength(HOUSE_LEVELS);
    expect(house.asks).toHaveLength(HOUSE_LEVELS);
    expect(house.bids.map((level) => level.price)).toEqual([22_849, 22_848, 22_847, 22_846, 22_845, 22_844, 22_843, 22_842, 22_841, 22_840]);
    expect(house.asks.map((level) => level.price)).toEqual([22_851, 22_852, 22_853, 22_854, 22_855, 22_856, 22_857, 22_858, 22_859, 22_860]);
  });

  it('shows between 200 and 1,500 shares, in round lots, at every level behind the touch', () => {
    const house = houseQuote(quote, book)!;
    for (const level of [...house.bids.slice(1), ...house.asks.slice(1)]) {
      expect(level.quantity).toBeGreaterThanOrEqual(200);
      expect(level.quantity).toBeLessThanOrEqual(1_500);
      expect(level.quantity % 100).toBe(0);
    }
  });

  it('keeps a price at the same size wherever the market has moved to', () => {
    const before = houseQuote(quote, book)!;
    const after = houseQuote({ ...quote, bid: 228.5, ask: 228.52 }, book)!;
    // 228.48 was the second bid and is now the third; 228.53 was the third offer and is now the second.
    expect(after.bids[2]).toEqual(before.bids[1]);
    expect(after.asks[1]).toEqual(before.asks[2]);
    expect(houseSize('AAPL', 'bid', 22_848)).toBe(before.bids[1]!.quantity);
    // The two sides of a price, and two symbols at a price, are sized separately.
    const sizes = new Set([houseSize('AAPL', 'bid', 22_848), houseSize('AAPL', 'ask', 22_848), houseSize('MSFT', 'bid', 22_848), houseSize('AAPL', 'bid', 22_847)]);
    expect(sizes.size).toBeGreaterThan(1);
  });

  it('shows one lot when the quote gives no size', () => {
    expect(houseQuote({ ...quote, bidSize: 0, askSize: 0 }, book)!.bids[0]!.quantity).toBe(100);
  });

  it('has nothing to say when a side is missing or the bid is not below the offer', () => {
    expect(houseQuote({ ...quote, bid: 0 }, book)).toBeNull();
    expect(houseQuote({ ...quote, ask: 0 }, book)).toBeNull();
    expect(houseQuote({ ...quote, bid: 228.51 }, book)).toBeNull();
    expect(houseQuote({ ...quote, bid: 228.6 }, book)).toBeNull();
    // Two prices that round to the same cent are no market either.
    expect(houseQuote({ ...quote, bid: 228.506, ask: 228.514 }, book)).toBeNull();
  });

  it('leaves out prices the book does not take', () => {
    const cheap = houseQuote({ symbol: 'PENNY', bid: 0.03, ask: 0.04, bidSize: 100, askSize: 100 }, bookFor('PENNY', 0.04))!;
    expect(cheap.bids.map((level) => level.price)).toEqual([3, 2, 1]);
    expect(cheap.asks).toHaveLength(HOUSE_LEVELS);

    const small = { symbol: 'TOP', minPrice: 1, numLevels: 1_005, maxOrders: 16 };
    const top = houseQuote({ symbol: 'TOP', bid: 10.0, ask: 10.02, bidSize: 100, askSize: 100 }, small)!;
    expect(top.asks.map((level) => level.price)).toEqual([1_002, 1_003, 1_004, 1_005]);
  });

  it('turns dollars into whole cents without drifting', () => {
    expect(toCents(228.49)).toBe(22_849);
    expect(toCents(0.07)).toBe(7);
    expect(toCents(1_234.565)).toBe(123_457);
  });
});

// --- The mirror, against the real HFT program -------------------------------------

class FakeMarket extends EventEmitter<{ quote: [Quote] }> {
  readonly quotes = new Map<string, Quote>();

  set(symbol: string, bid: number, ask: number, bidSize = 500, askSize = 400): void {
    const quote: Quote = { symbol, bid, ask, bidSize, askSize, last: (bid + ask) / 2, prevClose: null, ts: Date.now() };
    this.quotes.set(symbol, quote);
    this.emit('quote', quote);
  }
  getQuote(symbol: string): Quote | undefined {
    return this.quotes.get(symbol);
  }
  listSymbols(): Array<{ symbol: string; name: string }> {
    return [
      { symbol: 'AAPL', name: 'Apple' },
      { symbol: 'MSFT', name: 'Microsoft' },
      { symbol: 'TOOLONGNAME', name: 'More than eight characters' },
    ];
  }
}

let nextOrder = 0;
const order = (fields: Partial<OrderDto>): OrderDto => ({
  id: `order-${++nextOrder}`,
  portfolioId: 'portfolio',
  ticker: 'AAPL',
  type: 'LIMIT',
  side: 'BUY',
  status: 'OPEN',
  quantity: 100,
  limitPrice: null,
  stopPrice: null,
  triggeredAt: null,
  takeProfit: null,
  stopLoss: null,
  parentId: null,
  filledQuantity: 0,
  commission: 0,
  forcedBy: null,
  timeInForce: 'GTC',
  clientOrderId: null,
  arrivalPrice: null,
  fillPrice: null,
  realizedPnl: null,
  rejectReason: null,
  createdAt: new Date(Date.now() + 1_000).toISOString(),
  filledAt: null,
  ...fields,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const began = Date.now();
  while (!condition()) {
    if (Date.now() - began > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

describe.skipIf(!fs.existsSync(BINARY))('HftMirror', () => {
  const market = new FakeMarket();
  const engine = new EventEmitter<{ order: [OrderEventLike] }>();
  let mirror: HftMirror | undefined;
  let dataDir = '';

  async function start(options: Partial<HftMirrorOptions> = {}): Promise<HftMirror> {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gomer-hft-test-'));
    market.quotes.clear();
    market.set('AAPL', 228.49, 228.51);
    market.set('MSFT', 431.19, 431.21);
    mirror = new HftMirror({ mode: 'test', binary: BINARY, dataDir, market, engine, ...options });
    mirror.start();
    if (options.mode !== 'off' && (options.binary ?? BINARY) === BINARY) {
      await until(() => mirror!.status().state === 'running', 'HFT to start');
      await mirror.settled();
    }
    return mirror;
  }

  afterEach(async () => {
    await mirror?.stop();
    mirror = undefined;
    market.removeAllListeners();
    engine.removeAllListeners();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('starts HFT with a book for every symbol and the market already in each', async () => {
    const hft = await start();
    const status = hft.status();
    expect(status.mode).toBe('test');
    expect(status.symbols).toEqual(['AAPL', 'MSFT']); // the name longer than eight characters is left out
    expect(status.pid).toBeGreaterThan(0);
    expect(status.restarts).toBe(0);
    expect(status.counters.quotesSent).toBe(2);

    const depth = (await hft.depth('AAPL'))!;
    expect(depth.bids).toHaveLength(10);
    expect(depth.bids[0]).toEqual({ price: 22_849, quantity: 500 });
    expect(depth.asks[0]).toEqual({ price: 22_851, quantity: 400 });
    expect(await hft.depth('NOPE')).toBeNull();

    const stats = (await hft.stats())!;
    expect(stats.engine).toBe('HFT');
    expect(stats.quotes).toBe(2);
    expect(stats.resting_house_orders).toBe(40);
    expect(stats.symbols.map((symbol) => symbol.symbol)).toEqual(['AAPL', 'MSFT']);
  });

  it('puts the symbols it is given first', async () => {
    const hft = await start({ symbols: ['MSFT', 'SPY'] });
    expect(hft.status().symbols).toEqual(['MSFT', 'SPY', 'AAPL']);
  });

  it('follows the market as its prices move', async () => {
    const hft = await start();
    market.set('AAPL', 228.6, 228.63, 700, 900);
    await hft.settled();
    const depth = (await hft.depth('AAPL'))!;
    expect(depth.bids[0]).toEqual({ price: 22_860, quantity: 700 });
    expect(depth.asks[0]).toEqual({ price: 22_863, quantity: 900 });
    expect(hft.status().counters.quotesSent).toBe(3);
    expect((await hft.stats())!.trades).toBe(0); // the house never trades with itself
  });

  it('copies a market order, which trades against the house', async () => {
    const hft = await start();
    engine.emit('order', { order: order({ type: 'MARKET', side: 'BUY', quantity: 250, status: 'FILLED', filledQuantity: 250 }), fill: { quantity: 250, price: 228.52 } });
    await hft.settled();

    const counters = hft.status().counters;
    expect(counters.ordersSent).toBe(1);
    expect(counters.accepted).toBe(1);
    expect(counters.fills).toBe(1);
    expect(counters.sharesFilled).toBe(250);
    expect(counters.exchangeFills).toBe(1);
    expect(counters.exchangeSharesFilled).toBe(250);
    expect((await hft.depth('AAPL'))!.asks[0]).toEqual({ price: 22_851, quantity: 150 });
    const stats = (await hft.stats())!;
    expect(stats.orders).toBe(1);
    expect(stats.trades).toBe(1);
    expect(stats.shares).toBe(250);
    expect(stats.order_time.count).toBe(1);
  });

  it('rests a limit order in HFT and takes it out again when the exchange cancels it', async () => {
    const hft = await start();
    const working = order({ type: 'LIMIT', side: 'BUY', limitPrice: 228.5, quantity: 70 });
    engine.emit('order', { order: working });
    await hft.settled();
    expect((await hft.depth('AAPL'))!.bids[0]).toEqual({ price: 22_850, quantity: 70 }); // inside the spread

    // More news of the same order does not send it again.
    engine.emit('order', { order: working });
    await hft.settled();
    expect(hft.status().counters.ordersSent).toBe(1);

    engine.emit('order', { order: { ...working, status: 'CANCELLED' } });
    await hft.settled();
    expect((await hft.depth('AAPL'))!.bids[0]).toEqual({ price: 22_849, quantity: 500 });
    expect(hft.status().counters.cancelsSent).toBe(1);
    expect((await hft.stats())!.cancelled).toBe(1);

    // Nor does anything said about it after it has finished.
    engine.emit('order', { order: { ...working, status: 'CANCELLED' } });
    await hft.settled();
    expect(hft.status().counters.ordersSent).toBe(1);
    expect(hft.status().counters.cancelsSent).toBe(1);
  });

  it('takes a resting copy out when the exchange fills the order it stands for', async () => {
    const hft = await start();
    const working = order({ type: 'LIMIT', side: 'SELL', limitPrice: 228.6, quantity: 40 });
    engine.emit('order', { order: working });
    await hft.settled();
    expect((await hft.stats())!.resting_client_orders).toBe(1);

    engine.emit('order', { order: { ...working, status: 'FILLED', filledQuantity: 40 }, fill: { quantity: 40, price: 228.6 } });
    await hft.settled();
    expect((await hft.stats())!.resting_client_orders).toBe(0);
    expect(hft.status().counters.cancelsSent).toBe(1);
  });

  it('does not try to cancel a copy that HFT has already traded away', async () => {
    const hft = await start();
    const working = order({ type: 'LIMIT', side: 'BUY', limitPrice: 228.5, quantity: 30 });
    engine.emit('order', { order: working });
    await hft.settled();
    // The market falls through the resting bid: the house's new offers fill it in HFT.
    market.set('AAPL', 228.4, 228.42);
    await hft.settled();
    expect(hft.status().counters.fills).toBe(1);
    expect((await hft.stats())!.resting_client_orders).toBe(0);

    engine.emit('order', { order: { ...working, status: 'FILLED', filledQuantity: 30 }, fill: { quantity: 30, price: 228.5 } });
    await hft.settled();
    expect(hft.status().counters.cancelsSent).toBe(0);
    expect((await hft.stats())!.cancel_rejected).toBe(0);
  });

  it('cancels a copy that finished at the exchange before HFT had answered for it', async () => {
    const hft = await start();
    const working = order({ type: 'LIMIT', side: 'BUY', limitPrice: 228.3, quantity: 10 });
    // Both events before HFT can have said anything.
    engine.emit('order', { order: working });
    engine.emit('order', { order: { ...working, status: 'CANCELLED' } });
    await hft.settled(); // HFT's Accepted arrives; the mirror cancels
    await hft.settled();
    expect(hft.status().counters.cancelsSent).toBe(1);
    expect((await hft.stats())!.resting_client_orders).toBe(0);
  });

  it('holds a stop order back until it is triggered', async () => {
    const hft = await start();
    const stop = order({ type: 'STOP', side: 'SELL', stopPrice: 228.0, quantity: 60 });
    engine.emit('order', { order: stop });
    await hft.settled();
    expect(hft.status().counters.ordersSent).toBe(0);

    engine.emit('order', { order: { ...stop, triggeredAt: new Date().toISOString(), status: 'FILLED', filledQuantity: 60 }, fill: { quantity: 60, price: 228.48 } });
    await hft.settled();
    expect(hft.status().counters.ordersSent).toBe(1);
    expect(hft.status().counters.sharesFilled).toBe(60); // as a market order, against the house's bids
  });

  it('sends immediate-or-cancel and fill-or-kill orders as what they are', async () => {
    const hft = await start();
    // More than the house offers at this price: an IOC takes what is there, a FOK takes nothing.
    engine.emit('order', { order: order({ side: 'BUY', limitPrice: 228.51, quantity: 1_000, timeInForce: 'IOC', status: 'CANCELLED', filledQuantity: 400 }) });
    await hft.settled();
    expect(hft.status().counters.sharesFilled).toBe(400);
    market.set('AAPL', 228.49, 228.51); // the house offers 400 again
    await hft.settled();
    engine.emit('order', { order: order({ side: 'BUY', limitPrice: 228.51, quantity: 1_000, timeInForce: 'FOK', status: 'CANCELLED' }) });
    await hft.settled();
    expect(hft.status().counters.sharesFilled).toBe(400);
    expect((await hft.stats())!.resting_client_orders).toBe(0);
  });

  it('leaves out what was never in the market or cannot be in its books', async () => {
    const hft = await start();
    engine.emit('order', { order: order({ status: 'REJECTED', rejectReason: 'Not enough buying power' }) });
    engine.emit('order', { order: order({ ticker: 'ZZZZ', type: 'MARKET' }) }); // no book for it
    engine.emit('order', { order: order({ limitPrice: 5_000 }) }); // above the book's prices
    engine.emit('order', { order: order({ type: 'MARKET', createdAt: new Date(Date.now() - 3_600_000).toISOString(), status: 'FILLED' }) }); // older than HFT's session
    await hft.settled();
    const counters = hft.status().counters;
    expect(counters.ordersSent).toBe(0);
    expect(counters.ordersNotCopied).toBe(3);
    expect((await hft.stats())!.orders).toBe(0);
  });

  it('starts HFT again if it dies, and the exchange is not disturbed meanwhile', async () => {
    const hft = await start();
    const first = hft.status().pid!;
    process.kill(first, 'SIGKILL');
    await until(() => hft.status().state === 'down', 'the mirror to notice');
    expect(hft.status().detail).toContain('SIGKILL');
    expect(await hft.stats()).toBeNull();
    expect(await hft.depth('AAPL')).toBeNull();

    // Orders and prices while it is down go nowhere, quietly.
    expect(() => engine.emit('order', { order: order({ type: 'MARKET' }) })).not.toThrow();
    market.set('AAPL', 228.7, 228.72);

    await until(() => hft.status().state === 'running', 'HFT to come back');
    expect(hft.status().restarts).toBe(1);
    expect(hft.status().pid).not.toBe(first);
    await hft.settled();
    // A new session: empty books, then the market as it is now.
    expect((await hft.depth('AAPL'))!.bids[0]!.price).toBe(22_870);
    expect((await hft.stats())!.orders).toBe(0);
  });

  it('gives each market day a session of its own, with books sized for that day', async () => {
    let today: string | null = null; // the market is shut
    const hft = await start({ marketSession: () => today, sessionCheckMs: 20 });
    expect(hft.status().marketSession).toBeNull();
    const firstPid = hft.status().pid;
    engine.emit('order', { order: order({ type: 'MARKET', quantity: 50, status: 'FILLED' }), fill: { quantity: 50, price: 228.52 } });
    await hft.settled();
    expect(hft.status().counters.ordersSent).toBe(1);

    // Overnight the price has gone far beyond what yesterday's book could hold.
    market.set('AAPL', 899.99, 900.01);
    await hft.settled();
    expect((await hft.depth('AAPL'))!.asks).toHaveLength(0);

    await sleep(1_050); // sessions' files are named to the second; real ones are a day apart
    today = '2026-10-12'; // the opening bell
    await until(() => hft.status().marketSession === '2026-10-12' && hft.status().state === 'running', 'the new session');
    await hft.settled();
    const stats = (await hft.stats())!;
    expect(stats.orders).toBe(0); // yesterday's numbers stayed with yesterday
    expect(hft.status().counters.ordersSent).toBe(0);
    expect(hft.status().pid).not.toBe(firstPid);
    expect(hft.status().restarts).toBe(0); // started again on purpose: not a failure
    expect((await hft.depth('AAPL'))!.asks[0]).toEqual({ price: 90_001, quantity: 400 });

    // The first session's recording was finished, and its statistics kept, when it ended.
    expect(fs.readdirSync(dataDir).filter((name) => name.endsWith('.rec'))).toHaveLength(2);
    const history = fs.readdirSync(path.join(dataDir, 'history'));
    expect(history.filter((name) => name.endsWith('.stats.json'))).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'history', history.find((name) => name.endsWith('.stats.json'))!), 'utf8')).orders).toBe(1);

    // The same day does not start another.
    await sleep(100);
    expect(hft.status().marketSession).toBe('2026-10-12');
    expect((await hft.stats())!.orders).toBe(0);
  });

  it('keeps to its disk budget: a size limit on each recording, and only the newest sessions kept', async () => {
    let today = 'day-0';
    const hft = await start({ marketSession: () => today, sessionCheckMs: 20, recordLimitMb: 3, keepSessions: 2 });
    expect(hft.status().disk).toMatchObject({ recordLimitMb: 3, keepSessions: 2, budgetMb: 6, notRecording: false });
    // HFT was given the limit: 3 MB of 32-byte commands.
    expect((await hft.stats())!.recording_limit).toBe((3 * 1024 * 1024) / 32);

    // Five market days. Each ends one session and begins the next.
    for (let day = 1; day <= 5; day++) {
      engine.emit('order', { order: order({ type: 'MARKET', quantity: day, status: 'FILLED' }) });
      await hft.settled();
      await sleep(1_050); // sessions' files are named to the second; real ones are a day apart
      const before = hft.status().pid;
      today = `day-${day}`;
      await until(() => hft.status().state === 'running' && hft.status().pid !== before, `day ${day} to begin`);
      await hft.settled();
    }

    // Recordings: only the newest two. Statistics: every session that has ended.
    const recordings = fs.readdirSync(dataDir).filter((name) => name.endsWith('.rec'));
    expect(recordings).toHaveLength(2);
    const history = fs.readdirSync(path.join(dataDir, 'history')).filter((name) => name.endsWith('.stats.json'));
    expect(history).toHaveLength(5);
    const shares = history.sort().map((name) => JSON.parse(fs.readFileSync(path.join(dataDir, 'history', name), 'utf8')).shares);
    expect(shares).toEqual([1, 2, 3, 4, 5]);
    expect(hft.status().disk.usedMb).toBeLessThanOrEqual(hft.status().disk.budgetMb);
  }, 30_000);

  it('does not record a session that starts with the disk nearly full', async () => {
    const hft = await start({ freeDiskBytes: () => 800 * 1024 * 1024, lowDiskBytes: 1024 ** 3 });
    expect(hft.status().disk.notRecording).toBe(true);
    // Room for one megabyte and no more; HFT itself runs and measures as usual.
    expect((await hft.stats())!.recording_limit).toBe((1024 * 1024) / 32);
    engine.emit('order', { order: order({ type: 'MARKET', quantity: 10, status: 'FILLED' }) });
    await hft.settled();
    expect((await hft.stats())!.trades).toBe(1);
  });

  it('records as usual when there is plenty of room, by default 250 MB a session and two sessions', async () => {
    const hft = await start({ freeDiskBytes: () => 50 * 1024 ** 3 });
    expect(hft.status().disk).toMatchObject({ recordLimitMb: 250, keepSessions: 2, budgetMb: 500, notRecording: false });
    expect((await hft.stats())!.recording_limit).toBe((250 * 1024 * 1024) / 32);
  });

  it('leaves its statistics and a recording behind when it stops', async () => {
    const hft = await start();
    engine.emit('order', { order: order({ type: 'MARKET', side: 'SELL', quantity: 100, status: 'FILLED' }) });
    await hft.settled();
    await hft.stop();
    expect(hft.status().state).toBe('down');

    const written = JSON.parse(fs.readFileSync(path.join(dataDir, 'hft-stats.json'), 'utf8'));
    expect(written.engine).toBe('HFT');
    expect(written.trades).toBe(1);
    expect(fs.readFileSync(path.join(dataDir, 'hft-stats.txt'), 'utf8')).toContain('HFT session 1');
    expect(fs.readdirSync(dataDir).filter((name) => name.endsWith('.rec'))).toHaveLength(1);
    expect(fs.existsSync(path.join(dataDir, 'hft.sock'))).toBe(false);
    mirror = undefined;
  });

  it('does nothing at all when it is switched off', async () => {
    const hft = await start({ mode: 'off' });
    expect(hft.status().state).toBe('off');
    expect(hft.status().pid).toBeNull();
    engine.emit('order', { order: order({ type: 'MARKET' }) });
    expect(await hft.stats()).toBeNull();
    expect(market.listenerCount('quote')).toBe(0);
    expect(engine.listenerCount('order')).toBe(0);
  });

  it('says so, and stays out of the way, when the HFT program is missing', async () => {
    const hft = await start({ binary: path.join(os.tmpdir(), 'no-such-hft-program') });
    expect(hft.status().state).toBe('unavailable');
    expect(hft.status().detail).toContain('npm run hft:build');
    expect(await hft.stats()).toBeNull();
    expect(engine.listenerCount('order')).toBe(0);
  });
});

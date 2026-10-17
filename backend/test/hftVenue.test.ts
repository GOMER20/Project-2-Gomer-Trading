import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bookFor } from '../src/hft/house.js';
import { HftVenue, HftVenues, orderDelay, venueLadder, type VenueHandlers, type VenueOrder } from '../src/hft/hftVenue.js';
import { buildBook } from '../src/market/depth.js';
import type { Quote } from '../src/types.js';

const BINARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hft', 'bin', 'hft');

// --- The order-delay model and the house's ladder -------------------------------

describe('orderDelay', () => {
  it('is never less than asked for, and at most half as much again', () => {
    expect(orderDelay(0, () => 0.9)).toBe(0);
    expect(orderDelay(10, () => 0)).toBe(10);
    expect(orderDelay(10, () => 0.999)).toBeCloseTo(14.995);
  });
});

describe('venueLadder', () => {
  const quote: Quote = { symbol: 'F', bid: 10.69, ask: 10.7, bidSize: 500, askSize: 300, last: 10.7, lastSize: 100, prevClose: null, ts: 1_791_811_800_000 };

  it('is the modelled book, ten levels a side, in cents', () => {
    const ladder = venueLadder(quote, bookFor('F', 10.7))!;
    const depth = buildBook(quote, { bids: 0, asks: 0 }, quote.ts);
    expect(ladder.bids).toEqual(depth.bids.map((level) => ({ price: Math.round(level.price * 100), quantity: level.size })));
    expect(ladder.asks[0]).toEqual({ price: 1070, quantity: 300 });
    expect(ladder.bids).toHaveLength(10);
  });

  it('is nothing for a quote that is not a market', () => {
    expect(venueLadder({ ...quote, bid: 10.7, ask: 10.7 }, bookFor('F', 10.7))).toBeNull();
    expect(venueLadder({ ...quote, bid: 0 }, bookFor('F', 10.7))).toBeNull();
  });
});

describe('HftVenues', () => {
  it('gives each competition a venue of its own, up to a limit', () => {
    const made: string[] = [];
    const venues = new HftVenues((id) => {
      made.push(id);
      return new HftVenue({ binary: '/nonexistent', dataDir: os.tmpdir(), market: new FakeMarket(), recordLimitMb: 1, keepSessions: 1 });
    }, 2);
    const a = venues.for('a');
    expect(venues.for('a')).toBe(a);
    expect(venues.for('b')).not.toBe(a);
    expect(venues.for('c')).toBeNull();
    expect(made).toEqual(['a', 'b']);
  });
});

// --- Against the real HFT ----------------------------------------------------------

class FakeMarket extends EventEmitter<{ quote: [Quote] }> {
  readonly quotes = new Map<string, Quote>();
  private ts = 1_791_811_800_000;

  getQuote(symbol: string): Quote | undefined {
    return this.quotes.get(symbol);
  }
  listSymbols(): Array<{ symbol: string; name: string }> {
    return [{ symbol: 'F', name: 'Ford' }];
  }
  /** A new quote for F; `last` and `lastSize` are the print, if they differ from the previous one. */
  tick(bid: number, ask: number, last: number, lastSize: number, sizes: [number, number] = [500, 500]): void {
    this.ts += 500;
    const quote: Quote = { symbol: 'F', bid, ask, bidSize: sizes[0], askSize: sizes[1], last, lastSize, prevClose: null, ts: this.ts };
    this.quotes.set('F', quote);
    this.emit('quote', quote);
  }
}

interface Heard {
  fills: Array<{ orderId: string; price: number; quantity: number; maker: boolean }>;
  ended: Array<{ orderId: string; why: string }>;
}

const waitFor = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const began = Date.now();
  while (!check()) {
    if (Date.now() - began > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const buy = (id: string, limit: number | null, quantity = 100, timeInForce: VenueOrder['timeInForce'] = 'GTC'): VenueOrder => ({ id, ticker: 'F', side: 'BUY', quantity, limit, timeInForce });

describe.skipIf(!fs.existsSync(BINARY))('HftVenue', () => {
  let venue: HftVenue | null = null;
  let dir = '';

  afterEach(async () => {
    await venue?.stop();
    venue = null;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const open = async (): Promise<{ market: FakeMarket; heard: Heard; venue: HftVenue }> => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venue-test-'));
    const market = new FakeMarket();
    market.tick(10.69, 10.7, 10.69, 100); // the market is there before the venue starts
    const heard: Heard = { fills: [], ended: [] };
    const handlers: VenueHandlers = {
      fill: (orderId, price, quantity, maker) => heard.fills.push({ orderId, price, quantity, maker }),
      ended: (orderId, why) => heard.ended.push({ orderId, why }),
    };
    venue = new HftVenue({ binary: BINARY, dataDir: dir, market, recordLimitMb: 1, keepSessions: 1 });
    venue.bind(handlers);
    venue.ensureRunning();
    await waitFor(() => venue!.status().state === 'running');
    return { market, heard, venue };
  };

  it('puts an order behind the house at its price, and the street reaches it only after the house', async () => {
    const { market, heard, venue } = await open();
    venue.submit(buy('a', 10.69), 0);
    await venue.settled();

    market.tick(10.69, 10.7, 10.69, 300); // someone sells 300: all of it to the house ahead
    await venue.settled();
    expect(heard.fills).toEqual([]);

    market.tick(10.69, 10.7, 10.69, 250); // the house tops up behind us; 200 of the old 500 are still ahead
    await venue.settled();
    expect(heard.fills).toEqual([{ orderId: 'a', price: 10.69, quantity: 50, maker: true }]);

    market.tick(10.69, 10.7, 10.69, 120);
    await venue.settled();
    expect(heard.fills.map((fill) => fill.quantity)).toEqual([50, 50]);
    expect(venue.has('a')).toBe(false);
    expect(venue.status().counters.printSharesToTraders).toBe(100);
  });

  it('fills a resting order at its own price when the market moves through it', async () => {
    const { market, heard, venue } = await open();
    venue.submit(buy('a', 10.69), 0);
    await venue.settled();
    market.tick(10.68, 10.69, 10.68, 100); // the offer falls to our bid
    await venue.settled();
    expect(heard.fills).toEqual([{ orderId: 'a', price: 10.69, quantity: 100, maker: true }]);
  });

  it('takes the house offer when it arrives marketable', async () => {
    const { heard, venue } = await open();
    venue.submit(buy('a', 10.7), 0);
    await venue.settled();
    expect(heard.fills).toEqual([{ orderId: 'a', price: 10.7, quantity: 100, maker: false }]);
    expect(heard.ended).toEqual([]);
  });

  it('cancels what an immediate-or-cancel order could not trade, after its fills', async () => {
    const { heard, venue } = await open();
    venue.submit(buy('a', 10.7, 100_000, 'IOC'), 0);
    await venue.settled();
    expect(heard.fills).toEqual([{ orderId: 'a', price: 10.7, quantity: 500, maker: false }]);
    expect(heard.ended).toEqual([{ orderId: 'a', why: 'unfilled' }]);
  });

  it('cancels a resting order, and one that has not reached the book yet', async () => {
    const { heard, venue } = await open();
    venue.submit(buy('a', 10.6), 0);
    await venue.settled();
    venue.cancel('a', 0);
    await venue.settled();
    venue.submit(buy('b', 10.6), 5_000);
    venue.cancel('b', 0);
    expect(heard.ended).toEqual([
      { orderId: 'a', why: 'cancelled' },
      { orderId: 'b', why: 'cancelled' },
    ]);
    expect(venue.status().workingOrders).toBe(0);
  });

  it('refuses a price outside its book', async () => {
    const { heard, venue } = await open();
    venue.submit(buy('a', 500), 0);
    expect(heard.ended).toEqual([{ orderId: 'a', why: 'refused' }]);
  });

  it('says nothing more about an order the engine has finished with', async () => {
    const { market, heard, venue } = await open();
    venue.submit(buy('a', 10.69), 0);
    await venue.settled();
    venue.forget('a');
    market.tick(10.68, 10.69, 10.68, 100);
    await venue.settled();
    expect(heard.fills).toEqual([]);
    expect(heard.ended).toEqual([]);
  });

  it('delivers an order only after its delay', async () => {
    const { market, heard, venue } = await open();
    venue.submit(buy('a', 10.69), 300);
    market.tick(10.68, 10.69, 10.68, 100); // would have filled it, had it been there
    await venue.settled();
    expect(heard.fills).toEqual([]);
    market.tick(10.69, 10.7, 10.7, 100);
    await waitFor(() => !venue.has('a') || venue.status().counters.orders > 0, 2_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    market.tick(10.68, 10.69, 10.68, 200);
    await venue.settled();
    expect(heard.fills).toEqual([{ orderId: 'a', price: 10.69, quantity: 100, maker: true }]);
  });

  it('starts HFT again after it stops, and sends it the orders still working', async () => {
    const { market, heard, venue } = await open();
    venue.submit(buy('a', 10.69), 0);
    await venue.settled();
    process.kill(venue.status().pid!, 'SIGKILL');
    await waitFor(() => venue.status().state === 'down');
    await waitFor(() => venue.status().state === 'running', 10_000);
    await venue.settled();
    expect(venue.status().restarts).toBe(1);
    market.tick(10.68, 10.69, 10.68, 100);
    await venue.settled();
    expect(heard.fills).toEqual([{ orderId: 'a', price: 10.69, quantity: 100, maker: true }]);
  }, 20_000);
});

import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { averagePrice, buildBook, DEPTH_LEVELS, LiquidityLedger, provideLiquidity, sharesIn, shownDepth, takeLiquidity, type DepthBook } from '../src/market/depth.js';

const quote = { symbol: 'TEST', bid: 99.98, ask: 100.02, bidSize: 500, askSize: 300 };
const NOW = 1_700_000_000_000;

/** A book with known sizes, so the arithmetic in each test can be checked by hand. */
const book: DepthBook = {
  symbol: 'TEST',
  ts: NOW,
  asks: [
    { price: 100.02, size: 300 },
    { price: 100.03, size: 500 },
    { price: 100.04, size: 1000 },
  ],
  bids: [
    { price: 99.98, size: 400 },
    { price: 99.97, size: 600 },
    { price: 99.96, size: 900 },
  ],
};
const prices = (pieces: ReturnType<typeof takeLiquidity>) => pieces.map((p) => [p.price.toNumber(), p.quantity]);

describe('buildBook', () => {
  it('starts each side at the quote, with the size the quote shows', () => {
    const built = buildBook(quote, undefined, NOW);
    expect(built.asks[0]).toEqual({ price: 100.02, size: 300 });
    expect(built.bids[0]).toEqual({ price: 99.98, size: 500 });
  });

  it('adds a level every cent away from the touch', () => {
    const built = buildBook(quote, undefined, NOW);
    expect(built.asks).toHaveLength(DEPTH_LEVELS);
    expect(built.bids).toHaveLength(DEPTH_LEVELS);
    expect(built.asks.map((l) => l.price).slice(0, 4)).toEqual([100.02, 100.03, 100.04, 100.05]);
    expect(built.bids.map((l) => l.price).slice(0, 4)).toEqual([99.98, 99.97, 99.96, 99.95]);
  });

  it('gives every modelled level a round lot of at least 100 shares', () => {
    for (const level of [...buildBook(quote, undefined, NOW).asks, ...buildBook(quote, undefined, NOW).bids].slice(1)) {
      expect(level.size).toBeGreaterThanOrEqual(100);
      expect(level.size % 100).toBe(0);
    }
  });

  it('shows the same book for the same quote until the sizes are reshuffled', () => {
    expect(buildBook(quote, undefined, NOW)).toEqual({ ...buildBook(quote, undefined, NOW + 1000), ts: NOW });
    const later = buildBook(quote, undefined, NOW + 10 * 60_000);
    expect(later.asks.map((l) => l.size)).not.toEqual(buildBook(quote, undefined, NOW).asks.map((l) => l.size));
  });

  it('reads a size under 100 as round lots', () => {
    expect(buildBook({ ...quote, askSize: 3 }, undefined, NOW).asks[0]!.size).toBe(300);
  });

  it('has nothing on a side the quote does not show', () => {
    expect(buildBook({ ...quote, ask: 0, askSize: 0 }, undefined, NOW).asks).toEqual([]);
  });

  it('takes recently traded shares off the front of the book, and hides emptied levels', () => {
    const full = buildBook(quote, undefined, NOW);
    const depleted = buildBook(quote, { bids: 0, asks: 300 + full.asks[1]!.size + 50 }, NOW);
    expect(depleted.asks[0]!.size).toBe(0);
    expect(depleted.asks[1]!.size).toBe(0);
    expect(depleted.asks[2]!.size).toBe(full.asks[2]!.size - 50);
    expect(depleted.bids).toEqual(full.bids);
    expect(shownDepth(depleted).asks[0]!.price).toBe(100.04);
  });
});

describe('takeLiquidity', () => {
  it('fills a small market order at the touch plus slippage', () => {
    expect(prices(takeLiquidity('BUY', 100, null, book, 0.01))).toEqual([[100.03, 100]]);
    expect(prices(takeLiquidity('SELL', 100, null, book, 0.01))).toEqual([[99.97, 100]]);
  });

  it('walks a large order through the book, each level at a worse price', () => {
    expect(prices(takeLiquidity('BUY', 1000, null, book, 0.01))).toEqual([
      [100.03, 300],
      [100.04, 500],
      [100.05, 200],
    ]);
    expect(prices(takeLiquidity('SELL', 1200, null, book, 0.01))).toEqual([
      [99.97, 400],
      [99.96, 600],
      [99.95, 200],
    ]);
  });

  it('gives only what the book holds: the rest of the order has to wait', () => {
    const pieces = takeLiquidity('BUY', 5000, null, book, 0.01);
    expect(sharesIn(pieces)).toBe(1800);
  });

  it('stops a limit order at its limit', () => {
    const pieces = takeLiquidity('BUY', 5000, new Decimal(100.03), book, 0.01);
    // 100.02 + slippage is 100.03; the 100.03 level plus slippage would be 100.04, so it is capped at the limit.
    expect(prices(pieces)).toEqual([[100.03, 800]]);
    expect(takeLiquidity('BUY', 100, new Decimal(100.01), book, 0.01)).toEqual([]);
    expect(prices(takeLiquidity('SELL', 5000, new Decimal(99.97), book, 0.01))).toEqual([[99.97, 1000]]);
  });

  it('never moves a limit order past its limit through slippage', () => {
    expect(prices(takeLiquidity('BUY', 100, new Decimal(100.02), book, 0.01))).toEqual([[100.02, 100]]);
  });

  it('skips levels that have been emptied', () => {
    const thin = { ...book, asks: [{ price: 100.02, size: 0 }, ...book.asks.slice(1)] };
    expect(prices(takeLiquidity('BUY', 100, null, thin, 0.01))).toEqual([[100.04, 100]]);
  });

  it('averages the pieces by size', () => {
    const pieces = takeLiquidity('BUY', 1000, null, book, 0.01);
    expect(averagePrice(pieces).toNumber()).toBeCloseTo((100.03 * 300 + 100.04 * 500 + 100.05 * 200) / 1000, 10);
    expect(averagePrice([]).toNumber()).toBe(0);
  });
});

describe('provideLiquidity', () => {
  it('fills a resting order at its own price, for as much as the market offers there', () => {
    expect(prices(provideLiquidity('BUY', 1000, new Decimal(100.03), book))).toEqual([[100.03, 800]]);
    expect(prices(provideLiquidity('BUY', 200, new Decimal(100.03), book))).toEqual([[100.03, 200]]);
    expect(prices(provideLiquidity('SELL', 5000, new Decimal(99.97), book))).toEqual([[99.97, 1000]]);
  });

  it('gives nothing while the market has not reached the order', () => {
    expect(provideLiquidity('BUY', 100, new Decimal(100.01), book)).toEqual([]);
    expect(provideLiquidity('SELL', 100, new Decimal(99.99), book)).toEqual([]);
  });
});

describe('LiquidityLedger', () => {
  it('remembers what was taken, from the side it was taken from', () => {
    const ledger = new LiquidityLedger();
    ledger.consume('TEST', 'BUY', 500, NOW);
    ledger.consume('TEST', 'SELL', 200, NOW);
    expect(ledger.outstanding('TEST', NOW)).toEqual({ bids: 200, asks: 500 });
    expect(ledger.outstanding('OTHER', NOW)).toEqual({ bids: 0, asks: 0 });
  });

  it('lets the book refill: half is back after one half-life, nearly all after a minute', () => {
    const ledger = new LiquidityLedger();
    ledger.consume('TEST', 'BUY', 1000, NOW);
    expect(ledger.outstanding('TEST', NOW + 4000).asks).toBeCloseTo(500, 5);
    expect(ledger.outstanding('TEST', NOW + 60_000)).toEqual({ bids: 0, asks: 0 });
  });

  it('adds new trades to what is still outstanding', () => {
    const ledger = new LiquidityLedger();
    ledger.consume('TEST', 'BUY', 1000, NOW);
    ledger.consume('TEST', 'BUY', 1000, NOW + 4000);
    expect(ledger.outstanding('TEST', NOW + 4000).asks).toBeCloseTo(1500, 5);
  });

  it('means an order sliced into pieces gets no better a price than the whole', () => {
    const ledger = new LiquidityLedger();
    const whole = averagePrice(takeLiquidity('BUY', 900, null, buildBook(quote, ledger.outstanding('TEST', NOW), NOW), 0.01));
    let cost = new Decimal(0);
    for (let i = 0; i < 9; i++) {
      const pieces = takeLiquidity('BUY', 100, null, buildBook(quote, ledger.outstanding('TEST', NOW), NOW), 0.01);
      cost = cost.plus(averagePrice(pieces).mul(100));
      ledger.consume('TEST', 'BUY', 100, NOW);
    }
    expect(cost.div(900).toNumber()).toBeCloseTo(whole.toNumber(), 6);
  });
});

import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { isQuoteFresh, marketableLimitPrice, marketOrderPrice, restingOrderTriggered, stopTriggered, bracketProblem } from '../src/engine/pricing.js';

const quote = { bid: 99.98, ask: 100.02 };
const SLIPPAGE = 0.01;

describe('marketOrderPrice', () => {
  it('buys at the ask plus slippage', () => {
    expect(marketOrderPrice('BUY', quote, SLIPPAGE)?.toString()).toBe('100.03');
  });

  it('sells at the bid minus slippage', () => {
    expect(marketOrderPrice('SELL', quote, SLIPPAGE)?.toString()).toBe('99.97');
  });

  it('returns null when that side of the book is empty', () => {
    expect(marketOrderPrice('BUY', { bid: 99.98, ask: 0 }, SLIPPAGE)).toBeNull();
    expect(marketOrderPrice('SELL', { bid: 0, ask: 100.02 }, SLIPPAGE)).toBeNull();
  });

  it('never sells below one cent', () => {
    expect(marketOrderPrice('SELL', { bid: 0.01, ask: 0.02 }, SLIPPAGE)?.toString()).toBe('0.01');
  });
});

describe('marketableLimitPrice', () => {
  it('rests a buy limit below the ask', () => {
    expect(marketableLimitPrice('BUY', new Decimal('100.01'), quote, SLIPPAGE)).toBeNull();
  });

  it('executes a crossing buy with slippage, capped at the limit', () => {
    expect(marketableLimitPrice('BUY', new Decimal('100.50'), quote, SLIPPAGE)?.toString()).toBe('100.03');
    expect(marketableLimitPrice('BUY', new Decimal('100.02'), quote, SLIPPAGE)?.toString()).toBe('100.02');
  });

  it('rests a sell limit above the bid', () => {
    expect(marketableLimitPrice('SELL', new Decimal('99.99'), quote, SLIPPAGE)).toBeNull();
  });

  it('executes a crossing sell with slippage, floored at the limit', () => {
    expect(marketableLimitPrice('SELL', new Decimal('99.00'), quote, SLIPPAGE)?.toString()).toBe('99.97');
    expect(marketableLimitPrice('SELL', new Decimal('99.98'), quote, SLIPPAGE)?.toString()).toBe('99.98');
  });
});

describe('restingOrderTriggered', () => {
  it('triggers a buy when the ask falls to the limit', () => {
    expect(restingOrderTriggered('BUY', 100, { bid: 99.97, ask: 100.01 })).toBe(false);
    expect(restingOrderTriggered('BUY', 100, { bid: 99.96, ask: 100 })).toBe(true);
  });

  it('triggers a sell when the bid rises to the limit', () => {
    expect(restingOrderTriggered('SELL', 100, { bid: 99.99, ask: 100.03 })).toBe(false);
    expect(restingOrderTriggered('SELL', 100, { bid: 100, ask: 100.04 })).toBe(true);
  });

  it('ignores an empty side of the book', () => {
    expect(restingOrderTriggered('BUY', 100, { bid: 99, ask: 0 })).toBe(false);
    expect(restingOrderTriggered('SELL', 100, { bid: 0, ask: 101 })).toBe(false);
  });
});

describe('stopTriggered', () => {
  it('wakes a buy stop when the ask rises to the stop price', () => {
    expect(stopTriggered('BUY', 101, { bid: 100.9, ask: 100.99 })).toBe(false);
    expect(stopTriggered('BUY', 101, { bid: 100.97, ask: 101 })).toBe(true);
    expect(stopTriggered('BUY', 101, { bid: 102, ask: 102.05 })).toBe(true);
  });

  it('wakes a sell stop when the bid falls to the stop price', () => {
    expect(stopTriggered('SELL', 99, { bid: 99.01, ask: 99.05 })).toBe(false);
    expect(stopTriggered('SELL', 99, { bid: 99, ask: 99.04 })).toBe(true);
    expect(stopTriggered('SELL', 99, { bid: 97.5, ask: 97.6 })).toBe(true);
  });

  it('never fires on an empty side of the book', () => {
    expect(stopTriggered('BUY', 101, { bid: 100, ask: 0 })).toBe(false);
    expect(stopTriggered('SELL', 99, { bid: 0, ask: 100 })).toBe(false);
  });
});

describe('isQuoteFresh', () => {
  const now = 1_000_000;
  it('accepts quotes inside the window and rejects older ones', () => {
    expect(isQuoteFresh({ ts: now - 5_000 }, 10_000, now)).toBe(true);
    expect(isQuoteFresh({ ts: now - 15_000 }, 10_000, now)).toBe(false);
  });

  it('is disabled by a max age of zero', () => {
    expect(isQuoteFresh({ ts: 0 }, 0, now)).toBe(true);
  });
});

describe('bracketProblem', () => {
  it('accepts a long protected below and taking profit above', () => {
    expect(bracketProblem('BUY', 100, 105, 95)).toBeNull();
    expect(bracketProblem('BUY', 100, 105, null)).toBeNull();
    expect(bracketProblem('BUY', 100, null, 95)).toBeNull();
  });

  it('accepts a short protected above and taking profit below', () => {
    expect(bracketProblem('SELL', 100, 95, 105)).toBeNull();
  });

  it('refuses exits on the wrong side of a buy', () => {
    expect(bracketProblem('BUY', 100, 99, null)).toMatch(/take-profit must be above the entry price \(100\.00\)/);
    expect(bracketProblem('BUY', 100, null, 101)).toMatch(/stop-loss must be below/);
  });

  it('refuses exits on the wrong side of a short', () => {
    expect(bracketProblem('SELL', 100, 101, null)).toMatch(/take-profit must be below/);
    expect(bracketProblem('SELL', 100, null, 99)).toMatch(/stop-loss must be above/);
  });

  it('refuses an exit at exactly the entry price, which would fire at once', () => {
    expect(bracketProblem('BUY', 100, 100, null)).not.toBeNull();
    expect(bracketProblem('BUY', 100, null, 100)).not.toBeNull();
    expect(bracketProblem('SELL', 100, 100, null)).not.toBeNull();
    expect(bracketProblem('SELL', 100, null, 100)).not.toBeNull();
  });
});

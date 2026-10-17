import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { applyFill, exposureIncrease, valuePortfolio, type PositionState, reducibleShares } from '../src/engine/accounting.js';

const d = (n: number | string) => new Decimal(n);
const pos = (quantity: number, avg: number): PositionState => ({ quantity, averagePrice: d(avg) });

describe('applyFill', () => {
  it('opens a long position at the fill price', () => {
    const fill = applyFill(null, 'BUY', 100, d('150.01'));
    expect(fill.quantity).toBe(100);
    expect(fill.averagePrice.toString()).toBe('150.01');
    expect(fill.realizedPnl.toString()).toBe('0');
    expect(fill.cashDelta.toString()).toBe('-15001');
  });

  it('re-averages the basis when adding to a long', () => {
    const fill = applyFill(pos(100, 100), 'BUY', 300, d(120));
    expect(fill.quantity).toBe(400);
    expect(fill.averagePrice.toString()).toBe('115');
    expect(fill.realizedPnl.isZero()).toBe(true);
  });

  it('realises P&L and keeps the basis when reducing a long', () => {
    const fill = applyFill(pos(100, 100), 'SELL', 40, d(110));
    expect(fill.quantity).toBe(60);
    expect(fill.averagePrice.toString()).toBe('100');
    expect(fill.realizedPnl.toString()).toBe('400');
    expect(fill.cashDelta.toString()).toBe('4400');
    expect(fill.flipped).toBe(false);
  });

  it('goes flat when the whole position is sold', () => {
    const fill = applyFill(pos(100, 100), 'SELL', 100, d(95));
    expect(fill.quantity).toBe(0);
    expect(fill.realizedPnl.toString()).toBe('-500');
  });

  it('opens a short and credits the proceeds to cash', () => {
    const fill = applyFill(null, 'SELL', 50, d(200));
    expect(fill.quantity).toBe(-50);
    expect(fill.averagePrice.toString()).toBe('200');
    expect(fill.cashDelta.toString()).toBe('10000');
  });

  it('profits when a short is covered lower', () => {
    const fill = applyFill(pos(-50, 200), 'BUY', 50, d(180));
    expect(fill.quantity).toBe(0);
    expect(fill.realizedPnl.toString()).toBe('1000');
    expect(fill.cashDelta.toString()).toBe('-9000');
  });

  it('flips long to short: closes at the old basis, reopens at the fill price', () => {
    const fill = applyFill(pos(100, 100), 'SELL', 150, d(110));
    expect(fill.quantity).toBe(-50);
    expect(fill.flipped).toBe(true);
    expect(fill.realizedPnl.toString()).toBe('1000');
    expect(fill.averagePrice.toString()).toBe('110');
  });

  it('keeps sub-cent arithmetic exact', () => {
    const fill = applyFill(pos(3, 0.1), 'BUY', 3, d(0.2));
    expect(fill.averagePrice.toString()).toBe('0.15');
  });
});

describe('valuePortfolio', () => {
  const marks = (prices: Record<string, number>) => (ticker: string) => (ticker in prices ? d(prices[ticker]!) : null);

  it('values an all-cash account at its cash', () => {
    const v = valuePortfolio(d(100_000), [], marks({}), d(1));
    expect(v.equity.toString()).toBe('100000');
    expect(v.buyingPower.toString()).toBe('100000');
  });

  it('marks a long position to market', () => {
    const v = valuePortfolio(d(50_000), [['AAPL', pos(250, 200)]], marks({ AAPL: 210 }), d(1));
    expect(v.equity.toString()).toBe('102500');
    expect(v.unrealizedPnl.toString()).toBe('2500');
    expect(v.grossExposure.toString()).toBe('52500');
    expect(v.buyingPower.toString()).toBe('50000');
  });

  it('treats a short as a liability that still consumes buying power', () => {
    // Shorted 500 @ 100: cash rose to 150k, equity is unchanged at 100k.
    const flat = valuePortfolio(d(150_000), [['TSLA', pos(-500, 100)]], marks({ TSLA: 100 }), d(1));
    expect(flat.equity.toString()).toBe('100000');
    expect(flat.buyingPower.toString()).toBe('50000');

    const squeezed = valuePortfolio(d(150_000), [['TSLA', pos(-500, 100)]], marks({ TSLA: 120 }), d(1));
    expect(squeezed.equity.toString()).toBe('90000');
    expect(squeezed.unrealizedPnl.toString()).toBe('-10000');
  });

  it('applies leverage to buying power only', () => {
    const v = valuePortfolio(d(100_000), [], marks({}), d(4));
    expect(v.equity.toString()).toBe('100000');
    expect(v.buyingPower.toString()).toBe('400000');
  });

  it('carries a position at cost when no price is available', () => {
    const v = valuePortfolio(d(90_000), [['XYZ', pos(100, 100)]], marks({}), d(1));
    expect(v.equity.toString()).toBe('100000');
    expect(v.unrealizedPnl.isZero()).toBe(true);
  });

  it('never reports negative buying power', () => {
    const v = valuePortfolio(d(-50_000), [['AAPL', pos(1000, 100)]], marks({ AAPL: 40 }), d(1));
    expect(v.equity.toString()).toBe('-10000');
    expect(v.buyingPower.toString()).toBe('0');
  });
});

describe('exposureIncrease', () => {
  it.each([
    [0, 'BUY', 100, 100],
    [100, 'BUY', 50, 50],
    [100, 'SELL', 100, 0],
    [100, 'SELL', 40, 0],
    [100, 'SELL', 150, 0],
    [100, 'SELL', 300, 100],
    [-100, 'BUY', 100, 0],
    [-100, 'SELL', 25, 25],
    [0, 'SELL', 10, 10],
  ] as const)('position %i, %s %i -> %i shares of new exposure', (held, side, quantity, expected) => {
    expect(exposureIncrease(held, side, quantity)).toBe(expected);
  });
});

describe('reducibleShares', () => {
  it('lets a sell exit close a long, up to the size it asks for', () => {
    expect(reducibleShares(100, 'SELL', 100)).toBe(100);
    expect(reducibleShares(100, 'SELL', 40)).toBe(40);
  });

  it('shrinks an exit to what is left of the position', () => {
    expect(reducibleShares(30, 'SELL', 100)).toBe(30);
    expect(reducibleShares(-30, 'BUY', 100)).toBe(30);
  });

  it('gives an exit nothing to do once the position is flat or has flipped', () => {
    expect(reducibleShares(0, 'SELL', 100)).toBe(0);
    expect(reducibleShares(-50, 'SELL', 100)).toBe(0);
    expect(reducibleShares(0, 'BUY', 100)).toBe(0);
    expect(reducibleShares(50, 'BUY', 100)).toBe(0);
  });

  it('lets a buy exit cover a short', () => {
    expect(reducibleShares(-100, 'BUY', 100)).toBe(100);
  });
});

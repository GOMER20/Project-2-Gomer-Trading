import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import type { PositionState } from '../src/engine/accounting.js';
import { checkOrderRisk, type RiskInput, marginStatus } from '../src/engine/risk.js';

const d = (n: number | string) => new Decimal(n);

function input(overrides: Partial<RiskInput> & Pick<RiskInput, 'order'>): RiskInput {
  return {
    cash: d(100_000),
    leverage: d(1),
    allowShorting: true,
    positions: new Map<string, PositionState>(),
    markOf: () => d(100),
    workingOrders: [],
    ...overrides,
  };
}

const order = (side: 'BUY' | 'SELL', quantity: number, price: number, ticker = 'AAPL') => ({ ticker, side, quantity, price: d(price) });

describe('checkOrderRisk', () => {
  it('approves a buy that fits in buying power', () => {
    const decision = checkOrderRisk(input({ order: order('BUY', 500, 100) }));
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.requiredBuyingPower.toString()).toBe('50000');
  });

  it('approves a buy for exactly all the buying power', () => {
    expect(checkOrderRisk(input({ order: order('BUY', 1000, 100) })).ok).toBe(true);
  });

  it('rejects a buy that costs one cent too much', () => {
    const decision = checkOrderRisk(input({ order: order('BUY', 1000, 100.01) }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/Insufficient buying power.*\$100,010\.00.*\$100,000\.00/);
  });

  it('counts existing positions against buying power', () => {
    const positions = new Map([['MSFT', { quantity: 600, averagePrice: d(100) }]]);
    // 60k is deployed, so only 40k of new exposure fits.
    expect(checkOrderRisk(input({ cash: d(40_000), positions, order: order('BUY', 400, 100) })).ok).toBe(true);
    expect(checkOrderRisk(input({ cash: d(40_000), positions, order: order('BUY', 401, 100) })).ok).toBe(false);
  });

  it('always allows closing trades, even with no buying power left', () => {
    const positions = new Map([['AAPL', { quantity: 1000, averagePrice: d(100) }]]);
    const decision = checkOrderRisk(input({ cash: d(0), positions, order: order('SELL', 1000, 100) }));
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.requiredBuyingPower.isZero()).toBe(true);
  });

  it('allows covering a short with no buying power left', () => {
    const positions = new Map([['AAPL', { quantity: -1000, averagePrice: d(100) }]]);
    expect(checkOrderRisk(input({ cash: d(200_000), positions, order: order('BUY', 1000, 100) })).ok).toBe(true);
  });

  it('requires buying power to open a short', () => {
    expect(checkOrderRisk(input({ order: order('SELL', 1000, 100) })).ok).toBe(true);
    const decision = checkOrderRisk(input({ order: order('SELL', 1001, 100) }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/to short 1001 AAPL/);
  });

  it('refuses to sell shares that are not held when shorting is disabled', () => {
    const positions = new Map([['AAPL', { quantity: 100, averagePrice: d(100) }]]);
    expect(checkOrderRisk(input({ allowShorting: false, positions, order: order('SELL', 100, 100) })).ok).toBe(true);
    const decision = checkOrderRisk(input({ allowShorting: false, positions, order: order('SELL', 101, 100) }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/Insufficient shares.*only 100 available/);
  });

  it('counts shares committed to resting sell orders when shorting is disabled', () => {
    const positions = new Map([['AAPL', { quantity: 100, averagePrice: d(100) }]]);
    const workingOrders = [{ ticker: 'AAPL', side: 'SELL' as const, quantity: 70, limitPrice: d(120) }];
    expect(checkOrderRisk(input({ allowShorting: false, positions, workingOrders, order: order('SELL', 30, 100) })).ok).toBe(true);
    const decision = checkOrderRisk(input({ allowShorting: false, positions, workingOrders, order: order('SELL', 31, 100) }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/70 committed to open sell orders/);
  });

  it('reserves buying power for resting orders that would open exposure', () => {
    const workingOrders = [{ ticker: 'MSFT', side: 'BUY' as const, quantity: 700, limitPrice: d(100) }];
    expect(checkOrderRisk(input({ workingOrders, order: order('BUY', 300, 100) })).ok).toBe(true);
    const decision = checkOrderRisk(input({ workingOrders, order: order('BUY', 301, 100) }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/\$70,000\.00 reserved by open orders/);
  });

  it('does not reserve buying power for resting orders that only close a position', () => {
    const positions = new Map([['MSFT', { quantity: 500, averagePrice: d(100) }]]);
    const workingOrders = [{ ticker: 'MSFT', side: 'SELL' as const, quantity: 500, limitPrice: d(130) }];
    // 50k deployed in MSFT, 50k free: the take-profit order must not eat into it.
    expect(checkOrderRisk(input({ cash: d(50_000), positions, workingOrders, order: order('BUY', 500, 100) })).ok).toBe(true);
  });

  it('scales buying power with leverage', () => {
    expect(checkOrderRisk(input({ leverage: d(2), order: order('BUY', 2000, 100) })).ok).toBe(true);
    expect(checkOrderRisk(input({ leverage: d(2), order: order('BUY', 2001, 100) })).ok).toBe(false);
  });

  it('rejects everything that adds exposure once equity is gone', () => {
    const positions = new Map([['AAPL', { quantity: 1000, averagePrice: d(100) }]]);
    const wipedOut = input({ cash: d(-60_000), positions, markOf: () => d(50), order: order('BUY', 1, 50) });
    expect(checkOrderRisk(wipedOut).ok).toBe(false);
  });
});

describe('commission in the buying power check', () => {
  const base = {
    cash: new Decimal(10_000),
    leverage: new Decimal(1),
    allowShorting: true,
    positions: new Map(),
    markOf: () => new Decimal(100),
    workingOrders: [],
  };

  it('counts the commission an order would pay towards what it needs', () => {
    const order = { ticker: 'TEST', side: 'BUY' as const, quantity: 100, price: new Decimal(100) };
    expect(checkOrderRisk({ ...base, order }).ok).toBe(true);
    const withCommission = checkOrderRisk({ ...base, commissionPerShare: new Decimal(0.01), order });
    expect(withCommission.ok).toBe(false);
    expect(checkOrderRisk({ ...base, commissionPerShare: new Decimal(0.01), order: { ...order, quantity: 99 } })).toMatchObject({ ok: true, requiredBuyingPower: new Decimal(9900.99) });
  });

  it('never blocks an order that only reduces a position, whatever the commission', () => {
    const positions = new Map([['TEST', { quantity: 100, averagePrice: new Decimal(100) }]]);
    const decision = checkOrderRisk({ ...base, cash: new Decimal(0), positions, commissionPerShare: new Decimal(1), order: { ticker: 'TEST', side: 'SELL', quantity: 100, price: new Decimal(100) } });
    expect(decision.ok).toBe(true);
  });
});

describe('marginStatus', () => {
  const at = (price: number) => () => new Decimal(price);
  const long = (quantity: number, average: number) => new Map([['TEST', { quantity, averagePrice: new Decimal(average) }]]);

  it('has no level, and no call, when nothing is held', () => {
    expect(marginStatus(new Decimal(100_000), new Map(), at(100), new Decimal(0.25))).toMatchObject({ level: null, call: false });
  });

  it('can never call an account that neither borrows nor shorts', () => {
    // All the cash in one stock that then falls 90%: equity still equals exposure.
    const status = marginStatus(new Decimal(0), long(1000, 100), at(10), new Decimal(0.25));
    expect(status.level?.toNumber()).toBe(1);
    expect(status.call).toBe(false);
  });

  it('calls a leveraged long once the fall takes equity below the maintenance level', () => {
    // 100,000 of equity buying 2,000 shares at 100 on 2x leverage: cash is -100,000.
    const cash = new Decimal(-100_000);
    expect(marginStatus(cash, long(2000, 100), at(100), new Decimal(0.25)).level?.toNumber()).toBe(0.5);
    expect(marginStatus(cash, long(2000, 100), at(70), new Decimal(0.25)).call).toBe(false); // 40,000 / 140,000 = 28.6%
    const called = marginStatus(cash, long(2000, 100), at(66), new Decimal(0.25)); // 32,000 / 132,000 = 24.2%
    expect(called.call).toBe(true);
    expect(called.equity.toNumber()).toBe(32_000);
    expect(called.exposure.toNumber()).toBe(132_000);
  });

  it('calls a short once the rise takes equity below the maintenance level', () => {
    // Short 1,000 at 100 with 100,000 of equity: cash is 200,000.
    const short = new Map([['TEST', { quantity: -1000, averagePrice: new Decimal(100) }]]);
    expect(marginStatus(new Decimal(200_000), short, at(100), new Decimal(0.25)).level?.toNumber()).toBe(1);
    expect(marginStatus(new Decimal(200_000), short, at(150), new Decimal(0.25)).call).toBe(false); // 50,000 / 150,000 = 33%
    expect(marginStatus(new Decimal(200_000), short, at(165), new Decimal(0.25)).call).toBe(true); // 35,000 / 165,000 = 21%
  });

  it('is switched off by a maintenance level of zero', () => {
    expect(marginStatus(new Decimal(-100_000), long(2000, 100), at(51), new Decimal(0)).call).toBe(false);
  });
});

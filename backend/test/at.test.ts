import { beforeAll, describe, expect, it } from 'vitest';
import type * as AtService from '../src/services/at.service.js';

// The service reads the app's configuration, which needs a valid secret.
process.env.JWT_SECRET ??= 'unit-test-secret-unit-test-secret-0123456789';
process.env.LOG_LEVEL = 'silent';

let tradesFrom: typeof AtService.tradesFrom;
let summarise: typeof AtService.summarise;
beforeAll(async () => {
  ({ tradesFrom, summarise } = await import('../src/services/at.service.js'));
});

let n = 0;
/** A fill as the executions table holds it. */
const fill = (order: string, ticker: string, side: 'BUY' | 'SELL', quantity: number, price: number, realized: number, at: string) => ({
  order_id: order,
  ticker,
  side,
  quantity,
  price: String(price),
  commission: '0',
  realized_pnl: String(realized),
  executed_at: new Date(`2026-10-12T${at}Z`),
  id: ++n,
});

describe("AT's trades, rebuilt from its fills", () => {
  it('pairs an entry with its exit and works out the entry price from the booked profit', () => {
    const { trades } = tradesFrom([fill('a', 'AAPL', 'BUY', 100, 200, 0, '14:00:00'), fill('b', 'AAPL', 'SELL', 100, 201.5, 150, '14:05:00')]);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ ticker: 'AAPL', direction: 'LONG', quantity: 100, entryPrice: 200, exitPrice: 201.5, pnl: 150, session: '2026-10-12' });
    expect(trades[0]!.openedAt).toBe('2026-10-12T14:00:00.000Z');
  });

  it('counts an exit filled in pieces as one trade, and a short as a short', () => {
    const { trades } = tradesFrom([
      fill('a', 'TSLA', 'SELL', 50, 250, 0, '14:00:00'),
      fill('b', 'TSLA', 'BUY', 20, 249, 20, '14:01:00'),
      fill('b', 'TSLA', 'BUY', 30, 248, 60, '14:01:00'),
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ direction: 'SHORT', quantity: 50, pnl: 80, entryPrice: 250 });
    expect(trades[0]!.exitPrice).toBeCloseTo(248.4, 4);
  });

  it('keeps symbols apart and treats separate exit orders as separate trades', () => {
    const { trades } = tradesFrom([
      fill('a', 'AAPL', 'BUY', 100, 200, 0, '14:00:00'),
      fill('b', 'MSFT', 'BUY', 10, 400, 0, '14:00:01'),
      fill('c', 'AAPL', 'SELL', 40, 199, -40, '14:02:00'),
      fill('d', 'MSFT', 'SELL', 10, 402, 20, '14:03:00'),
      fill('e', 'AAPL', 'SELL', 60, 201, 60, '14:04:00'),
    ]);
    expect(trades.map((t) => [t.ticker, t.quantity, t.pnl])).toEqual([
      ['AAPL', 40, -40],
      ['MSFT', 10, 20],
      ['AAPL', 60, 60],
    ]);
  });

  it('follows a position that turns from long to short in one fill', () => {
    const { trades } = tradesFrom([
      fill('a', 'NVDA', 'BUY', 10, 100, 0, '14:00:00'),
      fill('b', 'NVDA', 'SELL', 30, 101, 10, '14:01:00'),
      fill('c', 'NVDA', 'BUY', 20, 100.5, 10, '14:02:00'),
    ]);
    expect(trades.map((t) => [t.direction, t.quantity, t.pnl])).toEqual([
      ['LONG', 10, 10],
      ['SHORT', 20, 10],
    ]);
    expect(trades[1]!.openedAt).toBe('2026-10-12T14:01:00.000Z');
  });

  it('leaves a position that is still open out of the trades', () => {
    expect(tradesFrom([fill('a', 'AMD', 'BUY', 10, 150, 0, '14:00:00')]).trades).toHaveLength(0);
  });
});

describe('the success rate and the rest', () => {
  const trade = (pnl: number, direction: 'LONG' | 'SHORT' = 'LONG') => ({
    ticker: 'X',
    direction,
    quantity: 1,
    entryPrice: 1,
    exitPrice: 1,
    openedAt: '2026-10-12T14:00:00Z',
    closedAt: '2026-10-12T14:02:00Z',
    pnl,
    session: '2026-10-12',
  });

  it('is wins over trades, with profit factor, averages and the longest losing run', () => {
    const summary = summarise([trade(30), trade(-10), trade(-20), trade(50, 'SHORT')], 5);
    expect(summary).toMatchObject({ trades: 4, wins: 2, losses: 2, winRate: 0.5, netPnl: 45, grossProfit: 80, grossLoss: -30, avgWin: 40, avgLoss: -15, best: 50, worst: -20, longestLosingStreak: 2, avgHoldSeconds: 120, longShare: 0.75 });
    expect(summary.profitFactor).toBeCloseTo(2.667, 3);
  });

  it('says nothing it cannot know with no trades', () => {
    expect(summarise([])).toMatchObject({ trades: 0, winRate: null, profitFactor: null, best: null, avgHoldSeconds: null });
  });
});

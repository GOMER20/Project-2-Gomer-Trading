import { Decimal } from 'decimal.js';
import type { OrderSide, Quote } from '../types.js';

type TwoSided = Pick<Quote, 'bid' | 'ask'>;

const MIN_PRICE = new Decimal('0.01');

/**
 * Market orders take liquidity: buys lift the ask, sells hit the bid, and each
 * pays a fixed per-share slippage on top. Returns null when that side of the
 * book is empty.
 */
export function marketOrderPrice(side: OrderSide, quote: TwoSided, slippage: number): Decimal | null {
  if (side === 'BUY') return quote.ask > 0 ? new Decimal(quote.ask).plus(slippage) : null;
  return quote.bid > 0 ? Decimal.max(MIN_PRICE, new Decimal(quote.bid).minus(slippage)) : null;
}

/**
 * A limit order that crosses the spread when it arrives executes immediately
 * as a taker: same slippage as a market order, but never worse than its limit.
 * Returns null when the order is not marketable and should rest.
 */
export function marketableLimitPrice(side: OrderSide, limit: Decimal, quote: TwoSided, slippage: number): Decimal | null {
  if (side === 'BUY') {
    if (quote.ask <= 0 || limit.lt(quote.ask)) return null;
    return Decimal.min(limit, new Decimal(quote.ask).plus(slippage));
  }
  if (quote.bid <= 0 || limit.gt(quote.bid)) return null;
  return Decimal.max(limit, new Decimal(quote.bid).minus(slippage));
}

/**
 * A resting limit order is a maker. It fills at its limit price, with no
 * slippage, on the first quote where the opposite side reaches it. (One the
 * market jumped past while nothing was trading is the exception: see
 * RestingOrder.seated in the matching engine.)
 */
export function restingOrderTriggered(side: OrderSide, limit: number, quote: TwoSided): boolean {
  return side === 'BUY' ? quote.ask > 0 && quote.ask <= limit : quote.bid > 0 && quote.bid >= limit;
}

/**
 * A stop order wakes up when the market trades through its stop price:
 * a buy stop when the ask rises to it, a sell stop when the bid falls to it.
 */
export function stopTriggered(side: OrderSide, stop: number, quote: TwoSided): boolean {
  return side === 'BUY' ? quote.ask > 0 && quote.ask >= stop : quote.bid > 0 && quote.bid <= stop;
}

/** maxAgeMs = 0 disables the staleness check. */
export function isQuoteFresh(quote: Pick<Quote, 'ts'>, maxAgeMs: number, now = Date.now()): boolean {
  return maxAgeMs <= 0 || now - quote.ts <= maxAgeMs;
}

/**
 * Checks the exits of a bracket against the price the entry is expected to
 * trade at. A long is protected below and takes profit above; a short is the
 * mirror image. Returns what is wrong, or null when the bracket makes sense.
 */
export function bracketProblem(side: OrderSide, entryPrice: number, takeProfit: number | null, stopLoss: number | null): string | null {
  const entry = entryPrice.toFixed(2);
  if (side === 'BUY') {
    if (takeProfit !== null && takeProfit <= entryPrice) return `For a buy, the take-profit must be above the entry price (${entry}).`;
    if (stopLoss !== null && stopLoss >= entryPrice) return `For a buy, the stop-loss must be below the entry price (${entry}).`;
  } else {
    if (takeProfit !== null && takeProfit >= entryPrice) return `For a short sale, the take-profit must be below the entry price (${entry}).`;
    if (stopLoss !== null && stopLoss <= entryPrice) return `For a short sale, the stop-loss must be above the entry price (${entry}).`;
  }
  return null;
}

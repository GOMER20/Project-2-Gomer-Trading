import { Decimal } from 'decimal.js';
import type { OrderSide } from '../types.js';

/** quantity is signed: positive = long, negative = short. */
export interface PositionState {
  quantity: number;
  averagePrice: Decimal;
}

export interface FillResult {
  /** Signed quantity after the fill. Zero means the position is flat and its row should be deleted. */
  quantity: number;
  averagePrice: Decimal;
  realizedPnl: Decimal;
  /** Change in cash: negative for buys, positive for sells (including short sales). */
  cashDelta: Decimal;
  /** True when the fill crossed through zero, e.g. long 100 -> short 50. */
  flipped: boolean;
}

/**
 * Applies one execution to a position using average-cost accounting.
 * Adding to a position re-averages the basis; reducing it realises P&L against
 * the existing basis; crossing zero closes the old side and opens the remainder
 * at the fill price.
 */
export function applyFill(position: PositionState | null, side: OrderSide, quantity: number, price: Decimal): FillResult {
  const oldQty = position?.quantity ?? 0;
  const oldAvg = position?.averagePrice ?? new Decimal(0);
  const signed = side === 'BUY' ? quantity : -quantity;
  const newQty = oldQty + signed;
  const cashDelta = price.mul(-signed);

  if (oldQty === 0 || Math.sign(oldQty) === Math.sign(signed)) {
    const basis = oldAvg.mul(Math.abs(oldQty)).plus(price.mul(quantity));
    return {
      quantity: newQty,
      averagePrice: basis.div(Math.abs(newQty)),
      realizedPnl: new Decimal(0),
      cashDelta,
      flipped: false,
    };
  }

  const closed = Math.min(quantity, Math.abs(oldQty));
  const perShare = oldQty > 0 ? price.minus(oldAvg) : oldAvg.minus(price);
  const flipped = newQty !== 0 && Math.sign(newQty) !== Math.sign(oldQty);
  return {
    quantity: newQty,
    averagePrice: flipped ? price : oldAvg,
    realizedPnl: perShare.mul(closed),
    cashDelta,
    flipped,
  };
}

export interface Valuation {
  /** Net asset value: cash plus the signed market value of every position. */
  equity: Decimal;
  /** Sum of |quantity| x mark across positions. */
  grossExposure: Decimal;
  unrealizedPnl: Decimal;
  /** equity x leverage - gross exposure, floored at zero. */
  buyingPower: Decimal;
}

export type MarkLookup = (ticker: string) => Decimal | null;

/**
 * Marks a portfolio to market. A position with no available price is carried
 * at cost so a missing quote can never invent or destroy equity.
 */
export function valuePortfolio(
  cash: Decimal,
  positions: Iterable<[ticker: string, position: PositionState]>,
  markOf: MarkLookup,
  leverage: Decimal,
): Valuation {
  let marketValue = new Decimal(0);
  let grossExposure = new Decimal(0);
  let unrealizedPnl = new Decimal(0);

  for (const [ticker, position] of positions) {
    const mark = markOf(ticker) ?? position.averagePrice;
    marketValue = marketValue.plus(mark.mul(position.quantity));
    grossExposure = grossExposure.plus(mark.mul(Math.abs(position.quantity)));
    unrealizedPnl = unrealizedPnl.plus(mark.minus(position.averagePrice).mul(position.quantity));
  }

  const equity = cash.plus(marketValue);
  const buyingPower = Decimal.max(0, equity.mul(leverage).minus(grossExposure));
  return { equity, grossExposure, unrealizedPnl, buyingPower };
}

/** Shares by which an order grows the absolute size of a position. Closing trades return 0. */
export function exposureIncrease(currentQty: number, side: OrderSide, quantity: number): number {
  const next = currentQty + (side === 'BUY' ? quantity : -quantity);
  return Math.max(0, Math.abs(next) - Math.abs(currentQty));
}

/**
 * How many shares a reduce-only order may trade: never more than it asks for,
 * and never more than the position it would close. Zero when there is nothing
 * left on that side to close.
 */
export function reducibleShares(currentQty: number, side: OrderSide, quantity: number): number {
  const closable = side === 'SELL' ? Math.max(0, currentQty) : Math.max(0, -currentQty);
  return Math.min(quantity, closable);
}

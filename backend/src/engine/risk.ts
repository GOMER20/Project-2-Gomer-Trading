import { Decimal } from 'decimal.js';
import type { OrderSide } from '../types.js';
import { exposureIncrease, valuePortfolio, type MarkLookup, type PositionState } from './accounting.js';

export interface WorkingOrder {
  ticker: string;
  side: OrderSide;
  quantity: number;
  /** The price the order is expected to execute at: its limit, or its stop price for a plain stop. */
  limitPrice: Decimal;
}

export interface RiskInput {
  cash: Decimal;
  leverage: Decimal;
  allowShorting: boolean;
  positions: Map<string, PositionState>;
  markOf: MarkLookup;
  /** The portfolio's other resting orders. They reserve buying power and shares. */
  workingOrders: WorkingOrder[];
  /** Commission per share, which an order that grows a position must also be able to pay. */
  commissionPerShare?: Decimal;
  order: {
    ticker: string;
    side: OrderSide;
    quantity: number;
    /** Worst-case execution price: slippage-adjusted quote for market orders, the limit for limit orders. */
    price: Decimal;
  };
}

export type RiskDecision =
  | { ok: true; requiredBuyingPower: Decimal; availableBuyingPower: Decimal }
  | { ok: false; reason: string };

/** Buying power set aside for resting orders that would grow a position if they filled. */
export function reservedBuyingPower(positions: Map<string, PositionState>, workingOrders: WorkingOrder[]): Decimal {
  return workingOrders.reduce((sum, o) => {
    const shares = exposureIncrease(positions.get(o.ticker)?.quantity ?? 0, o.side, o.quantity);
    return sum.plus(o.limitPrice.mul(shares));
  }, new Decimal(0));
}

const usd = (value: Decimal) => `$${value.toNumber().toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Pre-trade risk check. Pure, so the HTTP middleware (fast feedback) and the
 * matching engine (authoritative, under the portfolio row lock) share one rule set.
 *
 * Rules:
 *  1. With shorting disabled, a sell cannot exceed shares held minus shares
 *     already committed to other resting sell orders.
 *  2. Any order that grows a position must fit in available buying power,
 *     where available = equity x leverage - gross exposure - reservations for
 *     resting orders. Orders that only reduce a position always pass this rule.
 */
export function checkOrderRisk(input: RiskInput): RiskDecision {
  const { order, positions, workingOrders } = input;
  const held = positions.get(order.ticker)?.quantity ?? 0;

  if (order.side === 'SELL' && !input.allowShorting) {
    const committed = workingOrders
      .filter((o) => o.ticker === order.ticker && o.side === 'SELL')
      .reduce((sum, o) => sum + o.quantity, 0);
    const sellable = Math.max(0, held) - committed;
    if (order.quantity > sellable) {
      const detail = committed > 0 ? ` (${committed} committed to open sell orders)` : '';
      return {
        ok: false,
        reason: `Insufficient shares: selling ${order.quantity} ${order.ticker} but only ${Math.max(0, sellable)} available${detail}. Short selling is disabled in this competition.`,
      };
    }
  }

  const { buyingPower } = valuePortfolio(input.cash, positions, input.markOf, input.leverage);
  const reserved = reservedBuyingPower(positions, workingOrders);
  const available = Decimal.max(0, buyingPower.minus(reserved));
  const growth = exposureIncrease(held, order.side, order.quantity);
  const required = order.price.mul(growth).plus(growth > 0 ? (input.commissionPerShare ?? new Decimal(0)).mul(order.quantity) : 0);

  if (required.gt(available)) {
    const action = order.side === 'BUY' ? 'buy' : 'short';
    const detail = reserved.gt(0) ? ` (${usd(reserved)} reserved by open orders)` : '';
    return {
      ok: false,
      reason: `Insufficient buying power to ${action} ${order.quantity} ${order.ticker}: requires ${usd(required)}, available ${usd(available)}${detail}.`,
    };
  }

  return { ok: true, requiredBuyingPower: required, availableBuyingPower: available };
}

export interface MarginStatus {
  equity: Decimal;
  /** Gross exposure: the sum of |quantity| x mark over every position. */
  exposure: Decimal;
  /** Equity as a share of gross exposure. Null when nothing is held. */
  level: Decimal | null;
  /** True when the account has fallen below its maintenance margin and must be liquidated. */
  call: boolean;
}

/**
 * Where an account stands against its maintenance margin. An account with no
 * borrowing and no shorts can never be called: its equity is at least its
 * exposure. Leverage and short positions are what make the level fall.
 */
export function marginStatus(cash: Decimal, positions: Map<string, PositionState>, markOf: MarkLookup, maintenanceMargin: Decimal): MarginStatus {
  const { equity, grossExposure } = valuePortfolio(cash, positions, markOf, new Decimal(1));
  const level = grossExposure.isZero() ? null : equity.div(grossExposure);
  return { equity, exposure: grossExposure, level, call: maintenanceMargin.gt(0) && level !== null && level.lt(maintenanceMargin) };
}

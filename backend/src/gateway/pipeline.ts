import { config } from '../config.js';
import { isDatabaseBusy, pool } from '../db/pool.js';
import { engine, type OrderEvent } from '../engine/matchingEngine.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { market } from '../market/marketData.js';
import { getPortfolio, type PortfolioDto } from '../services/portfolio.service.js';
import { SYMBOL_PATTERN, toOrderDto, type OrderDto, type OrderRow, type OrderSide, type OrderType, type TimeInForce } from '../types.js';
import type { KeyIdentity } from './keys.service.js';
import { RejectCode, type ExecutionReport, type ExecType, type OrdStatus, type RejectName } from './protocol.js';
import { takeOrderToken } from './session.js';

/** A refusal, in the terms both wire formats use. */
export class GatewayReject extends Error {
  readonly code: number;
  constructor(
    readonly reason: RejectName,
    message: string,
  ) {
    super(message);
    this.code = RejectCode[reason];
  }
}

// How long the exchange itself spends on an order: from the decoded message to the moment its
// execution report has been handed to the socket. Kept for the last few thousand orders.
const timings = new Float64Array(4096);
let timed = 0;

/** Server-side order handling time over recent orders, in microseconds. */
export function orderTimings(): { orders: number; medianMicros: number; p95Micros: number; p99Micros: number } {
  const sorted = Array.from(timings.subarray(0, Math.min(timed, timings.length))).sort((a, b) => a - b);
  const at = (p: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0);
  return { orders: timed, medianMicros: at(50), p95Micros: at(95), p99Micros: at(99) };
}

/** NewOrderSingle, as it arrives from any transport. */
export interface NewOrderSingle {
  clOrdId?: string | null;
  symbol: string;
  side: OrderSide | undefined;
  type: OrderType | undefined;
  timeInForce?: TimeInForce;
  quantity: number;
  price?: number | null;
  stopPrice?: number | null;
}

const isWholeCents = (price: number) => Math.abs(price * 100 - Math.round(price * 100)) < 1e-6;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Turns whatever went wrong inside the platform into a gateway refusal. */
function refusal(err: unknown): GatewayReject {
  if (err instanceof GatewayReject) return err;
  if (err instanceof AppError) {
    if (err.code === 'ORDER_REJECTED') return new GatewayReject(/has (not started|ended)/.test(err.message) ? 'SANDBOX_CLOSED' : 'RISK', err.message);
    if (err.code === 'CONFLICT') return new GatewayReject(/Client order id/.test(err.message) ? 'DUPLICATE_CL_ORD_ID' : 'TOO_LATE_TO_CANCEL', err.message);
    if (err.code === 'NOT_FOUND') return new GatewayReject('UNKNOWN_ORDER', err.message);
    if (err.status === 503) return new GatewayReject('BUSY', 'The exchange is busy. Send it again in a moment.');
    return new GatewayReject('MALFORMED', err.message);
  }
  if (isDatabaseBusy(err)) return new GatewayReject('BUSY', 'The exchange is busy. Send it again in a moment.');
  logger.error({ err }, 'Gateway request failed');
  return new GatewayReject('INTERNAL', 'The exchange could not process that.');
}

/**
 * The order ingestion pipeline, the same for every transport:
 *
 *   1. shape      the message is a well-formed order
 *   2. throttle   the key has not exceeded its orders per second
 *   3. market     the symbol exists and is quoting
 *   4. risk       cash, margin and short inventory, checked by the matching
 *                 engine under the account's lock so two orders cannot both
 *                 spend the same buying power
 *   5. match      the engine trades it against the book
 *
 * Returns the order as the engine left it. The execution reports for it are
 * sent separately, from the engine's own event stream, so a program hears about
 * a fill the same way whether the fill came at once or minutes later.
 */
export async function newOrder(identity: KeyIdentity, order: NewOrderSingle): Promise<OrderDto> {
  const started = process.hrtime.bigint();
  const symbol = order.symbol.trim().toUpperCase();
  const timeInForce = order.timeInForce ?? 'GTC';
  const price = order.price && order.price > 0 ? order.price : null;
  const stopPrice = order.stopPrice && order.stopPrice > 0 ? order.stopPrice : null;

  if (!SYMBOL_PATTERN.test(symbol)) throw new GatewayReject('MALFORMED', 'Invalid symbol.');
  if (!order.side) throw new GatewayReject('MALFORMED', 'Side must be BUY or SELL.');
  if (!order.type) throw new GatewayReject('MALFORMED', 'Unknown order type.');
  if (!Number.isInteger(order.quantity) || order.quantity < 1) throw new GatewayReject('MALFORMED', 'Quantity must be a whole number of shares, at least 1.');
  if (order.quantity > config.trading.maxOrderQuantity) throw new GatewayReject('MALFORMED', `Quantity cannot exceed ${config.trading.maxOrderQuantity} shares.`);
  const wantsLimit = order.type === 'LIMIT' || order.type === 'STOP_LIMIT';
  const wantsStop = order.type === 'STOP' || order.type === 'STOP_LIMIT';
  if (wantsLimit !== (price !== null)) throw new GatewayReject('MALFORMED', wantsLimit ? 'This order type needs a price.' : 'This order type does not take a price.');
  if (wantsStop !== (stopPrice !== null)) throw new GatewayReject('MALFORMED', wantsStop ? 'This order type needs a stop price.' : 'This order type does not take a stop price.');
  if ((price !== null && !isWholeCents(price)) || (stopPrice !== null && !isWholeCents(stopPrice))) throw new GatewayReject('MALFORMED', 'Prices must be in whole cents.');
  if (order.type === 'STOP_LIMIT' && (order.side === 'BUY' ? price! < stopPrice! : price! > stopPrice!)) {
    throw new GatewayReject('MALFORMED', 'A stop-limit order must be able to trade once it wakes: its limit cannot be on the wrong side of its stop.');
  }
  if (order.clOrdId != null && !/^[\w.:-]{1,36}$/.test(order.clOrdId)) throw new GatewayReject('MALFORMED', 'clOrdId may be up to 36 letters, digits, and . _ : - characters.');

  if (!takeOrderToken(identity)) throw new GatewayReject('THROTTLED', `Order rate limit of ${identity.ordersPerSecond} a second exceeded.`);

  // Held only while the order is decided. An accepted order pins the symbol so it keeps streaming.
  const quote = await market.retain(symbol);
  if (!quote) throw new GatewayReject('UNKNOWN_SYMBOL', `${symbol} is not a tradable symbol here.`);
  try {
    const placed = await engine.submit({
      userId: identity.userId,
      portfolioId: identity.portfolioId,
      ticker: symbol,
      side: order.side,
      type: order.type,
      quantity: order.quantity,
      limitPrice: price,
      stopPrice,
      timeInForce,
      clientOrderId: order.clOrdId ?? null,
    });
    // By now the engine has decided the order and its execution report has been written to the session.
    timings[timed++ % timings.length] = Number(process.hrtime.bigint() - started) / 1000;
    await market.pin(symbol);
    return placed;
  } catch (err) {
    throw refusal(err);
  } finally {
    market.release(symbol);
  }
}

/** Finds one of the account's orders by the exchange's id or by the program's own. */
async function findOrder(identity: KeyIdentity, ref: { orderId?: string | null; clOrdId?: string | null }): Promise<OrderRow> {
  const byId = ref.orderId && UUID.test(ref.orderId);
  if (!byId && !ref.clOrdId) throw new GatewayReject('MALFORMED', 'Give the orderId or the clOrdId of the order.');
  // A working order is in the engine's memory. Only one that has finished needs the database, once it has been written there.
  const live = await engine.account(identity.portfolioId);
  const working = live && engine.workingOrder(live, byId ? { orderId: ref.orderId } : { clientOrderId: ref.clOrdId });
  if (working) return working;
  await engine.drained();
  const { rows } = await pool
    .query<OrderRow>(`SELECT * FROM orders WHERE portfolio_id = $1 AND ${byId ? 'id = $2' : 'client_order_id = $2'}`, [identity.portfolioId, byId ? ref.orderId : ref.clOrdId])
    .catch((err) => {
      throw refusal(err);
    });
  if (!rows[0]) throw new GatewayReject('UNKNOWN_ORDER', 'No such order in this account.');
  return rows[0];
}

/** OrderCancelRequest. The cancellation itself is confirmed by an execution report. */
export async function cancelOrder(identity: KeyIdentity, ref: { orderId?: string | null; clOrdId?: string | null }): Promise<OrderDto> {
  const order = await findOrder(identity, ref);
  if (order.status !== 'OPEN') throw new GatewayReject('TOO_LATE_TO_CANCEL', `Order is already ${order.status.toLowerCase()}.`);
  try {
    return await engine.cancel(order.id, identity.userId);
  } catch (err) {
    throw refusal(err);
  }
}

/** OrderStatusRequest. */
export async function orderStatus(identity: KeyIdentity, ref: { orderId?: string | null; clOrdId?: string | null }): Promise<ExecutionReport> {
  return { ...report(toOrderDto(await findOrder(identity, ref))), execType: 'STATUS' };
}

export async function openOrders(identity: KeyIdentity): Promise<ExecutionReport[]> {
  const live = await engine.account(identity.portfolioId).catch((err) => {
    throw refusal(err);
  });
  const working = live ? [...live.working.values()].filter((order) => order.status === 'OPEN') : [];
  return working.sort((a, b) => a.created_at.getTime() - b.created_at.getTime()).map((row) => ({ ...report(toOrderDto(row)), execType: 'STATUS' as const }));
}

/** The sandbox account: cash, equity, buying power, margin, positions. */
export async function account(identity: KeyIdentity): Promise<PortfolioDto> {
  try {
    return await getPortfolio(identity.userId, identity.competitionId);
  } catch (err) {
    throw refusal(err);
  }
}

// --- execution reports ---------------------------------------------------------

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

/** The report for an order as it stands, with no fill attributed to this step. */
export function report(order: OrderDto): ExecutionReport {
  const ordStatus: OrdStatus =
    order.status === 'FILLED' ? 'FILLED' : order.status === 'CANCELLED' ? 'CANCELED' : order.status === 'REJECTED' ? 'REJECTED' : order.filledQuantity > 0 ? 'PARTIALLY_FILLED' : 'NEW';
  const execType: ExecType = order.status === 'CANCELLED' ? 'CANCELED' : order.status === 'REJECTED' ? 'REJECTED' : order.triggeredAt && order.filledQuantity === 0 ? 'TRIGGERED' : 'NEW';
  // Positive slippage is money lost against the price that was showing when the order arrived.
  const slippage = order.fillPrice !== null && order.arrivalPrice !== null ? round((order.fillPrice - order.arrivalPrice) * (order.side === 'BUY' ? 1 : -1), 4) : null;
  return {
    orderId: order.id,
    clOrdId: order.clientOrderId,
    symbol: order.ticker,
    side: order.side,
    ordType: order.type,
    timeInForce: order.timeInForce,
    execType,
    ordStatus,
    orderQty: order.quantity,
    cumQty: order.filledQuantity,
    leavesQty: order.status === 'OPEN' ? order.quantity - order.filledQuantity : 0,
    lastQty: 0,
    lastPx: null,
    avgPx: order.fillPrice,
    commission: order.commission,
    arrivalPx: order.arrivalPrice,
    slippage,
    slippageBps: slippage !== null && order.arrivalPrice ? round((slippage / order.arrivalPrice) * 10_000, 2) : null,
    text: order.rejectReason,
    transactTime: Date.now(),
  };
}

/**
 * The execution reports one engine event amounts to. Usually one. An
 * immediate-or-cancel order that traded part and was cancelled for the rest is
 * two things happening at once, so it is reported as two: the fill, then the cancel.
 */
export function reportsFor(event: OrderEvent): ExecutionReport[] {
  const base = report(event.order);
  if (!event.fill) return [base];
  const done = event.order.filledQuantity === event.order.quantity;
  const fill: ExecutionReport = {
    ...base,
    execType: done ? 'FILL' : 'PARTIAL_FILL',
    ordStatus: done ? 'FILLED' : 'PARTIALLY_FILLED',
    lastQty: event.fill.quantity,
    lastPx: event.fill.price,
    leavesQty: event.order.status === 'OPEN' ? base.leavesQty : event.order.status === 'CANCELLED' ? event.order.quantity - event.order.filledQuantity : 0,
    text: null,
  };
  return event.order.status === 'CANCELLED' ? [fill, base] : [fill];
}

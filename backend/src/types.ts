export type UserRole = 'ADMIN' | 'TRADER';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
export type OrderSide = 'BUY' | 'SELL';
export type OrderStatus = 'OPEN' | 'FILLED' | 'CANCELLED' | 'REJECTED';
export type CompetitionStatus = 'UPCOMING' | 'ACTIVE' | 'ENDED';

export interface AuthUser {
  id: string;
  traderId: string;
  role: UserRole;
  /** The account's token_version when the session was issued; a session from an older version is dead. */
  tokenVersion: number;
}

/** Level 1 quote. Prices are plain numbers here; anything that touches a balance converts to Decimal. */
export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  last: number;
  /** Shares in the most recent trade, when known. */
  lastSize?: number;
  prevClose: number | null;
  /** Epoch milliseconds of the newest update. */
  ts: number;
}

export interface Bar {
  /** Bar open time, epoch seconds (what Lightweight Charts expects). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const TIMEFRAMES = { '1Min': 60, '5Min': 300, '15Min': 900, '1Hour': 3600, '1Day': 86400 } as const;
export type Timeframe = keyof typeof TIMEFRAMES;

// --- Database rows (NUMERIC arrives as string) ------------------------------

export interface UserRow {
  id: string;
  trader_id: string;
  password_hash: string;
  token_version: number;
  role: UserRole;
  display_name: string;
  is_active: boolean;
  is_bot: boolean;
  created_at: Date;
}

export interface CompetitionRow {
  id: string;
  name: string;
  start_date: Date;
  end_date: Date;
  starting_balance: string;
  allow_shorting: boolean;
  leverage: string;
  settled_at: Date | null;
  join_code: string | null;
  commission_per_share: string;
  maintenance_margin: string;
  fill_model: 'standard' | 'hft';
  order_delay_ms: number;
  created_at: Date;
}

export interface PortfolioRow {
  id: string;
  user_id: string;
  competition_id: string;
  cash: string;
  buying_power: string;
  total_equity: string;
  realized_pnl: string;
  commissions: string;
}

export interface PositionRow {
  portfolio_id: string;
  ticker: string;
  quantity: number;
  average_price: string;
  opened_at: Date;
}

/** GTC rests until filled or cancelled. IOC trades what it can at once and cancels the rest. FOK trades in full at once or not at all. */
export type TimeInForce = 'GTC' | 'IOC' | 'FOK';

export interface OrderRow {
  id: string;
  portfolio_id: string;
  ticker: string;
  type: OrderType;
  side: OrderSide;
  status: OrderStatus;
  quantity: number;
  limit_price: string | null;
  stop_price: string | null;
  triggered_at: Date | null;
  /** Exit instructions on an entry order; they become child orders when it fills. */
  take_profit: string | null;
  stop_loss: string | null;
  /** Set on an exit order: the entry order it belongs to. */
  parent_id: string | null;
  /** Shares done so far. fill_price is their average price. */
  filled_quantity: number;
  commission: string;
  /** Set when the platform placed the order itself, e.g. 'MARGIN_CALL'. */
  forced_by: string | null;
  time_in_force: TimeInForce;
  client_order_id: string | null;
  arrival_price: string | null;
  fill_price: string | null;
  realized_pnl: string | null;
  reject_reason: string | null;
  created_at: Date;
  filled_at: Date | null;
}

// --- API shapes --------------------------------------------------------------

export interface OrderDto {
  id: string;
  portfolioId: string;
  ticker: string;
  type: OrderType;
  side: OrderSide;
  status: OrderStatus;
  quantity: number;
  limitPrice: number | null;
  stopPrice: number | null;
  /** When a stop order's stop price was reached, if it has been. */
  triggeredAt: string | null;
  /** Bracket exits requested with this entry order. */
  takeProfit: number | null;
  stopLoss: number | null;
  /** For a bracket exit, the entry order it protects. Exits only ever reduce the position. */
  parentId: string | null;
  /** Shares done so far. An order can fill in pieces; fillPrice is the average of the pieces. */
  filledQuantity: number;
  commission: number;
  /** Why the platform placed this order itself, e.g. 'MARGIN_CALL'. Null for the trader's own orders. */
  forcedBy: string | null;
  timeInForce: TimeInForce;
  /** The sender's own reference for the order, if it gave one. */
  clientOrderId: string | null;
  /** The price on the order's side of the market when it arrived. Fills are measured against it as slippage. */
  arrivalPrice: number | null;
  fillPrice: number | null;
  realizedPnl: number | null;
  rejectReason: string | null;
  createdAt: string;
  filledAt: string | null;
}

export const toOrderDto = (row: OrderRow): OrderDto => ({
  id: row.id,
  portfolioId: row.portfolio_id,
  ticker: row.ticker,
  type: row.type,
  side: row.side,
  status: row.status,
  quantity: row.quantity,
  limitPrice: row.limit_price === null ? null : Number(row.limit_price),
  stopPrice: row.stop_price === null ? null : Number(row.stop_price),
  triggeredAt: row.triggered_at ? row.triggered_at.toISOString() : null,
  takeProfit: row.take_profit === null ? null : Number(row.take_profit),
  stopLoss: row.stop_loss === null ? null : Number(row.stop_loss),
  parentId: row.parent_id,
  filledQuantity: row.filled_quantity,
  commission: Number(row.commission),
  forcedBy: row.forced_by,
  timeInForce: row.time_in_force,
  clientOrderId: row.client_order_id,
  arrivalPrice: row.arrival_price === null ? null : Number(row.arrival_price),
  fillPrice: row.fill_price === null ? null : Number(row.fill_price),
  realizedPnl: row.realized_pnl === null ? null : Number(row.realized_pnl),
  rejectReason: row.reject_reason,
  createdAt: row.created_at.toISOString(),
  filledAt: row.filled_at ? row.filled_at.toISOString() : null,
});

export const competitionStatus = (c: Pick<CompetitionRow, 'start_date' | 'end_date'>, now = new Date()): CompetitionStatus =>
  now < c.start_date ? 'UPCOMING' : now > c.end_date ? 'ENDED' : 'ACTIVE';

export const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.]{0,9}$/;

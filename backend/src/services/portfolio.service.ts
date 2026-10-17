import { Decimal } from 'decimal.js';
import { pool } from '../db/pool.js';
import { accountView } from '../engine/ledger.js';
import { engine } from '../engine/matchingEngine.js';
import { valuePortfolio } from '../engine/accounting.js';
import { reservedBuyingPower } from '../engine/risk.js';
import { notFound } from '../lib/errors.js';
import { market } from '../market/marketData.js';
import { toOrderDto, type OrderDto, type OrderRow, type OrderSide, type OrderStatus } from '../types.js';

export interface PositionDto {
  ticker: string;
  /** Signed: negative for short positions. */
  quantity: number;
  side: 'LONG' | 'SHORT';
  averagePrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
}

export interface PortfolioDto {
  id: string;
  competitionId: string;
  startingBalance: number;
  leverage: number;
  allowShorting: boolean;
  cash: number;
  /** What a new order can actually use: margin headroom minus reservations for resting orders. */
  buyingPower: number;
  totalEquity: number;
  realizedPnl: number;
  /** Commission paid so far. Already taken out of cash, so equity and total P&L are net of it. */
  commissions: number;
  commissionPerShare: number;
  /** The sum of |quantity| x price over every position. */
  grossExposure: number;
  /** Equity as a share of gross exposure. Null with no positions. Below maintenanceMargin the account is liquidated. */
  marginLevel: number | null;
  maintenanceMargin: number;
  unrealizedPnl: number;
  totalPnl: number;
  returnPct: number;
  positions: PositionDto[];
  asOf: string;
}

export async function findPortfolioId(userId: string, competitionId: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM portfolios WHERE user_id = $1 AND competition_id = $2', [
    userId,
    competitionId,
  ]);
  return rows[0]?.id ?? null;
}

async function requirePortfolioId(userId: string, competitionId: string): Promise<string> {
  const id = await findPortfolioId(userId, competitionId);
  if (!id) throw notFound('You do not have a portfolio in this competition.');
  return id;
}

/** The account marked to market right now, from the engine's live quotes. */
export async function getPortfolio(userId: string, competitionId: string): Promise<PortfolioDto> {
  // The engine's memory is the account. The database is a few milliseconds behind it.
  const live = await engine.accountFor(userId, competitionId);
  if (!live) throw notFound('You do not have a portfolio in this competition.');
  const account = accountView(live);
  const portfolioId = account.portfolio.id;

  const cash = new Decimal(account.portfolio.cash);
  const valuation = valuePortfolio(cash, account.positions, (ticker) => market.getMark(ticker), account.rules.leverage);
  const { startingBalance } = account;
  const totalPnl = valuation.equity.minus(startingBalance);
  const available = Decimal.max(0, valuation.buyingPower.minus(reservedBuyingPower(account.positions, account.workingOrders)));

  const positions: PositionDto[] = [...account.positions]
    .map(([ticker, position]) => {
      const mark = market.getMark(ticker) ?? position.averagePrice;
      const unrealized = mark.minus(position.averagePrice).mul(position.quantity);
      const basis = position.averagePrice.mul(Math.abs(position.quantity));
      return {
        ticker,
        quantity: position.quantity,
        side: position.quantity > 0 ? ('LONG' as const) : ('SHORT' as const),
        averagePrice: position.averagePrice.toNumber(),
        currentPrice: mark.toNumber(),
        marketValue: mark.mul(position.quantity).toDecimalPlaces(2).toNumber(),
        unrealizedPnl: unrealized.toDecimalPlaces(2).toNumber(),
        unrealizedPnlPct: basis.isZero() ? 0 : unrealized.div(basis).mul(100).toDecimalPlaces(2).toNumber(),
      };
    })
    .sort((a, b) => a.ticker.localeCompare(b.ticker));

  return {
    id: portfolioId,
    competitionId,
    startingBalance: startingBalance.toNumber(),
    leverage: account.rules.leverage.toNumber(),
    allowShorting: account.rules.allowShorting,
    cash: cash.toDecimalPlaces(2).toNumber(),
    buyingPower: available.toDecimalPlaces(2).toNumber(),
    totalEquity: valuation.equity.toDecimalPlaces(2).toNumber(),
    realizedPnl: new Decimal(account.portfolio.realized_pnl).toDecimalPlaces(2).toNumber(),
    commissions: new Decimal(account.portfolio.commissions).toDecimalPlaces(2).toNumber(),
    commissionPerShare: account.rules.commissionPerShare.toNumber(),
    grossExposure: valuation.grossExposure.toDecimalPlaces(2).toNumber(),
    marginLevel: valuation.grossExposure.isZero() ? null : valuation.equity.div(valuation.grossExposure).toDecimalPlaces(4).toNumber(),
    maintenanceMargin: account.rules.maintenanceMargin.toNumber(),
    unrealizedPnl: valuation.unrealizedPnl.toDecimalPlaces(2).toNumber(),
    totalPnl: totalPnl.toDecimalPlaces(2).toNumber(),
    returnPct: totalPnl.div(startingBalance).mul(100).toDecimalPlaces(2).toNumber(),
    positions,
    asOf: new Date().toISOString(),
  };
}

export interface OrderHistoryQuery {
  status?: OrderStatus;
  limit: number;
  offset: number;
}

/** Account history: every order in the competition, newest first. */
export async function getOrderHistory(
  userId: string,
  competitionId: string,
  query: OrderHistoryQuery,
): Promise<{ orders: OrderDto[]; total: number; limit: number; offset: number }> {
  const portfolioId = await requirePortfolioId(userId, competitionId);
  // Orders are answered before they are written; wait for the writing so this list includes them.
  await engine.drained();
  const { rows } = await pool.query<OrderRow & { total: number }>(
    `SELECT o.*, count(*) OVER ()::int AS total
       FROM orders o
      WHERE o.portfolio_id = $1 AND ($2::order_status IS NULL OR o.status = $2)
      ORDER BY o.created_at DESC, o.id
      LIMIT $3 OFFSET $4`,
    [portfolioId, query.status ?? null, query.limit, query.offset],
  );
  return { orders: rows.map(toOrderDto), total: rows[0]?.total ?? 0, limit: query.limit, offset: query.offset };
}

export interface ExecutionDto {
  id: string;
  orderId: string;
  ticker: string;
  side: OrderSide;
  quantity: number;
  price: number;
  commission: number;
  realizedPnl: number;
  executedAt: string;
}

/** Every piece of every order that has traded, newest first. A large order appears as several pieces. */
export async function getExecutions(userId: string, competitionId: string, limit: number): Promise<{ executions: ExecutionDto[] }> {
  const portfolioId = await requirePortfolioId(userId, competitionId);
  await engine.drained();
  const { rows } = await pool.query<{ id: string; order_id: string; ticker: string; side: OrderSide; quantity: number; price: string; commission: string; realized_pnl: string; executed_at: Date }>(
    `SELECT id, order_id, ticker, side, quantity, price, commission, realized_pnl, executed_at
       FROM executions
      WHERE portfolio_id = $1
      ORDER BY executed_at DESC, price DESC, id
      LIMIT $2`,
    [portfolioId, limit],
  );
  return {
    executions: rows.map((row) => ({
      id: row.id,
      orderId: row.order_id,
      ticker: row.ticker,
      side: row.side,
      quantity: row.quantity,
      price: Number(row.price),
      commission: Number(row.commission),
      realizedPnl: Number(row.realized_pnl),
      executedAt: row.executed_at.toISOString(),
    })),
  };
}

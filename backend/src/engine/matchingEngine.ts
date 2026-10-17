import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Decimal } from 'decimal.js';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { AppError, conflict, notFound, orderRejected } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { averagePrice, provideLiquidity, sharesIn, takeLiquidity, type DepthBook, type Piece } from '../market/depth.js';
import { market, type MarketDataService } from '../market/marketData.js';
import { toOrderDto, type OrderDto, type OrderRow, type OrderSide, type OrderType, type Quote, type TimeInForce } from '../types.js';
import { assertCompetitionOpen } from './account.js';
import { applyFill, reducibleShares, valuePortfolio, type PositionState } from './accounting.js';
import { Ledger, reservingOrders, type LiveAccount } from './ledger.js';
import { bracketProblem, marketOrderPrice, restingOrderTriggered, stopTriggered } from './pricing.js';
import { checkOrderRisk, marginStatus } from './risk.js';
import { MAX_PENDING_WRITES, Store, type ExecutionWrite } from './store.js';

export interface NewOrder {
  userId: string;
  portfolioId: string;
  ticker: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  limitPrice: number | null;
  stopPrice: number | null;
  /** Bracket exits to place when this order fills: a limit to take profit and/or a stop to cut the loss. */
  takeProfit?: number | null;
  stopLoss?: number | null;
  /** Default GTC. IOC and FOK apply to market and limit orders and never leave anything resting. */
  timeInForce?: TimeInForce;
  /** The sender's own reference, unique within the portfolio. */
  clientOrderId?: string | null;
}

export interface OrderEvent {
  userId: string;
  competitionId: string;
  order: OrderDto;
  /** Present when shares traded in the step this event reports: how many, at what average price, and the account's equity afterwards. */
  fill?: { quantity: number; price: number; equity: number };
}

interface RestingOrder {
  id: string;
  ticker: string;
  side: OrderSide;
  /**
   * STOP: waiting for the market to reach `price`.
   * LIMIT: waiting to be filled at `price`.
   * MARKET: taking whatever the book offers until it is done.
   */
  waitingFor: 'STOP' | 'LIMIT' | 'MARKET';
  price: number;
  /**
   * True once the order has stood in a market that was trading. Only then is a
   * limit order a maker, filled at its own price when the market comes to it.
   * An order the market has jumped clean past without trading (left overnight,
   * placed while the exchange was shut, or carried across a restart) has not
   * been reached by anyone: it trades at the market's price, which is better.
   */
  seated: boolean;
}

/**
 * Everything one decision changes: the orders it touched (in the order they
 * should be reported), the shares that traded, and which positions and
 * balances moved. finish() turns it into one journal entry and the events.
 */
class Step {
  readonly orders = new Map<string, OrderRow>();
  readonly executions: ExecutionWrite[] = [];
  readonly tickers = new Set<string>();
  readonly fills = new Map<string, { quantity: number; notional: Decimal }>();
  /** Cash, realized P&L or commission changed. */
  balances = false;
  /** The competition is over and this is its final result: equity is cash and there is nothing left to buy with. */
  final = false;

  constructor(readonly account: LiveAccount) {}

  touch(order: OrderRow): void {
    this.orders.set(order.id, order);
  }
}

/** Decimals a position's average price is kept to: enough that re-averaging over any number of fills does not drift. */
const AVERAGE_DECIMALS = 10;
const SWEEP_MS = 1_000;
/** A symbol silent for this long has stopped trading; its next quote is a reopening. Never shorter than a quote stays usable. */
const REOPEN_AFTER_MS = Math.max(config.trading.maxQuoteAgeMs, 60_000);
const MARGIN_SWEEP_MS = 2_000;
const RECONCILE_MS = 30_000;

/**
 * Simulated execution venue.
 *
 *  - Every account it trades is held in memory (ledger.ts). An order is
 *    checked, matched and answered there, in one thread, with no waiting: that
 *    is what makes an order take microseconds. Each decision is journalled
 *    before it is answered and written to Postgres just behind (store.ts).
 *  - Orders trade against the Level 2 book (market/depth.ts). An order that
 *    takes liquidity works through the book level by level, so a large one
 *    fills in pieces at successively worse prices; whatever the book cannot
 *    give it straight away keeps working and fills as the book refills.
 *  - Limit orders that are not marketable, and stop orders, rest in an
 *    in-memory book and are looked at again on every quote for their symbol.
 *    A resting limit order fills at its own price, for as many shares as the
 *    market is offering there.
 *  - Commission is charged per share on every execution.
 *  - An entry may carry a bracket. As it fills, its take-profit and stop-loss
 *    become resting exit orders of the same size. Exits are reduce-only and one
 *    cancels the other; closing the position by any other route cancels them.
 *  - Accounts whose equity falls below the maintenance margin are liquidated:
 *    their working orders are cancelled and their positions closed at market.
 *  - When a competition ends, its working orders are cancelled and every
 *    position is closed at the final price, so each result is plain cash.
 *
 * Because one thread does all of this, two orders can never both spend the
 * same buying power: there is no moment between checking an account and
 * changing it at which anything else runs. The state lives in this process, so
 * run exactly one engine instance.
 */
export class MatchingEngine extends EventEmitter<{ order: [OrderEvent] }> {
  /** symbol -> order id -> resting order */
  private readonly book = new Map<string, Map<string, RestingOrder>>();
  private readonly ledger = new Ledger();
  private readonly store = new Store(config.engine.journal);
  private sweepTimer: NodeJS.Timeout | undefined;
  private marginTimer: NodeJS.Timeout | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private settling = false;
  /** When each symbol last traded, to tell a market that has just reopened from one that is simply ticking. */
  private readonly lastQuoteAt = new Map<string, number>();
  private readonly quoteListener = (quote: Quote) => this.onQuote(quote);
  private readonly markOf = (ticker: string) => this.market.getMark(ticker);

  constructor(private readonly market: MarketDataService) {
    super();
  }

  /** Brings the database up to date with the journal, loads every account the market can act on, and starts listening to quotes. */
  async start(): Promise<void> {
    await this.store.open();

    // Orders left open in a competition that has already been settled can never trade.
    await pool.query(
      `UPDATE orders o
          SET status = 'CANCELLED', reject_reason = 'Competition ended'
         FROM portfolios p
         JOIN competitions c ON c.id = p.competition_id
        WHERE o.portfolio_id = p.id AND o.status = 'OPEN' AND c.settled_at IS NOT NULL`,
    );

    const { rows } = await pool.query<{ id: string }>(
      `SELECT p.id
         FROM portfolios p
         JOIN competitions c ON c.id = p.competition_id
        WHERE c.settled_at IS NULL
          AND (EXISTS (SELECT 1 FROM positions pos WHERE pos.portfolio_id = p.id)
            OR EXISTS (SELECT 1 FROM orders o WHERE o.portfolio_id = p.id AND o.status = 'OPEN'))`,
    );
    for (let i = 0; i < rows.length; i += 16) await Promise.all(rows.slice(i, i + 16).map((row) => this.ledger.load(row.id)));

    const tickers = new Set<string>();
    let resting = 0;
    for (const account of this.ledger.all()) {
      for (const ticker of account.positions.keys()) tickers.add(ticker);
      for (const order of account.working.values()) {
        this.rest(order, false); // the market may have moved while nothing was watching
        tickers.add(order.ticker);
        resting++;
      }
    }
    // Anything held or working must keep streaming so it can be marked and matched.
    await Promise.all([...tickers].map((ticker) => this.market.pin(ticker)));

    this.market.on('quote', this.quoteListener);
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.sweepTimer.unref();
    this.marginTimer = setInterval(() => this.checkMargins(), MARGIN_SWEEP_MS);
    this.marginTimer.unref();
    this.reconcileTimer = setInterval(() => void this.forgetDeleted(), RECONCILE_MS);
    this.reconcileTimer.unref();
    logger.info(`Matching engine online (${this.ledger.size} accounts in memory, ${resting} resting orders restored)`);
  }

  /** Stops trading and waits for everything decided to reach the database. */
  async stop(): Promise<void> {
    clearInterval(this.sweepTimer);
    clearInterval(this.marginTimer);
    clearInterval(this.reconcileTimer);
    this.market.off('quote', this.quoteListener);
    await this.store.close();
  }

  /** A trader's account in a competition, loading it if this is the first time it is needed. */
  accountFor(userId: string, competitionId: string): Promise<LiveAccount | null> {
    return this.ledger.forUser(userId, competitionId);
  }

  account(portfolioId: string): Promise<LiveAccount | null> {
    return this.ledger.load(portfolioId);
  }

  /** One of an account's working orders, by the exchange's id or by the sender's own. */
  workingOrder(account: LiveAccount, ref: { orderId?: string | null; clientOrderId?: string | null }): OrderRow | undefined {
    const id = ref.orderId ?? (ref.clientOrderId ? account.clientIds.get(ref.clientOrderId) : undefined);
    return id ? account.working.get(id) : undefined;
  }

  /** Resolves once everything decided so far is in the database. Await it before reading orders or fills from there. */
  drained(): Promise<void> {
    return this.store.drained();
  }

  /** For health checks. */
  get stats(): { accounts: number; restingOrders: number; unwritten: number; writeLagMs: number; journalBytes: number } {
    return { accounts: this.ledger.size, restingOrders: this.restingCount, unwritten: this.store.pending, writeLagMs: this.store.lagMs, journalBytes: this.store.journalBytes };
  }

  get restingCount(): number {
    let total = 0;
    for (const orders of this.book.values()) total += orders.size;
    return total;
  }

  /**
   * Accepts a new order. Throws ORDER_REJECTED (nothing is recorded) when a
   * trading rule refuses it; otherwise returns the order as FILLED, or as OPEN
   * with whatever part of it has already traded.
   */
  async submit(input: NewOrder): Promise<OrderDto> {
    // Only the first order an account ever sends waits here; after that the account is in memory.
    const account = this.ledger.get(input.portfolioId) ?? (await this.ledger.load(input.portfolioId));
    if (!account || account.userId !== input.userId) throw notFound('Portfolio not found');
    return this.place(account, input);
  }

  /** The whole life of an arriving order, start to finish, with nothing awaited: nothing else can run in between. */
  private place(account: LiveAccount, input: NewOrder): OrderDto {
    if (this.store.pending > MAX_PENDING_WRITES) throw new AppError(503, 'BUSY', 'The exchange is catching up with its records. Send it again in a moment.');

    const quote = this.market.getQuote(input.ticker);
    const depth = this.market.getDepth(input.ticker);
    if (!quote || !depth) throw orderRejected(`No live quote is available for ${input.ticker}.`);

    const fresh = this.market.tradable(quote);
    const slippage = config.trading.slippagePerShare;
    const limit = input.limitPrice === null ? null : new Decimal(input.limitPrice);
    const stop = input.stopPrice === null ? null : new Decimal(input.stopPrice);

    /** What the book gives this order the moment it arrives. Empty when all of it has to wait. */
    let pieces: Piece[] = [];
    /** Worst price the order could trade at, for the buying power check. */
    let riskPrice: Decimal;

    if (stop !== null) {
      // A stop that the market has already passed would fire instantly, which is never what was meant.
      if (fresh && stopTriggered(input.side, input.stopPrice!, quote)) {
        throw orderRejected(
          input.side === 'BUY'
            ? `A buy stop must be above the current ask (${quote.ask.toFixed(2)}). To buy now, use a market or limit order.`
            : `A sell stop must be below the current bid (${quote.bid.toFixed(2)}). To sell now, use a market or limit order.`,
        );
      }
      riskPrice = limit ?? (input.side === 'BUY' ? stop.plus(slippage) : stop);
    } else if (limit !== null) {
      // Never trade against a stale quote or a closed market; the order rests until the market ticks again.
      if (fresh) pieces = takeLiquidity(input.side, input.quantity, limit, depth, slippage);
      riskPrice = limit;
    } else {
      if (!fresh) throw orderRejected(this.market.whyNotTradable(input.ticker));
      const touch = marketOrderPrice(input.side, quote, slippage);
      if (!touch) throw orderRejected(`${input.ticker} has no ${input.side === 'BUY' ? 'offer' : 'bid'} to trade against.`);
      pieces = takeLiquidity(input.side, input.quantity, null, depth, slippage);
      // The whole order is checked at the worst price it reaches now; a part that has to wait is checked again when it trades.
      riskPrice = pieces.at(-1)?.price ?? touch;
    }

    const timeInForce = input.timeInForce ?? 'GTC';
    if (timeInForce !== 'GTC') {
      if (stop !== null) throw orderRejected('Immediate-or-cancel and fill-or-kill apply to market and limit orders, not to stops.');
      const available = sharesIn(pieces);
      if (timeInForce === 'FOK' && available < input.quantity) {
        throw orderRejected(`Fill-or-kill: only ${available} of ${input.quantity} shares can trade at once${limit ? ' within the limit' : ''}, so nothing was done.`);
      }
    }
    // The price on the order's own side when it arrived; its fills are measured against this.
    const arrival = input.side === 'BUY' ? quote.ask : quote.bid;

    const takeProfit = input.takeProfit ?? null;
    const stopLoss = input.stopLoss ?? null;
    const bracketed = takeProfit !== null || stopLoss !== null;
    if (bracketed) {
      const problem = bracketProblem(input.side, (limit ?? stop ?? riskPrice).toNumber(), takeProfit, stopLoss);
      if (problem) throw orderRejected(problem);
    }

    assertCompetitionOpen(account.rules);
    if (bracketed) {
      const held = account.positions.get(input.ticker)?.quantity ?? 0;
      if (input.side === 'BUY' ? held < 0 : held > 0) {
        throw orderRejected('A bracket belongs on an order that opens or adds to a position. This order would reduce one; send it without a take-profit or stop-loss.');
      }
    }
    if (input.clientOrderId && account.clientIds.has(input.clientOrderId)) {
      throw conflict(`Client order id ${input.clientOrderId} has already been used in this account.`);
    }

    const decision = checkOrderRisk({
      cash: account.cash,
      leverage: account.rules.leverage,
      allowShorting: account.rules.allowShorting,
      positions: account.positions,
      markOf: this.markOf,
      workingOrders: reservingOrders(account),
      commissionPerShare: account.rules.commissionPerShare,
      order: { ticker: input.ticker, side: input.side, quantity: input.quantity, price: riskPrice },
    });
    if (!decision.ok) throw orderRejected(decision.reason);

    const order = this.blank(account, {
      ticker: input.ticker,
      type: input.type,
      side: input.side,
      quantity: input.quantity,
      limit_price: limit?.toFixed(4) ?? null,
      stop_price: stop?.toFixed(4) ?? null,
      take_profit: takeProfit?.toFixed(4) ?? null,
      stop_loss: stopLoss?.toFixed(4) ?? null,
      time_in_force: timeInForce,
      client_order_id: input.clientOrderId ?? null,
      arrival_price: arrival > 0 ? arrival.toFixed(4) : null,
    });
    const step = new Step(account);
    step.touch(order);
    if (pieces.length) this.execute(step, order, pieces);
    if (timeInForce === 'IOC' && order.status === 'OPEN') {
      // Immediate-or-cancel: whatever the book did not give at once is cancelled, never left resting.
      order.status = 'CANCELLED';
      order.reject_reason = 'Immediate-or-cancel: the unfilled part was cancelled';
    }
    this.finish(step);
    return toOrderDto(order);
  }

  async cancel(orderId: string, userId: string): Promise<OrderDto> {
    const account = this.ledger.ownerOf(orderId);
    const order = account?.working.get(orderId);
    if (account && order && account.userId === userId && order.status === 'OPEN') {
      order.status = 'CANCELLED';
      const step = new Step(account);
      step.touch(order);
      this.finish(step);
      return toOrderDto(order);
    }

    // It is not working. Say whether it never existed or is already finished; that is in the database.
    await this.store.drained();
    const existing = await pool.query<{ status: string }>('SELECT o.status FROM orders o JOIN portfolios p ON p.id = o.portfolio_id WHERE o.id = $1 AND p.user_id = $2', [orderId, userId]);
    if (!existing.rows[0]) throw notFound('Order not found');
    throw conflict(`Order is already ${existing.rows[0].status.toLowerCase()}.`);
  }

  private onQuote(quote: Quote): void {
    // The first quote after a silence (the opening bell, or a feed coming back) is a market that
    // has moved without trading: nobody waiting through it has been reached at their own price.
    const previous = this.lastQuoteAt.get(quote.symbol);
    this.lastQuoteAt.set(quote.symbol, quote.ts);
    const reopened = previous !== undefined && quote.ts - previous > REOPEN_AFTER_MS;

    const orders = this.book.get(quote.symbol);
    if (!orders) return;
    const tradable = this.market.tradable(quote);
    let depth: DepthBook | null | undefined;
    const due: RestingOrder[] = [];
    for (const resting of orders.values()) {
      if (reopened) resting.seated = false;
      if (resting.waitingFor === 'STOP') {
        if (stopTriggered(resting.side, resting.price, quote)) due.push(resting);
        continue;
      }
      if (depth === undefined) depth = this.market.getDepth(quote.symbol);
      if (!depth) continue;
      const reached = resting.waitingFor === 'LIMIT' && restingOrderTriggered(resting.side, resting.price, quote);
      const offered =
        resting.waitingFor === 'MARKET'
          ? takeLiquidity(resting.side, 1, null, depth, 0)
          : !reached
            ? []
            : resting.seated
              ? provideLiquidity(resting.side, 1, new Decimal(resting.price), depth)
              : takeLiquidity(resting.side, 1, new Decimal(resting.price), depth, 0);
      if (offered.length > 0) due.push(resting);
      // The market is trading and has not reached the order: from here on it is waiting in line.
      else if (tradable && resting.waitingFor === 'LIMIT' && !reached) resting.seated = true;
    }
    // Worked after the scan: working an order changes the book being scanned.
    for (const resting of due) {
      try {
        this.work(resting);
      } catch (err) {
        logger.error({ err, orderId: resting.id }, 'Failed to work resting order');
      }
    }
  }

  /** Acts on a resting order the market has something for: trades what it can, or wakes a stop. */
  private work(resting: RestingOrder): void {
    const account = this.ledger.ownerOf(resting.id);
    const order = account?.working.get(resting.id);
    if (!account || !order || order.status !== 'OPEN') return this.unrest(resting.ticker, resting.id);

    const step = new Step(account);
    /** Ends the order here. One that has already traded keeps its fills and is cancelled for the rest. */
    const end = (status: 'CANCELLED' | 'REJECTED', reason: string) => {
      order.status = order.filled_quantity > 0 ? 'CANCELLED' : status;
      order.reject_reason = reason;
      step.touch(order);
      this.finish(step);
    };

    if (new Date() > account.rules.endDate) return end('CANCELLED', 'Competition ended');

    const quote = this.market.getQuote(order.ticker);
    const depth = this.market.getDepth(order.ticker);
    if (!quote || !depth || !this.market.tradable(quote)) return; // nothing to trade against right now

    let remaining = order.quantity - order.filled_quantity;
    const protective = order.parent_id !== null || order.forced_by !== null;
    if (protective) {
      // An exit only ever closes what is still there. It never opens a position the other way.
      const closable = reducibleShares(account.positions.get(order.ticker)?.quantity ?? 0, order.side, remaining);
      if (closable === 0) return end('CANCELLED', 'Position already closed');
      if (closable < remaining) {
        order.quantity = order.filled_quantity + closable;
        remaining = closable;
        step.touch(order);
      }
    }

    const limit = order.limit_price === null ? null : new Decimal(order.limit_price);
    const waking = order.stop_price !== null && order.triggered_at === null;
    // Whatever is left after this has stood in a trading market.
    const maker = resting.seated;
    resting.seated = true;
    // A stop that has just been reached, any order with no limit, and a limit order the market jumped
    // past without trading all take what the book offers. A limit order the market came to is filled
    // at its own price.
    const pieces = waking || limit === null || !maker ? takeLiquidity(order.side, remaining, limit, depth, config.trading.slippagePerShare) : provideLiquidity(order.side, remaining, limit, depth);
    if (pieces.length === 0) {
      if (waking) {
        // The stop price was reached but nothing can trade yet: from here it works as a market or limit order.
        order.triggered_at = new Date();
        step.touch(order);
      }
      return this.finish(step);
    }

    if (!protective) {
      const decision = checkOrderRisk({
        cash: account.cash,
        leverage: account.rules.leverage,
        allowShorting: account.rules.allowShorting,
        positions: account.positions,
        markOf: this.markOf,
        workingOrders: reservingOrders(account).filter((o) => o.id !== order.id),
        commissionPerShare: account.rules.commissionPerShare,
        order: { ticker: order.ticker, side: order.side, quantity: sharesIn(pieces), price: averagePrice(pieces) },
      });
      if (!decision.ok) return end('REJECTED', decision.reason);
    }
    this.execute(step, order, pieces);
    this.finish(step);
  }

  /** Books the shares an order has just traded, and everything that follows from them. */
  private execute(step: Step, order: OrderRow, pieces: Piece[]): void {
    const { account } = step;
    const { rules } = account;
    const now = new Date();
    const executed = sharesIn(pieces);
    const held = account.positions.get(order.ticker);
    const before = held?.quantity ?? 0;

    // Each piece trades against the position the piece before it left behind.
    let position: PositionState | null = held ?? null;
    let cashDelta = new Decimal(0);
    let realized = new Decimal(0);
    let notional = new Decimal(0);
    for (const piece of pieces) {
      const fill = applyFill(position, order.side, piece.quantity, piece.price);
      // Kept to the ten decimals the database holds, so a restart sees exactly the basis this run traded on.
      position = fill.quantity === 0 ? null : { quantity: fill.quantity, averagePrice: fill.averagePrice.toDecimalPlaces(AVERAGE_DECIMALS) };
      cashDelta = cashDelta.plus(fill.cashDelta);
      realized = realized.plus(fill.realizedPnl);
      notional = notional.plus(piece.price.mul(piece.quantity));
      step.executions.push({
        id: randomUUID(),
        order_id: order.id,
        portfolio_id: account.id,
        ticker: order.ticker,
        side: order.side,
        quantity: piece.quantity,
        price: piece.price.toFixed(4),
        commission: rules.commissionPerShare.mul(piece.quantity).toFixed(4),
        realized_pnl: fill.realizedPnl.toFixed(4),
        executed_at: now.toISOString(),
      });
    }
    const after = position?.quantity ?? 0;
    const commission = rules.commissionPerShare.mul(executed);

    if (position === null) account.positions.delete(order.ticker);
    // A position that went through zero is a new position on the other side.
    else account.positions.set(order.ticker, { ...position, openedAt: held && Math.sign(before) === Math.sign(after) ? held.openedAt : now });
    step.tickers.add(order.ticker);

    account.cash = account.cash.plus(cashDelta).minus(commission);
    account.realizedPnl = account.realizedPnl.plus(realized);
    account.commissions = account.commissions.plus(commission);
    step.balances = true;

    // fill_price is the average over everything the order has traded so far.
    const filled = order.filled_quantity + executed;
    order.fill_price = new Decimal(order.fill_price ?? 0).mul(order.filled_quantity).plus(notional).div(filled).toFixed(4);
    order.filled_quantity = filled;
    order.realized_pnl = new Decimal(order.realized_pnl ?? 0).plus(realized).toFixed(4);
    order.commission = new Decimal(order.commission).plus(commission).toFixed(4);
    order.filled_at = now;
    if (filled >= order.quantity) order.status = 'FILLED';
    if (order.stop_price !== null && order.triggered_at === null) order.triggered_at = now;
    step.touch(order);
    const earlier = step.fills.get(order.id);
    step.fills.set(order.id, { quantity: (earlier?.quantity ?? 0) + executed, notional: (earlier?.notional ?? new Decimal(0)).plus(notional) });

    // Protective orders this makes redundant: the other side of a bracket whose exit has completely
    // filled, and, once the position is flat or has flipped, everything that was guarding it. Those
    // that stay are never left larger than the position they would close.
    const positionGone = before !== 0 && Math.sign(after) !== Math.sign(before);
    const exitDone = order.parent_id !== null && order.status === 'FILLED';
    for (const other of account.working.values()) {
      if (other.id === order.id || other.ticker !== order.ticker || other.status !== 'OPEN') continue;
      if (other.parent_id === null && other.forced_by === null) continue;
      const partner = exitDone && other.parent_id === order.parent_id;
      if (partner || positionGone) {
        other.status = 'CANCELLED';
        other.reject_reason = partner ? 'The other side of the bracket filled' : 'Position closed';
        step.touch(other);
      } else if (after !== 0 && other.side === (after > 0 ? 'SELL' : 'BUY') && other.quantity - other.filled_quantity > Math.abs(after)) {
        other.quantity = other.filled_quantity + Math.abs(after);
        step.touch(other);
      }
    }

    // An entry's bracket goes to work as the entry fills, sized to what has filled.
    const exitSide: OrderSide = order.side === 'BUY' ? 'SELL' : 'BUY';
    const protectable = reducibleShares(after, exitSide, executed);
    if (protectable > 0 && (order.take_profit !== null || order.stop_loss !== null)) {
      const exits = [...account.working.values()].filter((o) => o.parent_id === order.id && o.status === 'OPEN');
      for (const exit of exits) {
        exit.quantity += protectable;
        step.touch(exit);
      }
      if (exits.length === 0) {
        for (const [type, price] of [
          ['LIMIT', order.take_profit],
          ['STOP', order.stop_loss],
        ] as const) {
          if (price === null) continue;
          const exit = this.blank(account, { ticker: order.ticker, type, side: exitSide, quantity: protectable, limit_price: type === 'LIMIT' ? price : null, stop_price: type === 'STOP' ? price : null, parent_id: order.id });
          // Filed at once, so a later piece of the same entry finds it and grows it.
          account.working.set(exit.id, exit);
          step.touch(exit);
        }
      }
    }
  }

  /**
   * Makes a decision real: files the orders it touched, journals what
   * changed, and tells the market and the traders. Nothing here waits.
   */
  private finish(step: Step): void {
    const { account } = step;
    if (step.orders.size === 0 && step.tickers.size === 0 && !step.balances) return;

    const valuation = valuePortfolio(account.cash, account.positions, this.markOf, account.rules.leverage);
    for (const order of step.orders.values()) {
      this.ledger.file(account, order);
      if (order.status === 'OPEN') this.rest(order);
      else this.unrest(order.ticker, order.id);
    }

    try {
      this.store.append({
        // Copies: the live rows go on changing while this waits to be written.
        orders: [...step.orders.values()].map((order) => ({ ...order })),
        executions: step.executions,
        positions: [...step.tickers].map((ticker) => {
          const position = account.positions.get(ticker);
          return position
            ? { portfolio_id: account.id, ticker, quantity: position.quantity, average_price: position.averagePrice.toFixed(AVERAGE_DECIMALS), opened_at: position.openedAt.toISOString() }
            : { portfolio_id: account.id, ticker, quantity: 0, average_price: '0', opened_at: new Date(0).toISOString() };
        }),
        portfolios: step.balances
          ? [
              {
                id: account.id,
                cash: account.cash.toFixed(4),
                realized_pnl: account.realizedPnl.toFixed(4),
                commissions: account.commissions.toFixed(4),
                total_equity: (step.final ? account.cash : valuation.equity).toFixed(4),
                buying_power: step.final ? '0' : valuation.buyingPower.toFixed(4),
              },
            ]
          : [],
      });
    } catch (err) {
      // Memory has changed and the change could not be recorded (a full disk, say). Carrying on would
      // answer traders from a state that will not survive a restart, so stop and rebuild from the database.
      logger.fatal({ err }, 'The engine could not write its journal. Restarting from the database.');
      process.exit(1);
    }

    const equity = valuation.equity.toDecimalPlaces(2).toNumber();
    for (const [orderId, fill] of step.fills) {
      const order = step.orders.get(orderId)!;
      this.market.reportFill(order.ticker, order.side, fill.quantity);
    }
    for (const order of step.orders.values()) {
      const fill = step.fills.get(order.id);
      this.emit('order', {
        userId: account.userId,
        competitionId: account.competitionId,
        order: toOrderDto(order),
        ...(fill ? { fill: { quantity: fill.quantity, price: fill.notional.div(fill.quantity).toDecimalPlaces(4).toNumber(), equity } } : {}),
      });
    }
  }

  /**
   * Margin call. Cancels everything the account has working and closes every
   * position at the market. Does nothing if the account is not in fact below
   * its maintenance margin. Returns whether it liquidated.
   */
  async liquidate(portfolioId: string): Promise<boolean> {
    const account = await this.ledger.load(portfolioId);
    return account ? this.liquidateIfCalled(account) : false;
  }

  private liquidateIfCalled(account: LiveAccount): boolean {
    if (account.positions.size === 0 || new Date() > account.rules.endDate) return false;
    const status = marginStatus(account.cash, account.positions, this.markOf, account.rules.maintenanceMargin);
    if (!status.call) return false;

    const step = new Step(account);
    for (const order of account.working.values()) {
      if (order.status !== 'OPEN') continue;
      order.status = 'CANCELLED';
      order.reject_reason = 'Margin call';
      step.touch(order);
    }
    const slippage = config.trading.slippagePerShare;
    for (const [ticker, position] of [...account.positions]) {
      const side: OrderSide = position.quantity > 0 ? 'SELL' : 'BUY';
      const order = this.blank(account, { ticker, type: 'MARKET', side, quantity: Math.abs(position.quantity), forced_by: 'MARGIN_CALL' });
      step.touch(order);
      const quote = this.market.getQuote(ticker);
      const depth = this.market.getDepth(ticker);
      const pieces = quote && depth && this.market.tradable(quote) ? takeLiquidity(side, order.quantity, null, depth, slippage) : [];
      // What the book cannot take at once keeps working as a market order until the position is gone.
      if (pieces.length) this.execute(step, order, pieces);
    }
    this.finish(step);
    logger.warn({ portfolioId: account.id, equity: status.equity.toFixed(2), exposure: status.exposure.toFixed(2) }, 'Margin call: account liquidated');
    return true;
  }

  /** Looks for accounts that have fallen below their maintenance margin and liquidates them. */
  private checkMargins(): void {
    for (const account of this.ledger.all()) {
      try {
        this.liquidateIfCalled(account);
      } catch (err) {
        logger.error({ err, portfolioId: account.id }, 'Liquidation failed');
      }
    }
  }

  /** Once a second: withdraws orders left working in competitions that have finished, then settles those competitions. */
  private async sweep(): Promise<void> {
    try {
      const now = new Date();
      for (const account of this.ledger.all()) {
        if (now <= account.rules.endDate || account.working.size === 0) continue;
        const step = new Step(account);
        for (const order of account.working.values()) {
          if (order.status !== 'OPEN') continue;
          order.status = 'CANCELLED';
          order.reject_reason = 'Competition ended';
          step.touch(order);
        }
        this.finish(step);
      }

      if (this.settling) return;
      this.settling = true;
      try {
        const { rows } = await pool.query<{ id: string; name: string }>('SELECT id, name FROM competitions WHERE end_date <= now() AND settled_at IS NULL');
        for (const competition of rows) await this.settle(competition);
      } finally {
        this.settling = false;
      }
    } catch (err) {
      logger.error({ err }, 'End-of-competition sweep failed');
    }
  }

  /**
   * Closes every position in a finished competition at the final price and
   * freezes the result, so each trader's standing is plain cash. Every account
   * holding a position is in memory, and the engine is the only thing that
   * changes an account, so a late fill and the settlement cannot interleave.
   */
  private async settle(competition: { id: string; name: string }): Promise<void> {
    for (const account of this.ledger.all()) {
      if (account.competitionId !== competition.id || account.positions.size === 0) continue;
      const step = new Step(account);
      for (const [ticker, position] of [...account.positions]) {
        const mark = this.markOf(ticker) ?? position.averagePrice; // no price: closed at cost
        account.cash = account.cash.plus(mark.mul(position.quantity));
        account.realizedPnl = account.realizedPnl.plus(mark.minus(position.averagePrice).mul(position.quantity));
        account.positions.delete(ticker);
        step.tickers.add(ticker);
      }
      step.balances = true;
      step.final = true;
      this.finish(step);
    }
    await this.store.drained();
    // Portfolios that held nothing still stop trading: no buying power, equity equal to cash.
    await pool.query('UPDATE portfolios SET total_equity = cash, buying_power = 0 WHERE competition_id = $1', [competition.id]);
    await pool.query('UPDATE competitions SET settled_at = now() WHERE id = $1 AND settled_at IS NULL', [competition.id]);
    logger.info(`Competition "${competition.name}" settled; standings are final`);
  }

  /**
   * Accounts are only ever removed from the database by an administrator
   * deleting a competition or a user out from under the engine. When that
   * happens the engine stops trading them: their working orders leave the
   * book and the account leaves memory.
   */
  private async forgetDeleted(): Promise<void> {
    try {
      const held = [...this.ledger.all()];
      if (held.length === 0) return;
      const { rows } = await pool.query<{ id: string }>('SELECT id FROM portfolios WHERE id = ANY($1::uuid[])', [held.map((account) => account.id)]);
      const present = new Set(rows.map((row) => row.id));
      for (const account of held) {
        if (present.has(account.id)) continue;
        for (const order of account.working.values()) this.unrest(order.ticker, order.id);
        this.ledger.evict(account);
        logger.warn({ portfolioId: account.id }, 'An account was deleted from the database; the engine has stopped trading it');
      }
    } catch (err) {
      logger.error({ err }, 'Could not check for deleted accounts');
    }
  }

  /** A new order for an account, with everything not given left at its starting value. */
  private blank(account: LiveAccount, given: Partial<OrderRow> & Pick<OrderRow, 'ticker' | 'type' | 'side' | 'quantity'>): OrderRow {
    return {
      id: randomUUID(),
      portfolio_id: account.id,
      status: 'OPEN',
      limit_price: null,
      stop_price: null,
      triggered_at: null,
      take_profit: null,
      stop_loss: null,
      parent_id: null,
      filled_quantity: 0,
      commission: '0.0000',
      forced_by: null,
      time_in_force: 'GTC',
      client_order_id: null,
      arrival_price: null,
      fill_price: null,
      realized_pnl: null,
      reject_reason: null,
      created_at: new Date(),
      filled_at: null,
      ...given,
    };
  }

  /** @param seated leave out to keep what is known about the order, or, for a new one, to go by whether the market is trading */
  private rest(order: OrderRow, seated?: boolean): void {
    let orders = this.book.get(order.ticker);
    if (!orders) this.book.set(order.ticker, (orders = new Map()));
    const waitingForStop = order.stop_price !== null && order.triggered_at === null;
    const quote = this.market.getQuote(order.ticker);
    orders.set(order.id, {
      seated: seated ?? orders.get(order.id)?.seated ?? (quote !== undefined && this.market.tradable(quote)),
      id: order.id,
      ticker: order.ticker,
      side: order.side,
      waitingFor: waitingForStop ? 'STOP' : order.limit_price !== null ? 'LIMIT' : 'MARKET',
      price: Number(waitingForStop ? order.stop_price : (order.limit_price ?? 0)),
    });
  }

  private unrest(ticker: string, orderId: string): void {
    const orders = this.book.get(ticker);
    if (!orders) return;
    orders.delete(orderId);
    if (orders.size === 0) this.book.delete(ticker);
  }
}

export const engine = new MatchingEngine(market);

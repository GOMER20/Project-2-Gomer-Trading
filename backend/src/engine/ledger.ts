import { Decimal } from 'decimal.js';
import { pool } from '../db/pool.js';
import type { OrderRow, PortfolioRow } from '../types.js';
import type { Account, AccountRules } from './account.js';
import type { PositionState } from './accounting.js';
import type { WorkingOrder } from './risk.js';

/**
 * Every account the engine is trading, held in memory.
 *
 * This is the authoritative state while the process runs: cash, positions and
 * working orders are read and changed here, in one thread, with nothing to
 * wait for. The database receives every change a few milliseconds later (see
 * store.ts) and is what memory is rebuilt from when the process starts.
 *
 * An account is loaded the first time anything touches it and then stays. At
 * start-up every account holding a position or a working order is loaded, so
 * anything the market can act on (a resting order, a margin call) is here.
 * The engine is the only writer of these rows; nothing else may change them
 * behind its back.
 */

export interface LivePosition extends PositionState {
  openedAt: Date;
}

export interface LiveAccount {
  /** The portfolio id. */
  id: string;
  userId: string;
  competitionId: string;
  rules: AccountRules;
  startingBalance: Decimal;
  cash: Decimal;
  realizedPnl: Decimal;
  commissions: Decimal;
  positions: Map<string, LivePosition>;
  /** Orders that are still working, by id. */
  working: Map<string, OrderRow>;
  /** Every client order id the account has used, so none is accepted twice. Maps to the order's id. */
  clientIds: Map<string, string>;
}

interface AccountRow {
  id: string;
  user_id: string;
  competition_id: string;
  cash: string;
  realized_pnl: string;
  commissions: string;
  start_date: Date;
  end_date: Date;
  allow_shorting: boolean;
  leverage: string;
  starting_balance: string;
  commission_per_share: string;
  maintenance_margin: string;
}

/**
 * The orders that reserve buying power and shares: the account's own resting
 * orders, for what is left of them. Bracket exits and liquidations are left
 * out, because they can only reduce a position.
 */
export function reservingOrders(account: LiveAccount): Array<WorkingOrder & { id: string }> {
  const reserving: Array<WorkingOrder & { id: string }> = [];
  for (const order of account.working.values()) {
    if (order.status !== 'OPEN' || order.parent_id !== null || order.forced_by !== null) continue;
    // A plain stop has no limit; its stop price is the best estimate of where it will trade.
    const price = order.limit_price ?? order.stop_price ?? order.fill_price;
    if (price === null) continue;
    reserving.push({ id: order.id, ticker: order.ticker, side: order.side, quantity: order.quantity - order.filled_quantity, limitPrice: new Decimal(price) });
  }
  return reserving;
}

/** The account in the shape the risk rules and the portfolio screens read. A snapshot: it does not follow later changes. */
export function accountView(account: LiveAccount): Account & { startingBalance: Decimal } {
  const portfolio: PortfolioRow = {
    id: account.id,
    user_id: account.userId,
    competition_id: account.competitionId,
    cash: account.cash.toFixed(4),
    buying_power: '0',
    total_equity: '0',
    realized_pnl: account.realizedPnl.toFixed(4),
    commissions: account.commissions.toFixed(4),
  };
  return { portfolio, rules: account.rules, positions: account.positions, workingOrders: reservingOrders(account), startingBalance: account.startingBalance };
}

export class Ledger {
  private readonly accounts = new Map<string, LiveAccount>();
  private readonly loading = new Map<string, Promise<LiveAccount | null>>();
  /** working order id -> the account it belongs to */
  private readonly owners = new Map<string, LiveAccount>();
  /** "user|competition" -> portfolio id */
  private readonly portfolioIds = new Map<string, string>();

  /** The account if it is already in memory. */
  get(portfolioId: string): LiveAccount | undefined {
    return this.accounts.get(portfolioId);
  }

  /** The account, read from the database if this is the first time it is needed. Null if there is no such portfolio. */
  load(portfolioId: string): Promise<LiveAccount | null> {
    const live = this.accounts.get(portfolioId);
    if (live) return Promise.resolve(live);
    let loading = this.loading.get(portfolioId);
    if (!loading) {
      loading = this.read(portfolioId).finally(() => this.loading.delete(portfolioId));
      this.loading.set(portfolioId, loading);
    }
    return loading;
  }

  /** A trader's account in a competition, or null if they are not in it. */
  async forUser(userId: string, competitionId: string): Promise<LiveAccount | null> {
    const key = `${userId}|${competitionId}`;
    let portfolioId = this.portfolioIds.get(key);
    if (!portfolioId) {
      const { rows } = await pool.query<{ id: string }>('SELECT id FROM portfolios WHERE user_id = $1 AND competition_id = $2', [userId, competitionId]);
      if (!rows[0]) return null;
      portfolioId = rows[0].id;
      this.portfolioIds.set(key, portfolioId);
    }
    const account = await this.load(portfolioId);
    // The portfolio was deleted since it was looked up; do not keep pointing at it.
    if (!account) this.portfolioIds.delete(key);
    return account;
  }

  /** Drops an account that no longer exists in the database. */
  evict(account: LiveAccount): void {
    this.accounts.delete(account.id);
    this.portfolioIds.delete(`${account.userId}|${account.competitionId}`);
    for (const orderId of account.working.keys()) this.owners.delete(orderId);
  }

  private async read(portfolioId: string): Promise<LiveAccount | null> {
    // Nothing else writes these rows, and an account that is not in memory has nothing waiting
    // to be written, so four plain reads see one consistent account.
    const [found, positions, working, clientIds] = await Promise.all([
      pool.query<AccountRow>(
        `SELECT p.id, p.user_id, p.competition_id, p.cash, p.realized_pnl, p.commissions,
                c.start_date, c.end_date, c.allow_shorting, c.leverage, c.starting_balance, c.commission_per_share, c.maintenance_margin
           FROM portfolios p
           JOIN competitions c ON c.id = p.competition_id
          WHERE p.id = $1`,
        [portfolioId],
      ),
      pool.query<{ ticker: string; quantity: number; average_price: string; opened_at: Date }>('SELECT ticker, quantity, average_price, opened_at FROM positions WHERE portfolio_id = $1', [portfolioId]),
      pool.query<OrderRow>(`SELECT * FROM orders WHERE portfolio_id = $1 AND status = 'OPEN'`, [portfolioId]),
      pool.query<{ client_order_id: string; id: string }>('SELECT client_order_id, id FROM orders WHERE portfolio_id = $1 AND client_order_id IS NOT NULL', [portfolioId]),
    ]);
    const row = found.rows[0];
    if (!row) return null;
    // Two first requests for one account can both get here; the one that finished first stands.
    const existing = this.accounts.get(portfolioId);
    if (existing) return existing;

    const account: LiveAccount = {
      id: row.id,
      userId: row.user_id,
      competitionId: row.competition_id,
      rules: {
        startDate: row.start_date,
        endDate: row.end_date,
        allowShorting: row.allow_shorting,
        leverage: new Decimal(row.leverage),
        commissionPerShare: new Decimal(row.commission_per_share),
        maintenanceMargin: new Decimal(row.maintenance_margin),
      },
      startingBalance: new Decimal(row.starting_balance),
      cash: new Decimal(row.cash),
      realizedPnl: new Decimal(row.realized_pnl),
      commissions: new Decimal(row.commissions),
      positions: new Map(positions.rows.map((p) => [p.ticker, { quantity: p.quantity, averagePrice: new Decimal(p.average_price), openedAt: p.opened_at }])),
      working: new Map(working.rows.map((order) => [order.id, order])),
      clientIds: new Map(clientIds.rows.map((c) => [c.client_order_id, c.id])),
    };
    this.accounts.set(account.id, account);
    this.portfolioIds.set(`${account.userId}|${account.competitionId}`, account.id);
    for (const order of account.working.values()) this.owners.set(order.id, account);
    return account;
  }

  /** The account a working order belongs to. */
  ownerOf(orderId: string): LiveAccount | undefined {
    return this.owners.get(orderId);
  }

  /** Keeps the account's list of working orders, and the index of who owns them, in step with an order's status. */
  file(account: LiveAccount, order: OrderRow): void {
    if (order.status === 'OPEN') {
      account.working.set(order.id, order);
      this.owners.set(order.id, account);
    } else {
      account.working.delete(order.id);
      this.owners.delete(order.id);
    }
    if (order.client_order_id) account.clientIds.set(order.client_order_id, order.id);
  }

  all(): Iterable<LiveAccount> {
    return this.accounts.values();
  }

  get size(): number {
    return this.accounts.size;
  }
}

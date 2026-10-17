import fs from 'node:fs';
import path from 'node:path';
import { isDatabaseBusy, pool, withTransaction } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import type { OrderRow, OrderSide } from '../types.js';

/**
 * How the engine's decisions reach the database.
 *
 * The engine keeps every account in memory and answers an order the moment it
 * has decided it. Waiting for the database is what used to cost two
 * milliseconds an order. Instead, each decision becomes a WriteSet: the rows
 * as they now stand. A WriteSet is
 *
 *   1. appended to a journal file, synchronously, before the order is answered;
 *   2. queued for the writer, which applies queued sets to Postgres in order,
 *      many at a time in one transaction, a few milliseconds behind.
 *
 * If the process dies, whatever was journalled but not yet in the database is
 * replayed on the next start. The database records the sequence number it has
 * reached in the same transaction as the rows, so replay is exact.
 *
 * What the journal does not survive is the machine itself losing power: it is
 * handed to the operating system on every order but only forced to disk a few
 * times a second, so the last fraction of a second of orders can be lost with
 * the machine. The database itself is never left inconsistent.
 */

export interface ExecutionWrite {
  id: string;
  order_id: string;
  portfolio_id: string;
  ticker: string;
  side: OrderSide;
  quantity: number;
  price: string;
  commission: string;
  realized_pnl: string;
  executed_at: string;
}

/** A position as it now stands. Quantity 0 means the position is closed and its row goes. */
export interface PositionWrite {
  portfolio_id: string;
  ticker: string;
  quantity: number;
  average_price: string;
  opened_at: string;
}

export interface PortfolioWrite {
  id: string;
  cash: string;
  realized_pnl: string;
  commissions: string;
  total_equity: string;
  buying_power: string;
}

export interface WriteSet {
  seq: number;
  orders: OrderRow[];
  executions: ExecutionWrite[];
  positions: PositionWrite[];
  portfolios: PortfolioWrite[];
  /** A competition's starting money, changed together with every account's cash (see setStartingBalance). */
  competitions?: CompetitionWrite[];
}

export interface CompetitionWrite {
  id: string;
  starting_balance: string;
}

const MAX_BATCH = 400;
const SYNC_EVERY_MS = 250;
/**
 * Under steady load the writer is always a little behind, so the journal is
 * never completely redundant and cannot simply be emptied. Past this size it
 * is rewritten to hold only what the database has not yet received.
 */
const COMPACT_ABOVE_BYTES = Number(process.env.ENGINE_JOURNAL_MAX_BYTES) || 16 * 1024 * 1024;
/** Past this many unwritten sets the database is not keeping up, and new orders are turned away. */
export const MAX_PENDING_WRITES = 20_000;

const ORDER_COLUMNS = [
  'id',
  'portfolio_id',
  'ticker',
  'type',
  'side',
  'status',
  'quantity',
  'limit_price',
  'stop_price',
  'triggered_at',
  'take_profit',
  'stop_loss',
  'parent_id',
  'filled_quantity',
  'commission',
  'forced_by',
  'time_in_force',
  'client_order_id',
  'arrival_price',
  'fill_price',
  'realized_pnl',
  'reject_reason',
  'created_at',
  'filled_at',
] as const;
/** What can change about an order after it is first written. */
const ORDER_MUTABLE = ['status', 'quantity', 'triggered_at', 'filled_quantity', 'commission', 'fill_price', 'realized_pnl', 'reject_reason', 'filled_at'] as const;

/**
 * Applies a run of write sets in one transaction. Later sets overwrite earlier
 * ones row by row, which is safe precisely because the whole run commits or
 * none of it does. Every statement is idempotent, so replaying a set that was
 * already applied changes nothing. Rows for an account that has since been
 * deleted from the database (a competition or a user removed) are skipped:
 * there is nowhere left to write them.
 */
async function apply(sets: WriteSet[]): Promise<void> {
  const orders = new Map<string, OrderRow>();
  const positions = new Map<string, PositionWrite>();
  const portfolios = new Map<string, PortfolioWrite>();
  const competitions = new Map<string, CompetitionWrite>();
  const executions: ExecutionWrite[] = [];
  for (const set of sets) {
    for (const order of set.orders) orders.set(order.id, order);
    for (const position of set.positions) positions.set(`${position.portfolio_id}|${position.ticker}`, position);
    for (const portfolio of set.portfolios) portfolios.set(portfolio.id, portfolio);
    for (const competition of set.competitions ?? []) competitions.set(competition.id, competition);
    executions.push(...set.executions);
  }
  const closed = [...positions.values()].filter((p) => p.quantity === 0);
  const held = [...positions.values()].filter((p) => p.quantity !== 0);

  await withTransaction(async (client) => {
    if (orders.size) {
      await client.query(
        `INSERT INTO orders (${ORDER_COLUMNS.join(', ')})
         SELECT ${ORDER_COLUMNS.join(', ')} FROM json_populate_recordset(NULL::orders, $1::json) AS written
          WHERE EXISTS (SELECT 1 FROM portfolios p WHERE p.id = written.portfolio_id)
         ON CONFLICT (id) DO UPDATE SET ${ORDER_MUTABLE.map((column) => `${column} = EXCLUDED.${column}`).join(', ')}`,
        [JSON.stringify([...orders.values()])],
      );
    }
    if (executions.length) {
      await client.query(
        `INSERT INTO executions (id, order_id, portfolio_id, ticker, side, quantity, price, commission, realized_pnl, executed_at)
         SELECT id, order_id, portfolio_id, ticker, side, quantity, price, commission, realized_pnl, executed_at
           FROM json_populate_recordset(NULL::executions, $1::json) AS written
          WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = written.order_id)
         ON CONFLICT (id) DO NOTHING`,
        [JSON.stringify(executions)],
      );
    }
    if (closed.length) {
      await client.query(
        `DELETE FROM positions p
          USING json_to_recordset($1::json) AS gone(portfolio_id uuid, ticker text)
          WHERE p.portfolio_id = gone.portfolio_id AND p.ticker = gone.ticker`,
        [JSON.stringify(closed)],
      );
    }
    if (held.length) {
      await client.query(
        `INSERT INTO positions (portfolio_id, ticker, quantity, average_price, opened_at)
         SELECT portfolio_id, ticker, quantity, average_price, opened_at
           FROM json_to_recordset($1::json) AS now(portfolio_id uuid, ticker text, quantity integer, average_price numeric, opened_at timestamptz)
          WHERE EXISTS (SELECT 1 FROM portfolios p WHERE p.id = now.portfolio_id)
         ON CONFLICT (portfolio_id, ticker) DO UPDATE
            SET quantity = EXCLUDED.quantity, average_price = EXCLUDED.average_price, opened_at = EXCLUDED.opened_at`,
        [JSON.stringify(held)],
      );
    }
    if (portfolios.size) {
      await client.query(
        `UPDATE portfolios p
            SET cash = now.cash, realized_pnl = now.realized_pnl, commissions = now.commissions,
                total_equity = now.total_equity, buying_power = now.buying_power
           FROM json_to_recordset($1::json) AS now(id uuid, cash numeric, realized_pnl numeric, commissions numeric, total_equity numeric, buying_power numeric)
          WHERE p.id = now.id`,
        [JSON.stringify([...portfolios.values()])],
      );
    }
    if (competitions.size) {
      await client.query(
        `UPDATE competitions c SET starting_balance = now.starting_balance
           FROM json_to_recordset($1::json) AS now(id uuid, starting_balance numeric)
          WHERE c.id = now.id`,
        [JSON.stringify([...competitions.values()])],
      );
    }
    await client.query('UPDATE engine_journal SET applied_seq = $1 WHERE applied_seq < $1', [sets.at(-1)!.seq]);
  });
}

/** A deadlock or a moment of overload is worth trying again. Anything else is a write the database will never accept. */
const transient = (err: unknown) => isDatabaseBusy(err) || ['40P01', '40001', '55P03'].includes((err as { code?: string } | null)?.code ?? '');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Store {
  private fd: number | null = null;
  private journalId = '';
  private seq = 0;
  private applied = 0;
  private bytes = 0;
  private dirty = false;
  private readonly queue: WriteSet[] = [];
  private writing = false;
  private readonly waiters: Array<{ seq: number; resolve: () => void }> = [];
  private syncTimer: NodeJS.Timeout | undefined;
  private oldestQueuedAt = 0;

  constructor(private readonly file: string) {}

  /** Opens the journal, replaying into the database anything a previous run decided but did not get to write. */
  async open(): Promise<void> {
    const { rows } = await pool.query<{ journal_id: string; applied_seq: string }>('SELECT journal_id, applied_seq FROM engine_journal');
    if (!rows[0]) throw new Error('engine_journal is empty; run the migrations');
    this.journalId = rows[0].journal_id;
    this.applied = Number(rows[0].applied_seq);
    this.seq = this.applied;

    const unapplied = this.readJournal().filter((set) => set.seq > this.applied);
    if (unapplied.length) {
      logger.warn(`Replaying ${unapplied.length} journalled step(s) the database had not received`);
      try {
        for (let i = 0; i < unapplied.length; i += MAX_BATCH) await apply(unapplied.slice(i, i + MAX_BATCH));
        this.applied = this.seq = unapplied.at(-1)!.seq;
      } catch (err) {
        // The database will not take these. Keep the file for a person to look at, and carry on from what the database holds.
        const aside = `${this.file}.rejected-${Date.now()}`;
        fs.renameSync(this.file, aside);
        logger.error({ err }, `The journal could not be replayed and was set aside as ${aside}. Continuing from the database as it stands.`);
      }
    }

    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.fd = fs.openSync(this.file, 'w', 0o600);
    this.writeHeader();
    this.syncTimer = setInterval(() => this.sync(), SYNC_EVERY_MS);
    this.syncTimer.unref();
  }

  /** Journal entries written by a previous run for this same database. Empty for any other file. */
  private readJournal(): WriteSet[] {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const [header, ...lines] = text.split('\n');
    try {
      if ((JSON.parse(header ?? '') as { journal?: string }).journal !== this.journalId) return [];
    } catch {
      return [];
    }
    const sets: WriteSet[] = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        sets.push(JSON.parse(line) as WriteSet);
      } catch {
        break; // a line cut short by the machine stopping: nothing after it was ever acknowledged
      }
    }
    return sets;
  }

  private writeHeader(): void {
    const header = `${JSON.stringify({ journal: this.journalId })}\n`;
    fs.ftruncateSync(this.fd!, 0);
    fs.writeSync(this.fd!, header, 0);
    this.bytes = Buffer.byteLength(header);
  }

  /**
   * Rewrites the journal with only the decisions the database does not have
   * yet. The new file is written whole and then renamed over the old one, so
   * at every instant there is one complete journal on disk.
   */
  private compact(): void {
    const kept = `${[JSON.stringify({ journal: this.journalId }), ...this.queue.map((set) => JSON.stringify(set))].join('\n')}\n`;
    const next = `${this.file}.compacting`;
    fs.writeFileSync(next, kept, { mode: 0o600 });
    fs.renameSync(next, this.file);
    fs.closeSync(this.fd!);
    this.fd = fs.openSync(this.file, 'r+');
    this.bytes = Buffer.byteLength(kept);
    this.dirty = true;
  }

  private sync(): void {
    if (!this.dirty || this.fd === null) return;
    this.dirty = false;
    fs.fdatasync(this.fd, () => undefined);
  }

  /**
   * Records one decision. Returns once it is in the journal, which is the
   * moment it is safe to tell the trader. The database follows.
   */
  append(change: Omit<WriteSet, 'seq'>): void {
    const set: WriteSet = { seq: ++this.seq, ...change };
    const line = `${JSON.stringify(set)}\n`;
    fs.writeSync(this.fd!, line, this.bytes);
    this.bytes += Buffer.byteLength(line);
    this.dirty = true;
    if (this.queue.length === 0) this.oldestQueuedAt = Date.now();
    this.queue.push(set);
    if (!this.writing) void this.write();
  }

  private async write(): Promise<void> {
    this.writing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.slice(0, MAX_BATCH);
        for (let attempt = 1; ; attempt++) {
          try {
            await apply(batch);
            break;
          } catch (err) {
            if (!transient(err) && attempt >= 3) return this.fail(err);
            logger.warn({ err: (err as Error).message, attempt }, 'Writing to the database failed; trying again');
            await sleep(Math.min(2000, 50 * 2 ** attempt));
          }
        }
        this.queue.splice(0, batch.length);
        this.applied = batch.at(-1)!.seq;
        this.oldestQueuedAt = this.queue.length ? Date.now() : 0;
        while (this.waiters.length && this.waiters[0]!.seq <= this.applied) this.waiters.shift()!.resolve();
        // Everything decided is now in the database, so the journal has nothing left to say.
        if (this.queue.length === 0 && this.bytes > 4096) this.writeHeader();
        else if (this.bytes > COMPACT_ABOVE_BYTES) this.compact();
      }
    } finally {
      this.writing = false;
    }
  }

  /**
   * The database has refused something the engine decided, which can only be
   * a defect. Memory and the database now disagree, and memory cannot be
   * trusted over a database that enforces the rules. Stop: the supervisor
   * restarts the process, which rebuilds memory from the database.
   */
  private fail(err: unknown): void {
    logger.fatal({ err }, 'The database refused a write the engine had already decided. Restarting from the database.');
    try {
      fs.renameSync(this.file, `${this.file}.rejected-${Date.now()}`);
    } catch {
      // nothing to set aside
    }
    process.exit(1);
  }

  /** Resolves once everything decided so far is in the database. For anything that then reads the database. */
  drained(): Promise<void> {
    if (this.applied >= this.seq) return Promise.resolve();
    const seq = this.seq;
    return new Promise((resolve) => this.waiters.push({ seq, resolve }));
  }

  get pending(): number {
    return this.queue.length;
  }

  /** How long the oldest unwritten decision has been waiting, in milliseconds. */
  get lagMs(): number {
    return this.oldestQueuedAt ? Date.now() - this.oldestQueuedAt : 0;
  }

  get journalBytes(): number {
    return this.bytes;
  }

  async close(): Promise<void> {
    clearInterval(this.syncTimer);
    await this.drained();
    if (this.fd === null) return;
    // A clean stop leaves nothing to replay.
    this.writeHeader();
    fs.closeSync(this.fd);
    this.fd = null;
  }
}

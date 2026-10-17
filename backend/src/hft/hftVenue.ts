import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { buildBook } from '../market/depth.js';
import type { OrderSide, Quote, TimeInForce } from '../types.js';
import { bookFor, inBook, toCents } from './house.js';
import { HftClient, HftOrderType, HftSide, type HftAccepted, type HftBook, type HftCancelAnswer, type HftFill, type HftLevel } from './hftClient.js';

/**
 * The realistic sandbox: HFT decides the fills.
 *
 * A competition whose fill model is "hft" is not traded by the server's own
 * engine against a modelled book. Its orders go, after a delay, to an HFT of
 * its own (a second HFT process, separate from the one in test mode), and
 * what HFT does with them is what happens:
 *
 *  - The market's own liquidity, "the house", rests in HFT's books as real
 *    orders: for every quote, the Level 2 book market/depth.ts models for it,
 *    ten levels a side. When the quote changes, HFT moves the house's orders,
 *    and if that takes the house through a resting order (the offer falls to
 *    a resting bid, say), the order trades at its own price.
 *  - Orders wait in line. One joins the back of the queue at its price, behind
 *    the house's orders already there. The house cancels its newest orders
 *    first when it shows less, so a cancellation never moves anyone up.
 *  - The market's trades are real orders. Each print in the feed (a change in
 *    the last sale) goes into HFT as an immediate-or-cancel order from "the
 *    street", at the print's price and size, and trades with the queue it
 *    meets in time priority: the house first, then whoever joined later.
 *  - Everything takes time. An order or a cancel reaches HFT `delayMs` after
 *    it was sent, a little more at random (the order-delay model, below), so
 *    an order can fill while its cancel is on the way.
 *
 * The engine still owns every account: it checks each order's risk, books
 * every fill, and reports it. Only the matching happens here. A market order
 * here trades what the book holds and has the rest cancelled, as an IOC does.
 *
 * If HFT stops, it is started again and every order still working is sent to
 * it afresh; those orders lose their places in the queue.
 *
 * Disk: HFT records its sessions, capped at `recordLimitMb` a session with
 * `keepSessions` kept, as the test-mode HFT does.
 */

export type VenueState = 'idle' | 'starting' | 'running' | 'down' | 'unavailable';

export interface VenueOrder {
  id: string;
  ticker: string;
  side: OrderSide;
  /** Shares still to trade. */
  quantity: number;
  /** Dollars; null for a market order. */
  limit: number | null;
  timeInForce: TimeInForce;
}

export interface VenueHandlers {
  /** Shares of an order traded in HFT, at `price` dollars. `maker` if it was resting. */
  fill(orderId: string, price: number, quantity: number, maker: boolean): void;
  /**
   * HFT has finished with an order that did not fill in full: cancelled as
   * asked, the part of an IOC, FOK or market order that could not trade at
   * once, or refused (a price outside its book, a symbol it does not run).
   */
  ended(orderId: string, why: 'cancelled' | 'unfilled' | 'refused'): void;
}

export interface VenueMarket {
  on(event: 'quote', listener: (quote: Quote) => void): unknown;
  off(event: 'quote', listener: (quote: Quote) => void): unknown;
  getQuote(symbol: string): Quote | undefined;
  listSymbols(): Array<{ symbol: string; name: string }>;
}

export interface HftVenueOptions {
  binary: string;
  dataDir: string;
  market: VenueMarket;
  /** Symbols to run books for first; the market's own list fills the rest. */
  symbols?: string[];
  recordLimitMb: number;
  keepSessions: number;
  /** For the order-delay model; Math.random by default. */
  random?: () => number;
  log?: { info(message: string): void; warn(message: string): void; error(message: string): void };
}

export interface VenueCounters {
  quotes: number;
  quotesSkipped: number;
  prints: number;
  printShares: number;
  /** Shares of the street's prints that traded with traders' orders, not the house. */
  printSharesToTraders: number;
  orders: number;
  cancels: number;
  fills: number;
  sharesFilled: number;
  refused: number;
}

export interface VenueStatus {
  state: VenueState;
  detail: string | null;
  since: number;
  restarts: number;
  pid: number | null;
  symbols: string[];
  /** Orders HFT is working for the sandboxes now. */
  workingOrders: number;
  counters: VenueCounters;
  dataDir: string;
  disk: { recordLimitMb: number; keepSessions: number; budgetMb: number; usedMb: number };
}

/** The tag the street's orders carry. Traders' orders count up from 2. */
const STREET = 1n;
const MAX_SYMBOLS = 64;
const MAX_BACKLOG_BYTES = 4 * 1024 * 1024;
const RESTART_DELAY_MS = [2_000, 5_000, 15_000, 60_000];
const MAX_SOCKET_PATH = 100;

/**
 * The order-delay model: how long an order or cancel takes to reach the book.
 * The configured delay, plus up to half of it again at random, so that some
 * arrive later than others the way messages over a real link do. Never less
 * than the delay asked for; zero stays zero.
 */
export function orderDelay(delayMs: number, random: () => number): number {
  return delayMs <= 0 ? 0 : delayMs * (1 + 0.5 * random());
}

/** The house's ladder for a quote: the modelled book, without what orders have taken from it lately (HFT keeps its own account of that). */
export function venueLadder(quote: Quote, book: HftBook): { bids: HftLevel[]; asks: HftLevel[] } | null {
  if (!(quote.bid > 0) || !(quote.ask > 0) || quote.bid >= quote.ask) return null;
  const depth = buildBook(quote, { bids: 0, asks: 0 }, quote.ts);
  const levels = (side: typeof depth.bids): HftLevel[] =>
    side.map((level) => ({ price: toCents(level.price), quantity: Math.round(level.size) })).filter((level) => level.quantity > 0 && inBook(book, level.price));
  return { bids: levels(depth.bids), asks: levels(depth.asks) };
}

/** What the venue remembers about one order it is working. */
interface Working {
  order: VenueOrder;
  tag: bigint;
  /** Shares sent to HFT; 0 until the order has gone. */
  sent: number;
  filled: number;
  hftOrderId: bigint | null;
  answered: boolean;
  cancelWanted: boolean;
  timer?: NodeJS.Timeout;
}

const zeroCounters = (): VenueCounters => ({
  quotes: 0,
  quotesSkipped: 0,
  prints: 0,
  printShares: 0,
  printSharesToTraders: 0,
  orders: 0,
  cancels: 0,
  fills: 0,
  sharesFilled: 0,
  refused: 0,
});

export class HftVenue {
  private state: VenueState = 'idle';
  private detail: string | null = null;
  private since = Date.now();
  private restarts = 0;
  private counters = zeroCounters();
  private child: ChildProcess | null = null;
  private client: HftClient | null = null;
  private books: HftBook[] = [];
  private readonly symbolIndex = new Map<string, number>();
  private readonly working = new Map<string, Working>();
  private readonly byTag = new Map<bigint, Working>();
  /** The last sale seen for each symbol, to tell a new print from a quote that only moved. */
  private readonly lastSale = new Map<string, { price: number; size: number | undefined }>();
  private tags = STREET;
  private handlers: VenueHandlers | null = null;
  private restartTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private readonly random: () => number;
  private readonly log: NonNullable<HftVenueOptions['log']>;
  private readonly onQuote = (quote: Quote): void => this.quote(quote);

  constructor(private readonly options: HftVenueOptions) {
    this.random = options.random ?? Math.random;
    this.log = options.log ?? { info: () => undefined, warn: () => undefined, error: () => undefined };
  }

  /** Who is told what became of each order. The engine, in the server. */
  bind(handlers: VenueHandlers): void {
    this.handlers = handlers;
  }

  /** Sends an order to HFT `delayMs` from now (and a little more, at random). Starts HFT if it is not running. */
  submit(order: VenueOrder, delayMs: number): void {
    if (this.working.has(order.id)) return;
    const working: Working = { order: { ...order }, tag: ++this.tags, sent: 0, filled: 0, hftOrderId: null, answered: false, cancelWanted: false };
    this.working.set(order.id, working);
    this.byTag.set(working.tag, working);
    this.ensureRunning();
    this.later(working, orderDelay(delayMs, this.random), () => this.send(working));
  }

  /** Asks HFT to cancel an order, `delayMs` from now. What became of it is told through ended() or fill(). */
  cancel(orderId: string, delayMs: number): void {
    const working = this.working.get(orderId);
    if (!working || working.cancelWanted) return;
    working.cancelWanted = true;
    this.later(working, orderDelay(delayMs, this.random), () => this.sendCancel(working));
  }

  /** The engine has finished with an order (its competition ended, its account went): out of HFT's book, and nothing more is said about it. */
  forget(orderId: string): void {
    const working = this.working.get(orderId);
    if (!working) return;
    clearTimeout(working.timer);
    this.drop(working);
    if (working.hftOrderId !== null) this.hftCancel(working);
  }

  /** Resolves once HFT has dealt with everything sent to it so far. */
  async settled(): Promise<void> {
    await this.client?.ping();
  }

  /** Orders being worked, by id: for the engine to see that nothing has been lost. */
  has(orderId: string): boolean {
    return this.working.has(orderId);
  }

  status(): VenueStatus {
    return {
      state: this.state,
      detail: this.detail,
      since: this.since,
      restarts: this.restarts,
      pid: this.child?.pid ?? null,
      symbols: this.books.map((book) => book.symbol),
      workingOrders: this.working.size,
      counters: { ...this.counters },
      dataDir: this.options.dataDir,
      disk: {
        recordLimitMb: this.options.recordLimitMb,
        keepSessions: this.options.keepSessions,
        budgetMb: this.options.recordLimitMb * this.options.keepSessions,
        usedMb: Math.round((this.folderBytes() / 1024 / 1024) * 10) / 10,
      },
    };
  }

  /** Starts HFT if it is not running already. Returns at once. */
  ensureRunning(): void {
    if (this.state === 'running' || this.state === 'starting' || this.stopping) return;
    if (this.state === 'down' && this.restartTimer) return; // a restart is already on its way
    if (!fs.existsSync(this.options.binary)) {
      this.become('unavailable', `The HFT program is not at ${this.options.binary}. Build it with: npm run hft:build`);
      return;
    }
    void this.launch();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.options.market.off('quote', this.onQuote);
    for (const working of this.working.values()) clearTimeout(working.timer);
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      if (!this.client?.connected) throw new Error('not connected');
      this.client.shutdown();
    } catch {
      child.kill('SIGTERM');
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(timer);
  }

  // --- Orders -----------------------------------------------------------------

  private later(working: Working, delayMs: number, action: () => void): void {
    if (delayMs <= 0) {
      action();
      return;
    }
    const timer = setTimeout(() => {
      if (working.timer === timer) working.timer = undefined;
      action();
    }, delayMs);
    timer.unref();
    working.timer = timer;
  }

  private send(working: Working): void {
    if (!this.working.has(working.order.id) || working.sent > 0) return;
    if (working.cancelWanted) {
      // Cancelled before it ever reached the book.
      this.drop(working);
      this.handlers?.ended(working.order.id, 'cancelled');
      return;
    }
    const client = this.client;
    if (this.state !== 'running' || !client?.connected) return; // sent when HFT is up: see resend()
    const { order } = working;
    const symbol = this.symbolIndex.get(order.ticker);
    const price = order.limit === null ? 0 : toCents(order.limit);
    if (symbol === undefined || (order.limit !== null && !inBook(this.books[symbol]!, price))) {
      this.counters.refused++;
      this.drop(working);
      this.handlers?.ended(order.id, 'refused');
      return;
    }
    const type = order.limit === null ? HftOrderType.Market : order.timeInForce === 'IOC' ? HftOrderType.IOC : order.timeInForce === 'FOK' ? HftOrderType.FOK : HftOrderType.Limit;
    working.sent = order.quantity - working.filled;
    working.answered = false;
    this.counters.orders++;
    client.order({ tag: working.tag, symbol, side: order.side === 'BUY' ? HftSide.Buy : HftSide.Sell, price, quantity: working.sent, type });
  }

  private sendCancel(working: Working): void {
    if (!this.working.has(working.order.id)) return;
    if (working.sent === 0) {
      clearTimeout(working.timer);
      this.drop(working);
      this.handlers?.ended(working.order.id, 'cancelled');
      return;
    }
    // Sent but not yet answered: the cancel goes when HFT says where the order is (onAccepted).
    if (working.hftOrderId !== null) this.hftCancel(working);
  }

  private hftCancel(working: Working): void {
    const symbol = this.symbolIndex.get(working.order.ticker);
    if (symbol === undefined || working.hftOrderId === null || !this.client?.connected) return;
    this.counters.cancels++;
    this.client.cancel({ tag: working.tag, symbol, orderId: working.hftOrderId });
  }

  private drop(working: Working): void {
    this.working.delete(working.order.id);
    this.byTag.delete(working.tag);
  }

  private onFill(fill: HftFill): void {
    if (fill.tag === STREET) {
      if (!fill.withHouse) this.counters.printSharesToTraders += fill.quantity;
      return;
    }
    const working = this.byTag.get(fill.tag);
    if (!working) return; // forgotten by the engine
    working.filled += fill.quantity;
    this.counters.fills++;
    this.counters.sharesFilled += fill.quantity;
    if (fill.remaining === 0 && working.filled >= working.order.quantity) this.drop(working);
    this.handlers?.fill(working.order.id, fill.price / 100, fill.quantity, fill.maker);
  }

  private onAccepted(accepted: HftAccepted): void {
    if (accepted.tag === STREET) return;
    const working = this.byTag.get(accepted.tag);
    if (!working) {
      // An order the engine has already finished with: take it out again.
      const symbol = accepted.symbol;
      if (accepted.resting > 0 && this.client?.connected) this.client.cancel({ tag: accepted.tag, symbol, orderId: accepted.orderId });
      return;
    }
    working.answered = true;
    if (accepted.resting > 0) {
      working.hftOrderId = accepted.orderId;
      if (working.cancelWanted && !working.timer) this.hftCancel(working);
      return;
    }
    // Nothing rests: it traded in full, or what it could not trade at once is gone (IOC, FOK, market).
    this.drop(working);
    if (working.filled < working.order.quantity) this.handlers?.ended(working.order.id, 'unfilled');
  }

  private onGone(answer: HftCancelAnswer, cancelled: boolean): void {
    const working = this.byTag.get(answer.tag);
    if (!working) return;
    if (cancelled) {
      this.drop(working);
      this.handlers?.ended(working.order.id, 'cancelled');
    } else if (working.filled >= working.order.quantity) {
      this.drop(working); // too late: it had filled
    }
  }

  private onRejected(tag: bigint): void {
    if (tag === STREET) return;
    const working = this.byTag.get(tag);
    if (!working) return;
    this.counters.refused++;
    this.drop(working);
    if (working.filled < working.order.quantity) this.handlers?.ended(working.order.id, working.filled > 0 ? 'unfilled' : 'refused');
  }

  /** After a restart: every order still working goes again, for what is left of it. */
  private resend(): void {
    for (const working of [...this.working.values()]) {
      working.sent = 0;
      working.hftOrderId = null;
      working.answered = false;
      if (working.timer) continue; // still on its way: it goes when its delay is up
      if (working.cancelWanted) {
        this.drop(working);
        this.handlers?.ended(working.order.id, 'cancelled');
        continue;
      }
      this.send(working);
    }
  }

  // --- The market -------------------------------------------------------------

  private quote(quote: Quote): void {
    const client = this.client;
    const symbol = this.symbolIndex.get(quote.symbol);
    if (!client?.connected || symbol === undefined) return;
    const previous = this.lastSale.get(quote.symbol);
    this.lastSale.set(quote.symbol, { price: quote.last, size: quote.lastSize });
    if (client.backlog > MAX_BACKLOG_BYTES) {
      this.counters.quotesSkipped++;
      return;
    }
    const ladder = venueLadder(quote, this.books[symbol]!);
    if (!ladder) return;
    client.quote(symbol, ladder.bids, ladder.asks);
    this.counters.quotes++;

    // A trade is a change in the last sale, as the market data feed reads it.
    const size = Math.round(quote.lastSize ?? 0);
    if (!(quote.last > 0) || size <= 0 || !previous || (previous.price === quote.last && previous.size === quote.lastSize)) return;
    const price = toCents(quote.last);
    if (!inBook(this.books[symbol]!, price)) return;
    // At or above the offer, a buyer lifted it; at or below the bid, a seller hit it.
    const side = price >= toCents(quote.ask) ? HftSide.Buy : price <= toCents(quote.bid) ? HftSide.Sell : null;
    if (side === null) return;
    this.counters.prints++;
    this.counters.printShares += size;
    client.order({ tag: STREET, symbol, side, price, quantity: size, type: HftOrderType.IOC });
  }

  // --- HFT itself -------------------------------------------------------------

  private become(state: VenueState, detail: string | null = null): void {
    this.state = state;
    this.detail = detail;
    this.since = Date.now();
  }

  private socketPath(): string {
    const inData = path.join(this.options.dataDir, 'hft.sock');
    if (Buffer.byteLength(inData) <= MAX_SOCKET_PATH) return inData;
    return path.join(os.tmpdir(), `gomer-venue-${createHash('sha1').update(this.options.dataDir).digest('hex').slice(0, 12)}.sock`);
  }

  private folderBytes(): number {
    let total = 0;
    try {
      for (const name of fs.readdirSync(this.options.dataDir)) {
        try {
          const stat = fs.statSync(path.join(this.options.dataDir, name));
          if (stat.isFile()) total += stat.size;
        } catch {
          // gone while looking
        }
      }
    } catch {
      // no folder yet
    }
    return total;
  }

  private chooseBooks(): HftBook[] {
    const wanted = new Set<string>();
    for (const symbol of [...(this.options.symbols ?? []), ...this.options.market.listSymbols().map((listed) => listed.symbol)]) {
      if (symbol.length <= 8 && wanted.size < MAX_SYMBOLS) wanted.add(symbol);
    }
    return [...wanted].map((symbol) => {
      const quote = this.options.market.getQuote(symbol);
      return bookFor(symbol, quote ? Math.max(quote.ask, quote.bid, quote.last) : 0);
    });
  }

  private async launch(): Promise<void> {
    this.become('starting');
    try {
      fs.mkdirSync(this.options.dataDir, { recursive: true });
      const socketPath = this.socketPath();
      fs.rmSync(socketPath, { force: true });
      const child = spawn(
        this.options.binary,
        ['serve', '--socket', socketPath, '--data', this.options.dataDir, '--record-limit-mb', String(this.options.recordLimitMb), '--keep-sessions', String(this.options.keepSessions), '--exit-with-parent'],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      this.child = child;
      readline.createInterface({ input: child.stderr! }).on('line', (line) => this.log.info(`HFT venue: ${line}`));
      child.once('exit', (code, signal) => this.onExit(child, code, signal));
      child.once('error', (err) => this.onExit(child, null, null, err.message));

      await new Promise<void>((resolve, reject) => {
        const began = Date.now();
        const look = (): void => {
          if (fs.existsSync(socketPath)) resolve();
          else if (child.exitCode !== null || this.child !== child) reject(new Error('it exited before it was ready'));
          else if (Date.now() - began > 10_000) reject(new Error('it did not open its socket within ten seconds'));
          else setTimeout(look, 25);
        };
        look();
      });
      const client = new HftClient(socketPath);
      client.on('error', (err) => this.log.warn(`HFT venue: ${err.message}`));
      client.on('close', () => {
        if (this.child === child && child.exitCode === null) child.kill('SIGTERM');
      });
      await client.connect();
      if (this.child !== child || this.stopping) {
        child.kill('SIGTERM');
        return;
      }
      this.client = client;
      client.on('accepted', (accepted) => this.onAccepted(accepted));
      client.on('rejected', ({ tag }) => this.onRejected(tag));
      client.on('fill', (fill) => this.onFill(fill));
      client.on('cancelled', (answer) => this.onGone(answer, true));
      client.on('cancelRejected', (answer) => this.onGone(answer, false));

      this.books = this.chooseBooks();
      this.symbolIndex.clear();
      this.books.forEach((book, index) => this.symbolIndex.set(book.symbol, index));
      this.lastSale.clear();
      const welcomed = client.hello(this.books, { fresh: true });
      // The market first, so that orders find it there.
      for (const symbol of this.symbolIndex.keys()) {
        const quote = this.options.market.getQuote(symbol);
        if (quote) this.quote(quote);
      }
      await welcomed;
      this.options.market.on('quote', this.onQuote);
      this.become('running');
      this.restarts = Math.min(this.restarts, RESTART_DELAY_MS.length);
      this.log.info(`HFT venue is running with ${this.books.length} books: realistic sandboxes trade in it`);
      this.resend();
    } catch (err) {
      this.log.warn(`HFT venue could not be started: ${(err as Error).message}`);
      const child = this.child;
      if (child && child.exitCode === null) child.kill('SIGTERM');
      else this.onExit(child, null, null, (err as Error).message);
    }
  }

  private onExit(child: ChildProcess | null, code: number | null, signal: NodeJS.Signals | null, error?: string): void {
    if (this.child !== child) return;
    this.child = null;
    this.client = null;
    this.options.market.off('quote', this.onQuote);
    if (this.stopping) {
      this.become('down', 'Stopped with the server.');
      return;
    }
    this.become('down', error ?? (signal ? `HFT was stopped by ${signal}.` : `HFT exited with code ${code}.`));
    const delay = RESTART_DELAY_MS[Math.min(this.restarts, RESTART_DELAY_MS.length - 1)]!;
    this.restarts++;
    this.log.warn(`HFT venue is down (${this.detail}). Its orders wait; starting it again in ${delay / 1000}s.`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.launch();
    }, delay);
    this.restartTimer.unref();
  }
}

/**
 * One venue per realistic competition. Each is an HFT of its own, so that
 * orders in one sandbox can never trade with orders in another; traders in
 * the same sandbox do trade with each other, as on any exchange. A venue is
 * started the first time its competition sends an order.
 */
export class HftVenues {
  private readonly venues = new Map<string, HftVenue>();
  private handlers: ((competitionId: string) => VenueHandlers) | null = null;

  constructor(
    private readonly make: (competitionId: string) => HftVenue,
    /** The most realistic competitions trading at once: each venue is a process with books of its own. */
    private readonly most = 4,
  ) {}

  /** How the engine is told what happens in each venue. */
  bind(handlers: (competitionId: string) => VenueHandlers): void {
    this.handlers = handlers;
    for (const [competitionId, venue] of this.venues) venue.bind(handlers(competitionId));
  }

  /** The venue for a competition, made if need be. Null if there are already as many as allowed. */
  for(competitionId: string): HftVenue | null {
    let venue = this.venues.get(competitionId);
    if (venue) return venue;
    if (this.venues.size >= this.most) return null;
    venue = this.make(competitionId);
    if (this.handlers) venue.bind(this.handlers(competitionId));
    this.venues.set(competitionId, venue);
    return venue;
  }

  status(): Array<VenueStatus & { competitionId: string }> {
    return [...this.venues].map(([competitionId, venue]) => ({ competitionId, ...venue.status() }));
  }

  async stop(): Promise<void> {
    await Promise.all([...this.venues.values()].map((venue) => venue.stop()));
  }
}

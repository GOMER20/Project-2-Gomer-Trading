import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { OrderDto, Quote } from '../types.js';
import { bookFor, houseQuote, toCents } from './house.js';
import { HftClient, HftOrderType, HftSide, type HftAccepted, type HftBook, type HftDepth, type HftFill, type HftStats } from './hftClient.js';

/**
 * HFT in test mode.
 *
 * HFT is the order book matching engine in hft/ (C++), run as a program of its
 * own beside this server. In test mode it sees everything the exchange sees
 * and decides nothing: every price update and every order that this server's
 * own engine handles is copied to HFT, which matches them in a real order book
 * and measures itself. What traders are filled at still comes from
 * engine/matchingEngine.ts. The point is to find out, on live traffic and
 * without risk to anyone's account, how HFT performs.
 *
 * What is copied:
 *
 *  - Prices. For each symbol, what the house should be bidding and offering
 *    (house.ts), a few times a second at most. HFT keeps real orders resting
 *    to match, so its book always has the market in it.
 *  - Orders. A market or limit order goes to HFT when this server's engine
 *    reports it; a stop order goes when it is triggered. When the engine says
 *    an order is finished (filled, cancelled), its copy in HFT is cancelled if
 *    it is still resting there, so that HFT's book holds the same working
 *    orders as the exchange and never fills up with ones that no longer exist.
 *
 * HFT's fills are its own: it has a real book, where orders queue and trade
 * with each other, and this server's engine has a modelled one. They are
 * counted here and compared in the statistics, and go no further.
 *
 * Each market day is a session of its own in HFT. When the market opens, HFT
 * is started again with empty books sized for that day's prices, so its
 * statistics and its recording for a day cover that day and nothing else.
 *
 * Disk. HFT records each session so that it can be replayed, and that is the
 * only thing here that takes real space. It is held to a fixed budget: a
 * recording stops growing at `recordLimitMb`, and only the newest
 * `keepSessions` are kept, so HFT's folder can never hold more than the two
 * multiplied together. If the disk itself is nearly full when a session
 * starts, that session is not recorded at all. Each session's statistics, a
 * few kilobytes, are also copied to `history/` so that they outlive the
 * recordings.
 *
 * Nothing here can hold up or break trading. Every call into HFT is
 * fire-and-forget; if HFT is missing, slow or dead, the mirror says so in its
 * status and the exchange carries on.
 */

export type HftState = 'off' | 'unavailable' | 'starting' | 'running' | 'down';

export interface HftMirrorCounters {
  /** Price updates sent to HFT, and ones skipped because HFT had not caught up. */
  quotesSent: number;
  quotesSkipped: number;
  /** Orders and cancels copied to HFT. */
  ordersSent: number;
  cancelsSent: number;
  /** Orders this server handled for symbols HFT is not running, or at prices outside its books. */
  ordersNotCopied: number;
  /** What HFT did with the copies. */
  accepted: number;
  rejected: number;
  fills: number;
  sharesFilled: number;
  /** What this server's own engine did with the originals, for comparison. */
  exchangeFills: number;
  exchangeSharesFilled: number;
}

export interface HftStatus {
  mode: 'off' | 'test';
  state: HftState;
  /** Why it is not running, when it is not. */
  detail: string | null;
  /** When it reached this state, epoch milliseconds. */
  since: number;
  /** Times HFT has had to be started again. */
  restarts: number;
  /** Symbols HFT is running a book for. */
  symbols: string[];
  /** The market session HFT's current session belongs to (a date), or null if it began while the market was shut. */
  marketSession: string | null;
  /** HFT's process ID while it is running. */
  pid: number | null;
  counters: HftMirrorCounters;
  /** Where HFT keeps its recordings and statistics files. */
  dataDir: string;
  /** What HFT may use of the disk. */
  disk: {
    /** The size at which one session's recording stops growing, in megabytes. */
    recordLimitMb: number;
    /** Sessions whose recordings are kept. */
    keepSessions: number;
    /** The most HFT's folder can therefore hold, in megabytes. */
    budgetMb: number;
    /** What its folder holds now, in megabytes. */
    usedMb: number;
    /** True if this session is not being recorded because the disk was nearly full when it began. */
    notRecording: boolean;
  };
}

/** What the mirror needs from the market data service. */
export interface QuoteSource {
  on(event: 'quote', listener: (quote: Quote) => void): unknown;
  off(event: 'quote', listener: (quote: Quote) => void): unknown;
  getQuote(symbol: string): Quote | undefined;
  listSymbols(): Array<{ symbol: string; name: string }>;
}

/** What the mirror needs from the matching engine: its report of every step in every order's life. */
export interface OrderEventLike {
  order: OrderDto;
  fill?: { quantity: number; price: number };
}
export interface OrderSource {
  on(event: 'order', listener: (event: OrderEventLike) => void): unknown;
  off(event: 'order', listener: (event: OrderEventLike) => void): unknown;
}

export interface HftMirrorOptions {
  mode: 'off' | 'test';
  /** The hft program. */
  binary: string;
  /** Where HFT writes its recordings and statistics. */
  dataDir: string;
  market: QuoteSource;
  engine: OrderSource;
  /** Symbols to run books for first; the market's own list fills the rest. */
  symbols?: string[];
  /**
   * Names the market session in progress (its date, say), or returns null
   * while the market is shut. When a new one begins, HFT starts a new session.
   */
  marketSession?: () => string | null;
  /** How often to look for a new market session. */
  sessionCheckMs?: number;
  /** The size at which one session's recording stops growing, in megabytes. Default 250. */
  recordLimitMb?: number;
  /** Sessions whose recordings are kept. Default 2. */
  keepSessions?: number;
  /** With less free disk space than this, a session is not recorded. Default 5 GB. */
  lowDiskBytes?: number;
  /** Free space on the disk holding `dir`, in bytes. For tests; the default asks the file system. */
  freeDiskBytes?: (dir: string) => number | null;
  log?: { info(message: string): void; warn(message: string): void; error(message: string): void };
}

/** The most symbols HFT runs books for: each book is a few megabytes. */
const MAX_SYMBOLS = 64;
/** A symbol's prices are sent to HFT no more often than this. */
const QUOTE_INTERVAL_MS = 200;
/** If this much is waiting to be written to HFT, it has fallen behind: stop adding price updates until it catches up. */
const MAX_BACKLOG_BYTES = 4 * 1024 * 1024;
const RESTART_DELAY_MS = [2_000, 5_000, 15_000, 60_000];
/** A Unix socket's path has to fit in about a hundred bytes. */
const MAX_SOCKET_PATH = 100;
const DEFAULT_RECORD_LIMIT_MB = 250;
const DEFAULT_KEEP_SESSIONS = 2;
const DEFAULT_LOW_DISK_BYTES = 5 * 1024 ** 3;
/** Sessions whose statistics are kept in history/. Each is a few kilobytes. */
const KEEP_HISTORY = 120;

function freeDiskBytes(dir: string): number | null {
  try {
    const stat = fs.statfsSync(dir);
    return stat.bavail * stat.bsize;
  } catch {
    return null;
  }
}

/** How many finished orders are remembered, so that a late word about one is not taken for a new order. */
const REMEMBER_FINISHED = 20_000;

/** What the mirror remembers about one order it has copied. */
interface Copy {
  symbol: number;
  tag: bigint;
  /** Sent to HFT (a stop order is not until it triggers). */
  sent: boolean;
  /** HFT's ID for it while it rests in HFT's book. */
  hftOrderId: bigint | null;
  /** HFT has answered the order: it is either resting (hftOrderId) or gone. */
  answered: boolean;
  /** The exchange has finished with the order. */
  finished: boolean;
}

const zeroCounters = (): HftMirrorCounters => ({
  quotesSent: 0,
  quotesSkipped: 0,
  ordersSent: 0,
  cancelsSent: 0,
  ordersNotCopied: 0,
  accepted: 0,
  rejected: 0,
  fills: 0,
  sharesFilled: 0,
  exchangeFills: 0,
  exchangeSharesFilled: 0,
});

export class HftMirror {
  private state: HftState;
  private detail: string | null = null;
  private since = Date.now();
  private restarts = 0;
  private counters = zeroCounters();

  private child: ChildProcess | null = null;
  private client: HftClient | null = null;
  private books: HftBook[] = [];
  private readonly symbolIndex = new Map<string, number>();
  private readonly dirty = new Set<string>();
  private readonly copies = new Map<string, Copy>();
  private readonly byTag = new Map<bigint, string>();
  /** Orders already dealt with, oldest first. */
  private readonly finished = new Set<string>();
  /** When HFT's current session began. Orders older than this were never in its book. */
  private sessionBegan = 0;
  private tags = 0n;
  private marketSession: string | null = null;
  private quoteTimer: NodeJS.Timeout | undefined;
  private sessionTimer: NodeJS.Timeout | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private listening = false;
  /** HFT is being stopped on purpose so that it starts a new session; not a failure. */
  private renewing = false;
  private notRecording = false;

  private readonly log: NonNullable<HftMirrorOptions['log']>;
  private readonly onQuote = (quote: Quote): void => {
    if (this.symbolIndex.has(quote.symbol)) this.dirty.add(quote.symbol);
  };
  private readonly onOrder = (event: OrderEventLike): void => {
    try {
      this.copyOrder(event);
    } catch (err) {
      // A fault in the copy must never reach the engine that emitted the event.
      this.log.error(`HFT mirror: ${(err as Error).message}`);
    }
  };

  constructor(private readonly options: HftMirrorOptions) {
    this.log = options.log ?? { info: () => undefined, warn: () => undefined, error: () => undefined };
    this.state = options.mode === 'off' ? 'off' : 'starting';
  }

  /** Starts HFT and begins copying to it. Returns at once; never throws. */
  start(): void {
    if (this.options.mode === 'off') return;
    if (!fs.existsSync(this.options.binary)) {
      this.become('unavailable', `The HFT program is not at ${this.options.binary}. Build it with: npm run hft:build`);
      this.log.warn(`HFT is not running: ${this.detail}`);
      return;
    }
    this.stopping = false;
    void this.launch();
  }

  /** Stops copying and asks HFT to finish its recording and exit. */
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.unlisten();
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

  status(): HftStatus {
    return {
      mode: this.options.mode,
      state: this.state,
      detail: this.detail,
      since: this.since,
      restarts: this.restarts,
      symbols: this.books.map((book) => book.symbol),
      marketSession: this.marketSession,
      pid: this.child?.pid ?? null,
      counters: { ...this.counters },
      dataDir: this.options.dataDir,
      disk: {
        recordLimitMb: this.recordLimitMb,
        keepSessions: this.keepSessions,
        budgetMb: this.recordLimitMb * this.keepSessions,
        usedMb: Math.round(this.folderBytes() / 1024 / 1024),
        notRecording: this.notRecording,
      },
    };
  }

  private get recordLimitMb(): number {
    return Math.max(1, Math.round(this.options.recordLimitMb ?? DEFAULT_RECORD_LIMIT_MB));
  }

  private get keepSessions(): number {
    return Math.max(1, Math.round(this.options.keepSessions ?? DEFAULT_KEEP_SESSIONS));
  }

  /** Bytes in HFT's folder, statistics history included. */
  private folderBytes(): number {
    let total = 0;
    try {
      for (const entry of fs.readdirSync(this.options.dataDir, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) total += fs.statSync(path.join(entry.parentPath, entry.name)).size;
      }
    } catch {
      // the folder is not there yet
    }
    return total;
  }

  /**
   * Copies the statistics of sessions that have ended into history/, where
   * they stay after the recordings beside them have been cleared away.
   */
  private keepStatistics(): void {
    try {
      const history = path.join(this.options.dataDir, 'history');
      fs.mkdirSync(history, { recursive: true });
      for (const name of fs.readdirSync(this.options.dataDir)) {
        if (!name.startsWith('hft-session-') || !(name.endsWith('.stats.json') || name.endsWith('.stats.txt'))) continue;
        fs.copyFileSync(path.join(this.options.dataDir, name), path.join(history, name));
      }
      // Names begin with the date and time, so they sort oldest first. Two files a session.
      const kept = fs.readdirSync(history).sort();
      for (const name of kept.slice(0, Math.max(0, kept.length - 2 * KEEP_HISTORY))) fs.rmSync(path.join(history, name), { force: true });
    } catch (err) {
      this.log.warn(`HFT's statistics history could not be updated: ${(err as Error).message}`);
    }
  }

  /** HFT's own statistics for its current session, or null if it is not running or does not answer in time. */
  async stats(timeoutMs = 2_000): Promise<HftStats | null> {
    const client = this.client;
    if (this.state !== 'running' || !client?.connected) return null;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        client.stats(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The top of HFT's own book for a symbol, prices in cents: the house's
   * orders and the traders' together. Null if HFT is not running that symbol.
   */
  async depth(symbol: string, levels = 10): Promise<HftDepth | null> {
    const index = this.symbolIndex.get(symbol);
    const client = this.client;
    if (index === undefined || this.state !== 'running' || !client?.connected) return null;
    try {
      return await client.depth(index, levels);
    } catch {
      return null;
    }
  }

  /** Resolves once HFT has dealt with everything copied so far. For tests. */
  async settled(): Promise<void> {
    this.flushQuotes();
    await this.client?.ping();
  }

  // --- Running HFT ----------------------------------------------------------

  private become(state: HftState, detail: string | null = null): void {
    this.state = state;
    this.detail = detail;
    this.since = Date.now();
  }

  private socketPath(): string {
    const inData = path.join(this.options.dataDir, 'hft.sock');
    if (Buffer.byteLength(inData) <= MAX_SOCKET_PATH) return inData;
    return path.join(os.tmpdir(), `gomer-hft-${createHash('sha1').update(this.options.dataDir).digest('hex').slice(0, 12)}.sock`);
  }

  private async launch(): Promise<void> {
    this.become('starting');
    try {
      fs.mkdirSync(this.options.dataDir, { recursive: true });
      const socketPath = this.socketPath();
      fs.rmSync(socketPath, { force: true });
      this.keepStatistics();

      // With the disk nearly full, HFT is given room for next to nothing: it still runs and
      // still measures itself, and writes only its statistics.
      const free = (this.options.freeDiskBytes ?? freeDiskBytes)(this.options.dataDir);
      this.notRecording = free !== null && free < (this.options.lowDiskBytes ?? DEFAULT_LOW_DISK_BYTES);
      if (this.notRecording) this.log.warn(`The disk has ${Math.round(free! / 1024 / 1024)} MB free, so HFT is not recording this session.`);
      const child = spawn(
        this.options.binary,
        [
          'serve',
          '--socket',
          socketPath,
          '--data',
          this.options.dataDir,
          '--record-limit-mb',
          String(this.notRecording ? 1 : this.recordLimitMb),
          '--keep-sessions',
          String(this.keepSessions),
          '--exit-with-parent',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      this.child = child;
      readline.createInterface({ input: child.stderr! }).on('line', (line) => this.log.info(line));
      child.once('exit', (code, signal) => this.onExit(child, code, signal));
      child.once('error', (err) => this.onExit(child, null, null, err.message));

      await this.waitForSocket(socketPath, child);
      const client = new HftClient(socketPath);
      client.on('error', (err) => this.log.warn(`HFT: ${err.message}`));
      client.on('close', () => {
        // HFT hangs up only if it could not understand a message. Start it again clean.
        if (this.child === child && child.exitCode === null) child.kill('SIGTERM');
      });
      await client.connect();
      if (this.child !== child || this.stopping) {
        child.kill('SIGTERM');
        return;
      }

      this.client = client;
      client.on('accepted', (accepted) => this.onAccepted(accepted));
      client.on('rejected', ({ tag }) => {
        this.counters.rejected++;
        this.answered(tag, null);
      });
      client.on('fill', (fill) => this.onFill(fill));
      this.marketSession = this.options.marketSession?.() ?? null;
      await this.beginSession(client);
      this.listen();
      this.become('running');
      this.log.info(`HFT is running in test mode with ${this.books.length} books (statistics in ${this.options.dataDir})`);
    } catch (err) {
      this.log.warn(`HFT could not be started: ${(err as Error).message}`);
      const child = this.child;
      if (child && child.exitCode === null) child.kill('SIGTERM');
      else this.onExit(child, null, null, (err as Error).message);
    }
  }

  /**
   * Starts a session in HFT: empty books, sized for prices as they are now,
   * with the market put into each. Whatever this mirror knew about orders in
   * the session before is forgotten along with HFT's books.
   */
  private async beginSession(client: HftClient): Promise<void> {
    this.books = this.chooseBooks();
    this.symbolIndex.clear();
    this.books.forEach((book, index) => this.symbolIndex.set(book.symbol, index));
    this.copies.clear();
    this.byTag.clear();
    this.finished.clear();
    this.dirty.clear();
    this.counters = zeroCounters();
    this.sessionBegan = Date.now();
    // HFT deals with messages in the order they are sent, so everything sent
    // from here on, even before it has answered, belongs to the new session.
    const welcomed = client.hello(this.books, { fresh: true });
    for (const book of this.books) this.dirty.add(book.symbol);
    this.flushQuotes();
    await welcomed;
  }

  /**
   * A new market day gets a session of its own in HFT. HFT is stopped, which
   * finishes the old session's recording and statistics, and started again,
   * which is also when the disk is looked at afresh.
   */
  private checkMarketSession(): void {
    const child = this.child;
    const current = this.options.marketSession?.() ?? null;
    if (current === null || current === this.marketSession || this.state !== 'running' || !child) return;
    this.log.info(`HFT is starting a new session for the market session of ${current}`);
    this.renewing = true;
    this.unlisten();
    this.become('starting');
    try {
      if (!this.client?.connected) throw new Error('not connected');
      this.client.shutdown();
    } catch {
      child.kill('SIGTERM');
    }
  }

  private waitForSocket(socketPath: string, child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      const began = Date.now();
      const look = (): void => {
        if (fs.existsSync(socketPath)) resolve();
        else if (child.exitCode !== null || this.child !== child) reject(new Error('it exited before it was ready'));
        else if (Date.now() - began > 10_000) reject(new Error('it did not open its socket within ten seconds'));
        else setTimeout(look, 25);
      };
      look();
    });
  }

  private onExit(child: ChildProcess | null, code: number | null, signal: NodeJS.Signals | null, error?: string): void {
    if (this.child !== child) return;
    this.child = null;
    this.client = null;
    this.unlisten();
    if (this.stopping) {
      this.become('down', 'Stopped with the server.');
      return;
    }
    if (this.renewing) {
      this.renewing = false;
      void this.launch();
      return;
    }
    this.become('down', error ?? (signal ? `HFT was stopped by ${signal}.` : `HFT exited with code ${code}.`));
    const delay = RESTART_DELAY_MS[Math.min(this.restarts, RESTART_DELAY_MS.length - 1)]!;
    this.restarts++;
    this.log.warn(`HFT is down (${this.detail}). Trading is unaffected. Starting it again in ${delay / 1000}s.`);
    this.restartTimer = setTimeout(() => void this.launch(), delay);
    this.restartTimer.unref();
  }

  /** The books to ask HFT for: the symbols named in the options first, then the market's own list, up to the limit. */
  private chooseBooks(): HftBook[] {
    const wanted = new Set<string>();
    for (const symbol of [...(this.options.symbols ?? []), ...this.options.market.listSymbols().map((listed) => listed.symbol)]) {
      // HFT keeps eight characters of a name; a longer one could not be told from its neighbours.
      if (symbol.length <= 8 && wanted.size < MAX_SYMBOLS) wanted.add(symbol);
    }
    return [...wanted].map((symbol) => {
      const quote = this.options.market.getQuote(symbol);
      return bookFor(symbol, quote ? Math.max(quote.ask, quote.bid, quote.last) : 0);
    });
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    this.options.market.on('quote', this.onQuote);
    this.options.engine.on('order', this.onOrder);
    this.quoteTimer = setInterval(() => this.flushQuotes(), QUOTE_INTERVAL_MS);
    this.quoteTimer.unref();
    this.sessionTimer = setInterval(() => this.checkMarketSession(), this.options.sessionCheckMs ?? 15_000);
    this.sessionTimer.unref();
  }

  private unlisten(): void {
    if (!this.listening) return;
    this.listening = false;
    this.options.market.off('quote', this.onQuote);
    this.options.engine.off('order', this.onOrder);
    clearInterval(this.quoteTimer);
    clearInterval(this.sessionTimer);
  }

  // --- Prices ---------------------------------------------------------------

  private flushQuotes(): void {
    const client = this.client;
    if (!client?.connected || this.dirty.size === 0) return;
    if (client.backlog > MAX_BACKLOG_BYTES) {
      // The symbols stay marked, so the newest prices go as soon as HFT has caught up.
      this.counters.quotesSkipped += this.dirty.size;
      return;
    }
    for (const symbol of this.dirty) {
      const index = this.symbolIndex.get(symbol);
      const quote = this.options.market.getQuote(symbol);
      if (index === undefined || !quote) continue;
      const house = houseQuote(quote, this.books[index]!);
      if (!house) continue;
      client.quote(index, house.bids, house.asks);
      this.counters.quotesSent++;
    }
    this.dirty.clear();
  }

  // --- Orders ---------------------------------------------------------------

  private copyOrder(event: OrderEventLike): void {
    const client = this.client;
    if (!client?.connected) return;
    const order = event.order;
    if (event.fill) {
      this.counters.exchangeFills++;
      this.counters.exchangeSharesFilled += event.fill.quantity;
    }

    let copy = this.copies.get(order.id);
    if (!copy) {
      // An order the exchange refused outright never existed as far as the market is concerned,
      // and one already dealt with has nothing more to say.
      if (order.status === 'REJECTED' || this.finished.has(order.id)) return;
      const symbol = this.symbolIndex.get(order.ticker);
      // An order placed before HFT's session began was never in its book: copying it only now,
      // part-way through its life, would put it in the wrong place in the queue.
      if (symbol === undefined || Date.parse(order.createdAt) < this.sessionBegan) {
        this.counters.ordersNotCopied++;
        this.forget(order.id);
        return;
      }
      copy = { symbol, tag: 0n, sent: false, hftOrderId: null, answered: false, finished: false };
      this.copies.set(order.id, copy);
    }

    if (!copy.sent) {
      const stop = order.type === 'STOP' || order.type === 'STOP_LIMIT';
      // A stop order is not in the market until its stop price is reached.
      const live = !stop || order.triggeredAt !== null || order.filledQuantity > 0;
      if (live) this.send(client, order, copy);
    }

    if (order.status !== 'OPEN') {
      copy.finished = true;
      this.settle(order.id, copy);
    }
  }

  private send(client: HftClient, order: OrderDto, copy: Copy): void {
    const market = order.type === 'MARKET' || order.type === 'STOP';
    const price = market || order.limitPrice === null ? 0 : toCents(order.limitPrice);
    const book = this.books[copy.symbol]!;
    if (!market && (price < book.minPrice || price >= book.minPrice + book.numLevels)) {
      this.counters.ordersNotCopied++;
      this.copies.delete(order.id);
      this.forget(order.id);
      return;
    }
    copy.tag = ++this.tags;
    copy.sent = true;
    this.byTag.set(copy.tag, order.id);
    client.order({
      tag: copy.tag,
      symbol: copy.symbol,
      side: order.side === 'BUY' ? HftSide.Buy : HftSide.Sell,
      price,
      quantity: order.quantity,
      type: market ? HftOrderType.Market : order.timeInForce === 'IOC' ? HftOrderType.IOC : order.timeInForce === 'FOK' ? HftOrderType.FOK : HftOrderType.Limit,
    });
    this.counters.ordersSent++;
  }

  /**
   * Brings HFT's copy of an order into line with the exchange once the
   * exchange has finished with it: if the copy is resting in HFT's book it is
   * cancelled, and once nothing more can happen to it, it is forgotten.
   */
  private settle(orderId: string, copy: Copy): void {
    if (!copy.finished) return;
    if (copy.sent && !copy.answered) return; // HFT has not said yet whether it rests; onAccepted comes back here
    if (copy.hftOrderId !== null && this.client?.connected) {
      this.client.cancel({ tag: ++this.tags, symbol: copy.symbol, orderId: copy.hftOrderId });
      this.counters.cancelsSent++;
    }
    this.copies.delete(orderId);
    this.byTag.delete(copy.tag);
    this.forget(orderId);
  }

  /** Notes that an order is done with, so that nothing said about it later starts it again. */
  private forget(orderId: string): void {
    this.finished.add(orderId);
    if (this.finished.size > REMEMBER_FINISHED) {
      for (const oldest of this.finished) {
        this.finished.delete(oldest);
        break;
      }
    }
  }

  /** HFT has answered an order: it rests there under `hftOrderId`, or (null) it does not. */
  private answered(tag: bigint, hftOrderId: bigint | null): void {
    const orderId = this.byTag.get(tag);
    const copy = orderId === undefined ? undefined : this.copies.get(orderId);
    if (orderId === undefined || !copy) {
      this.byTag.delete(tag);
      return;
    }
    copy.answered = true;
    copy.hftOrderId = hftOrderId;
    if (hftOrderId === null && !copy.finished) return; // gone from HFT, still working at the exchange: nothing to keep in step
    this.settle(orderId, copy);
  }

  private onAccepted(accepted: HftAccepted): void {
    this.counters.accepted++;
    this.answered(accepted.tag, accepted.resting > 0 ? accepted.orderId : null);
  }

  private onFill(fill: HftFill): void {
    this.counters.fills++;
    this.counters.sharesFilled += fill.quantity;
    // A resting copy that has traded away completely is no longer in HFT's book to be cancelled.
    if (fill.maker && fill.remaining === 0) {
      const orderId = this.byTag.get(fill.tag);
      const copy = orderId === undefined ? undefined : this.copies.get(orderId);
      if (copy) copy.hftOrderId = null;
    }
  }
}

import { EventEmitter } from 'node:events';
import { Decimal } from 'decimal.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { keys, redis } from '../redis/client.js';
import { isQuoteFresh } from '../engine/pricing.js';
import { SYMBOL_PATTERN, type Bar, type Quote, type Timeframe } from '../types.js';
import { AlpacaProvider } from './alpacaProvider.js';
import { buildBook, LiquidityLedger, type DepthBook } from './depth.js';
import { markPrice } from './mark.js';
import type { FeedStatus, MarketDataProvider, QuoteUpdate } from './provider.js';
import { SimulatedProvider } from './simulatedProvider.js';

const REDIS_FLUSH_MS = 250;

/**
 * The single source of live prices inside the API process.
 *
 *  - merges provider ticks into a full Level 1 quote per symbol
 *  - reference-counts upstream subscriptions (clients, open orders, positions)
 *  - emits 'quote' for the WebSocket gateway and the matching engine
 *  - mirrors the latest quotes into Redis for the leaderboard worker
 */
export class MarketDataService extends EventEmitter<{ quote: [Quote]; status: [FeedStatus] }> {
  private readonly quotes = new Map<string, Quote>();
  private readonly refs = new Map<string, number>();
  private readonly pinned = new Set<string>();
  private readonly loading = new Map<string, Promise<Quote | null>>();
  private readonly dirty = new Set<string>();
  private flushTimer: NodeJS.Timeout | undefined;
  private status: FeedStatus = { state: 'connecting' };
  private readonly ledger = new LiquidityLedger();

  constructor(private readonly provider: MarketDataProvider) {
    super();
  }

  get providerName(): string {
    return this.provider.name;
  }

  /** Whether the upstream feed is delivering, and if not, why. */
  get feedStatus(): FeedStatus {
    return this.status;
  }

  /**
   * False while the exchange itself is shut: nothing can trade, however recent
   * the last quote is. Only the practice market announces this; with real
   * prices a closed market shows as quotes that have stopped arriving.
   */
  get inSession(): boolean {
    return this.status.state !== 'closed';
  }

  /** Whether an order can trade against this quote right now: the exchange is in session and the quote is current. */
  tradable(quote: Pick<Quote, 'ts'>): boolean {
    return this.inSession && isQuoteFresh(quote, config.trading.maxQuoteAgeMs);
  }

  /** Why a market order cannot be taken right now, in words a trader can act on. */
  whyNotTradable(ticker: string): string {
    return this.inSession
      ? `The market for ${ticker} is closed or its quote is stale. Use a limit order.`
      : 'The market is closed. A market order needs an open market; a limit or stop order will wait for the opening bell.';
  }

  /** True when prices here move at any hour, not only during US market hours. */
  get alwaysOpen(): boolean {
    return this.provider.name === 'simulated' && config.marketData.practiceHours === 'always';
  }

  async start(): Promise<void> {
    await this.provider.start(
      (update) => this.onUpdate(update),
      (status) => {
        if (status.state === this.status.state && status.detail === this.status.detail) return;
        this.status = status;
        if (status.state === 'error') logger.error(`Market data feed: ${status.detail}`);
        this.emit('status', status);
      },
    );
    this.flushTimer = setInterval(() => void this.flushToRedis(), REDIS_FLUSH_MS);
    this.flushTimer.unref();
    await Promise.all(config.marketData.defaultSymbols.map((symbol) => this.pin(symbol)));
    logger.info(`Market data online via ${this.provider.name} (${this.refs.size} symbols)`);
  }

  async stop(): Promise<void> {
    clearInterval(this.flushTimer);
    await this.provider.stop();
  }

  /** Latest cached quote, if the symbol is currently streaming. */
  getQuote(symbol: string): Quote | undefined {
    return this.quotes.get(symbol);
  }

  /** Mark price for valuation, or null when there is no usable quote. */
  getMark(symbol: string): Decimal | null {
    const quote = this.quotes.get(symbol);
    const mark = quote ? markPrice(quote) : 0;
    return mark > 0 ? new Decimal(mark) : null;
  }

  /**
   * Starts streaming a symbol on behalf of one consumer and resolves with its
   * current quote. Resolves null (and takes no reference) for unknown symbols.
   * Every successful retain must be paired with a release.
   */
  async retain(symbol: string): Promise<Quote | null> {
    if (!SYMBOL_PATTERN.test(symbol)) return null;
    const count = this.refs.get(symbol) ?? 0;
    this.refs.set(symbol, count + 1);
    if (count === 0) this.provider.subscribe([symbol]);

    const quote = await this.load(symbol);
    if (!quote) this.release(symbol);
    return quote;
  }

  release(symbol: string): void {
    const count = this.refs.get(symbol);
    if (count === undefined) return;
    if (count > 1) {
      this.refs.set(symbol, count - 1);
      return;
    }
    this.refs.delete(symbol);
    this.quotes.delete(symbol);
    this.dirty.delete(symbol);
    this.provider.unsubscribe([symbol]);
    redis.hdel(keys.quotes, symbol).catch(() => undefined);
  }

  /** Keeps a symbol streaming for the life of the process (open orders and positions depend on it). */
  async pin(symbol: string): Promise<Quote | null> {
    if (this.pinned.has(symbol)) return this.quotes.get(symbol) ?? this.load(symbol);
    this.pinned.add(symbol);
    const quote = await this.retain(symbol);
    if (!quote) this.pinned.delete(symbol);
    return quote;
  }

  /**
   * The Level 2 book for a symbol: its quote, the modelled levels behind it,
   * less whatever orders have just taken. Null when the symbol has no quote.
   */
  getDepth(symbol: string): DepthBook | null {
    const quote = this.quotes.get(symbol);
    return quote ? buildBook(quote, this.ledger.outstanding(symbol)) : null;
  }

  /**
   * Records an execution. The shares come out of the book for a few seconds,
   * and a self-contained market also moves its price; a feed of real prices
   * cannot be moved.
   */
  reportFill(symbol: string, side: 'BUY' | 'SELL', quantity: number): void {
    this.ledger.consume(symbol, side, quantity);
    this.provider.applyFlow?.(symbol, side === 'BUY' ? quantity : -quantity);
  }

  getBars(symbol: string, timeframe: Timeframe, limit: number): Promise<Bar[]> {
    return this.provider.fetchBars(symbol, timeframe, limit);
  }

  listSymbols(): Array<{ symbol: string; name: string }> {
    return this.provider.listSymbols();
  }

  /** Seeds a symbol from a REST snapshot; concurrent callers share one request. */
  private load(symbol: string): Promise<Quote | null> {
    const cached = this.quotes.get(symbol);
    if (cached) return Promise.resolve(cached);

    let pending = this.loading.get(symbol);
    if (!pending) {
      pending = this.provider
        .fetchSnapshot(symbol)
        .then((snapshot) => {
          if (!snapshot) return null;
          // A stream tick may have landed first; it is newer than the snapshot, so its fields win.
          const live = this.quotes.get(symbol);
          const merged: Quote = live
            ? {
                ...snapshot,
                bid: live.bid > 0 ? live.bid : snapshot.bid,
                ask: live.ask > 0 ? live.ask : snapshot.ask,
                bidSize: live.bidSize || snapshot.bidSize,
                askSize: live.askSize || snapshot.askSize,
                last: live.last > 0 ? live.last : snapshot.last,
                ts: Math.max(live.ts, snapshot.ts),
              }
            : snapshot;
          this.store(merged);
          return merged;
        })
        .catch((err: Error) => {
          logger.error({ err: err.message, symbol }, 'Snapshot request failed');
          return null;
        })
        .finally(() => this.loading.delete(symbol));
      this.loading.set(symbol, pending);
    }
    return pending;
  }

  private onUpdate(update: QuoteUpdate): void {
    if (!this.refs.has(update.symbol)) return;
    const previous = this.quotes.get(update.symbol);
    const positive = (next: number | undefined, fallback: number) => (next !== undefined && next > 0 ? next : fallback);

    const quote: Quote = {
      symbol: update.symbol,
      bid: positive(update.bid, previous?.bid ?? 0),
      ask: positive(update.ask, previous?.ask ?? 0),
      bidSize: update.bidSize ?? previous?.bidSize ?? 0,
      askSize: update.askSize ?? previous?.askSize ?? 0,
      last: positive(update.last, previous?.last ?? 0),
      lastSize: update.last !== undefined ? update.lastSize : previous?.lastSize,
      prevClose: update.prevClose ?? previous?.prevClose ?? null,
      ts: Math.max(update.ts, previous?.ts ?? 0),
    };
    this.store(quote);
  }

  private store(quote: Quote): void {
    this.quotes.set(quote.symbol, quote);
    this.dirty.add(quote.symbol);
    this.emit('quote', quote);
  }

  private async flushToRedis(): Promise<void> {
    if (this.dirty.size === 0) return;
    const payload: Record<string, string> = {};
    for (const symbol of this.dirty) {
      const quote = this.quotes.get(symbol);
      if (quote) payload[symbol] = JSON.stringify(quote);
    }
    this.dirty.clear();
    try {
      await redis.hset(keys.quotes, payload);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Could not cache quotes in Redis');
    }
  }
}

function createProvider(): MarketDataProvider {
  if (config.marketData.provider !== 'alpaca') {
    // The test-only clock starts at the given moment and runs on from there.
    const startedAt = Date.now();
    const pretend = config.marketData.practiceClock;
    return new SimulatedProvider({
      hours: config.marketData.practiceHours,
      calendar: pretend === null ? undefined : () => pretend + (Date.now() - startedAt),
    });
  }
  return new AlpacaProvider({
    key: config.marketData.alpacaKey,
    secret: config.marketData.alpacaSecret,
    feed: config.marketData.alpacaFeed,
    streamUrl: config.marketData.alpacaStreamUrl,
    dataUrl: config.marketData.alpacaDataUrl,
    suggestions: config.marketData.defaultSymbols,
  });
}

export const market = new MarketDataService(createProvider());

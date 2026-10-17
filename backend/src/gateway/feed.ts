import { engine, type OrderEvent } from '../engine/matchingEngine.js';
import { shownDepth } from '../market/depth.js';
import { market } from '../market/marketData.js';
import type { Quote } from '../types.js';
import { CHANNEL_BITS, Channel, encodeBbo, encodeDepth, encodeTrade, type BboUpdate, type ChannelName, type DepthUpdate, type TradePrint } from './protocol.js';
import type { Published, Session } from './session.js';

/** Depth changes with every quote and every fill. This is the most often a symbol's book is published. */
const DEPTH_INTERVAL_MS = 50;
const MAX_SYMBOLS_PER_SESSION = 200;

function publication(kind: ChannelName, symbol: string, data: BboUpdate | TradePrint | DepthUpdate): Published {
  let json: string | undefined;
  let binary: Buffer | undefined;
  return {
    kind,
    symbol,
    data,
    // Encoded when the first session of each kind needs it, then shared by the rest.
    json: () =>
      (json ??=
        kind === 'bbo'
          ? JSON.stringify({ op: 'bbo', s: symbol, b: (data as BboUpdate).bid, bs: (data as BboUpdate).bidSize, a: (data as BboUpdate).ask, as: (data as BboUpdate).askSize, t: data.ts })
          : kind === 'trades'
            ? JSON.stringify({ op: 'trade', s: symbol, p: (data as TradePrint).price, q: (data as TradePrint).size, t: data.ts })
            : JSON.stringify({ op: 'depth', s: symbol, bids: (data as DepthUpdate).bids, asks: (data as DepthUpdate).asks, t: data.ts })),
    binary: () => (binary ??= kind === 'bbo' ? encodeBbo(0, data as BboUpdate) : kind === 'trades' ? encodeTrade(0, data as TradePrint) : encodeDepth(0, data as DepthUpdate)),
  };
}

/**
 * Market data pub/sub for trading programs.
 *
 * Three channels per symbol:
 *   bbo     the best bid and offer, published the moment either changes
 *   trades  each trade as it prints
 *   depth   the Level 2 book, at most every 50 ms per symbol
 *
 * Nothing here waits for the 200 ms batching the trading terminal uses: a
 * quote goes out to its subscribers in the same turn of the event loop that it
 * arrived in.
 */
class FeedHub {
  /** symbol -> sessions subscribed to any of its channels */
  private readonly watchers = new Map<string, Set<Session>>();
  private readonly lastQuote = new Map<string, Quote>();
  private readonly depthDue = new Set<string>();
  private readonly lastDepth = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private readonly onQuote = (quote: Quote) => this.publishQuote(quote);
  private readonly onOrder = (event: OrderEvent) => {
    // A fill takes shares out of the book, which changes its depth even if the quote has not moved.
    if (event.fill && this.watchers.has(event.order.ticker)) this.depthDue.add(event.order.ticker);
  };

  start(): void {
    market.on('quote', this.onQuote);
    engine.on('order', this.onOrder);
    this.timer = setInterval(() => this.publishDepth(), DEPTH_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    market.off('quote', this.onQuote);
    engine.off('order', this.onOrder);
  }

  /** Adds channels of a symbol to a session and sends where the market stands now. False for an unknown symbol. */
  async subscribe(session: Session, symbol: string, channels: number): Promise<boolean> {
    const held = session.subscriptions.get(symbol);
    if (held === undefined) {
      if (session.subscriptions.size >= MAX_SYMBOLS_PER_SESSION) return false;
      // Each subscribed symbol holds one reference on the upstream feed, given back in unsubscribe() or drop().
      const quote = await market.retain(symbol);
      if (!quote) return false;
      if (session.subscriptions.has(symbol)) market.release(symbol); // two requests raced; keep one reference
    }
    session.subscriptions.set(symbol, (session.subscriptions.get(symbol) ?? 0) | channels);
    let watchers = this.watchers.get(symbol);
    if (!watchers) this.watchers.set(symbol, (watchers = new Set()));
    watchers.add(session);

    const quote = market.getQuote(symbol);
    if (quote) {
      this.lastQuote.set(symbol, quote);
      if (channels & Channel.BBO) session.sendMarketData(publication('bbo', symbol, this.bbo(quote)));
      const depth = channels & Channel.DEPTH ? this.depth(symbol) : null;
      if (depth) session.sendMarketData(publication('depth', symbol, depth));
    }
    return true;
  }

  unsubscribe(session: Session, symbol: string, channels: number): void {
    const held = session.subscriptions.get(symbol);
    if (held === undefined) return;
    const left = held & ~channels;
    if (left) return void session.subscriptions.set(symbol, left);
    session.subscriptions.delete(symbol);
    this.forget(session, symbol);
  }

  /** A session has gone: give back everything it was holding. */
  drop(session: Session): void {
    for (const symbol of session.subscriptions.keys()) this.forget(session, symbol);
    session.subscriptions.clear();
  }

  private forget(session: Session, symbol: string): void {
    const watchers = this.watchers.get(symbol);
    watchers?.delete(session);
    if (watchers?.size === 0) {
      this.watchers.delete(symbol);
      this.lastQuote.delete(symbol);
      this.lastDepth.delete(symbol);
    }
    market.release(symbol);
  }

  private bbo(quote: Quote): BboUpdate {
    return { symbol: quote.symbol, bid: quote.bid, bidSize: quote.bidSize, ask: quote.ask, askSize: quote.askSize, ts: quote.ts };
  }

  private depth(symbol: string): DepthUpdate | null {
    const book = market.getDepth(symbol);
    if (!book) return null;
    const shown = shownDepth(book);
    return { symbol, bids: shown.bids.map((l) => [l.price, l.size]), asks: shown.asks.map((l) => [l.price, l.size]), ts: book.ts };
  }

  private send(symbol: string, channel: number, event: Published): void {
    for (const session of this.watchers.get(symbol) ?? []) {
      if ((session.subscriptions.get(symbol) ?? 0) & channel) session.sendMarketData(event);
    }
  }

  private publishQuote(quote: Quote): void {
    if (!this.watchers.has(quote.symbol)) return;
    const previous = this.lastQuote.get(quote.symbol);
    this.lastQuote.set(quote.symbol, quote);
    if (!previous || previous.bid !== quote.bid || previous.ask !== quote.ask || previous.bidSize !== quote.bidSize || previous.askSize !== quote.askSize) {
      this.send(quote.symbol, Channel.BBO, publication('bbo', quote.symbol, this.bbo(quote)));
      this.depthDue.add(quote.symbol);
    }
    // A trade is a change in the last sale; a quote that only moved the bid or ask is not one.
    if (quote.last > 0 && previous && (previous.last !== quote.last || previous.lastSize !== quote.lastSize)) {
      this.send(quote.symbol, Channel.TRADES, publication('trades', quote.symbol, { symbol: quote.symbol, price: quote.last, size: quote.lastSize ?? 0, ts: quote.ts }));
    }
  }

  private publishDepth(): void {
    if (this.depthDue.size === 0) return;
    for (const symbol of this.depthDue) {
      const depth = this.depth(symbol);
      if (!depth) continue;
      const fingerprint = JSON.stringify([depth.bids, depth.asks]);
      if (fingerprint === this.lastDepth.get(symbol)) continue;
      this.lastDepth.set(symbol, fingerprint);
      this.send(symbol, Channel.DEPTH, publication('depth', symbol, depth));
    }
    this.depthDue.clear();
  }

  get symbolCount(): number {
    return this.watchers.size;
  }
}

export const feed = new FeedHub();
export const channelBits = (names: ChannelName[]) => names.reduce((bits, name) => bits | (CHANNEL_BITS[name] ?? 0), 0);

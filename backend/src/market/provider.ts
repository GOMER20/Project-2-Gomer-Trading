import type { Bar, Quote, Timeframe } from '../types.js';

/** A partial Level 1 update. Quote ticks carry bid/ask, trade ticks carry last. */
export interface QuoteUpdate {
  symbol: string;
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  last?: number;
  lastSize?: number;
  /** The price "today's change" is measured from, when the feed knows it has moved on. */
  prevClose?: number;
  ts: number;
}

/**
 * Health of the upstream feed.
 *   connecting  not streaming yet (first connect, or reconnecting after a drop)
 *   streaming   authenticated and delivering ticks
 *   closed      healthy, but the exchange itself is shut until its next session
 *               (the practice market says so; a feed of real prices simply goes quiet)
 *   error       needs attention; `detail` says what, in words a trader can act on
 */
export interface FeedStatus {
  state: 'connecting' | 'streaming' | 'closed' | 'error';
  detail?: string;
}

export interface MarketDataProvider {
  readonly name: 'alpaca' | 'simulated';
  start(onUpdate: (update: QuoteUpdate) => void, onStatus: (status: FeedStatus) => void): Promise<void>;
  stop(): Promise<void>;
  subscribe(symbols: string[]): void;
  unsubscribe(symbols: string[]): void;
  /** Full current quote, or null when the symbol does not exist on this feed. */
  fetchSnapshot(symbol: string): Promise<Quote | null>;
  /** Most recent bars, oldest first. */
  fetchBars(symbol: string, timeframe: Timeframe, limit: number): Promise<Bar[]>;
  /** Symbols offered for search/autocomplete. May be a subset of what is tradable. */
  listSymbols(): Array<{ symbol: string; name: string }>;
  /**
   * Tells a self-contained market about an executed order so its prices can
   * react. A feed of real prices has nothing to do here and omits it.
   */
  applyFlow?(symbol: string, signedQuantity: number): void;
}

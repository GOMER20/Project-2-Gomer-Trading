import WebSocket from 'ws';
import { logger } from '../lib/logger.js';
import type { Bar, Quote, Timeframe } from '../types.js';
import type { FeedStatus, MarketDataProvider, QuoteUpdate } from './provider.js';

export interface AlpacaOptions {
  key: string;
  secret: string;
  /** iex = free real-time feed, sip = paid consolidated feed, delayed_sip = 15 minutes late. */
  feed: 'iex' | 'sip' | 'delayed_sip';
  /** e.g. wss://stream.data.alpaca.markets */
  streamUrl: string;
  /** e.g. https://data.alpaca.markets */
  dataUrl: string;
  /** Symbols offered as search suggestions. */
  suggestions: string[];
}

/** How far back to look so that `limit` bars exist even across weekends and holidays. */
const LOOKBACK_DAYS: Record<Timeframe, number> = { '1Min': 7, '5Min': 14, '15Min': 30, '1Hour': 120, '1Day': 730 };
const MAX_BACKOFF_MS = 30_000;

/**
 * Stream error codes that mean "do not keep retrying with the same settings".
 * Retrying a bad key forever would only get the account rate limited.
 */
const FATAL: Record<number, (feed: string) => string> = {
  402: () => 'Alpaca rejected the API keys. Check the key and secret in your market data settings.',
  409: (feed) => `Your Alpaca plan does not include the "${feed}" feed. Switch the feed to IEX in your market data settings.`,
};
/** Errors that clear up on their own or only affect some symbols. */
const RECOVERABLE: Record<number, string> = {
  405: "Alpaca's symbol limit for this plan was reached, so some symbols are not updating (the free plan streams 30).",
  406: 'Alpaca allows one live data connection per account and another program is using it. Close the other one; this will reconnect on its own.',
};

interface AlpacaStreamMessage {
  T: string;
  S?: string;
  msg?: string;
  code?: number;
  bp?: number;
  bs?: number;
  ap?: number;
  as?: number;
  p?: number;
  /** Trade size. */
  s?: number;
  t?: string;
}

interface AlpacaSnapshot {
  latestTrade?: { p: number; t: string };
  latestQuote?: { bp: number; bs: number; ap: number; as: number; t: string };
  dailyBar?: { c: number };
  prevDailyBar?: { c: number };
}

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/**
 * Live Level 1 data from Alpaca: quotes and trades over the market data
 * WebSocket, snapshots and historical bars over REST.
 * Execution is NOT sent to Alpaca; see engine/matchingEngine.ts.
 */
export class AlpacaProvider implements MarketDataProvider {
  readonly name = 'alpaca' as const;
  private socket: WebSocket | undefined;
  private authenticated = false;
  private stopped = false;
  private fatal = false;
  /** True once Alpaca has explained the current failure itself. */
  private explained = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly symbols = new Set<string>();
  private readonly headers: Record<string, string>;
  private onUpdate: (update: QuoteUpdate) => void = () => undefined;
  private onStatus: (status: FeedStatus) => void = () => undefined;

  constructor(private readonly options: AlpacaOptions) {
    this.headers = {
      'APCA-API-KEY-ID': options.key,
      'APCA-API-SECRET-KEY': options.secret,
      accept: 'application/json',
    };
  }

  async start(onUpdate: (update: QuoteUpdate) => void, onStatus: (status: FeedStatus) => void): Promise<void> {
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;
    this.stopped = false;
    this.fatal = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  subscribe(symbols: string[]): void {
    const added = symbols.filter((s) => !this.symbols.has(s));
    for (const symbol of added) this.symbols.add(symbol);
    if (added.length) this.send({ action: 'subscribe', quotes: added, trades: added });
  }

  unsubscribe(symbols: string[]): void {
    const removed = symbols.filter((s) => this.symbols.delete(s));
    if (removed.length) this.send({ action: 'unsubscribe', quotes: removed, trades: removed });
  }

  async fetchSnapshot(symbol: string): Promise<Quote | null> {
    const snapshot = await this.get<AlpacaSnapshot>(`/v2/stocks/${encodeURIComponent(symbol)}/snapshot`, {
      feed: this.options.feed,
    });
    if (!snapshot || (!snapshot.latestQuote && !snapshot.latestTrade)) return null;

    const quote = snapshot.latestQuote;
    const trade = snapshot.latestTrade;
    const last = trade?.p ?? snapshot.dailyBar?.c ?? 0;
    return {
      symbol,
      // IEX can report a one-sided book; fall back to the last trade so the quote stays usable.
      bid: quote && quote.bp > 0 ? quote.bp : last,
      ask: quote && quote.ap > 0 ? quote.ap : last,
      bidSize: quote?.bs ?? 0,
      askSize: quote?.as ?? 0,
      last,
      prevClose: snapshot.prevDailyBar?.c ?? null,
      ts: Math.max(quote ? Date.parse(quote.t) : 0, trade ? Date.parse(trade.t) : 0),
    };
  }

  async fetchBars(symbol: string, timeframe: Timeframe, limit: number): Promise<Bar[]> {
    const start = new Date(Date.now() - LOOKBACK_DAYS[timeframe] * 86_400_000).toISOString();
    const body = await this.get<{ bars: AlpacaBar[] | null }>(`/v2/stocks/${encodeURIComponent(symbol)}/bars`, {
      timeframe,
      start,
      limit: String(limit),
      adjustment: 'split',
      feed: this.options.feed,
      // Newest first so `limit` keeps the most recent bars; reversed below.
      sort: 'desc',
    });
    return (body?.bars ?? [])
      .map((b) => ({ time: Math.floor(Date.parse(b.t) / 1000), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }))
      .reverse();
  }

  listSymbols(): Array<{ symbol: string; name: string }> {
    // Any US equity on the feed is tradable; these are just the search suggestions.
    return this.options.suggestions.map((symbol) => ({ symbol, name: symbol }));
  }

  /** Returns null for "no such symbol" responses and throws for everything else that is not OK. */
  private async get<T>(path: string, params: Record<string, string>): Promise<T | null> {
    const url = `${this.options.dataUrl}${path}?${new URLSearchParams(params)}`;
    const response = await fetch(url, { headers: this.headers, signal: AbortSignal.timeout(8_000) });
    if (response.status === 404 || response.status === 422) return null;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // Alpaca answers bad credentials with an HTML page; keep only the readable part.
      throw new Error(`Alpaca ${path} failed with ${response.status}: ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}`);
    }
    return (await response.json()) as T;
  }

  private connect(): void {
    const url = `${this.options.streamUrl}/v2/${this.options.feed}`;
    logger.info(`Connecting to Alpaca market data stream (${this.options.feed})`);
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.on('message', (raw) => {
      let messages: AlpacaStreamMessage[];
      try {
        messages = JSON.parse(raw.toString());
      } catch {
        return;
      }
      for (const message of messages) this.handle(message);
    });

    socket.on('close', () => {
      this.authenticated = false;
      if (this.stopped || this.fatal) return;
      // Exponential backoff capped at 30s; reset once we authenticate again.
      const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** this.reconnectAttempt++);
      logger.warn(`Alpaca stream closed, reconnecting in ${delay}ms`);
      // Alpaca's own explanation, when there is one, beats a generic network message.
      if (!this.explained && this.reconnectAttempt >= 4) this.onStatus({ state: 'error', detail: 'Cannot reach Alpaca. Check the internet connection; retrying automatically.' });
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });

    socket.on('error', (err) => logger.warn({ err: err.message }, 'Alpaca stream error'));
  }

  private handle(message: AlpacaStreamMessage): void {
    switch (message.T) {
      case 'success':
        if (message.msg === 'connected') {
          this.socket?.send(JSON.stringify({ action: 'auth', key: this.options.key, secret: this.options.secret }));
        } else if (message.msg === 'authenticated') {
          this.authenticated = true;
          this.explained = false;
          this.reconnectAttempt = 0;
          logger.info('Alpaca stream authenticated');
          this.onStatus({ state: 'streaming' });
          const all = [...this.symbols];
          if (all.length) this.send({ action: 'subscribe', quotes: all, trades: all });
        }
        break;
      case 'q':
        if (message.S && message.t) {
          this.onUpdate({
            symbol: message.S,
            bid: message.bp,
            ask: message.ap,
            bidSize: message.bs,
            askSize: message.as,
            ts: Date.parse(message.t),
          });
        }
        break;
      case 't':
        if (message.S && message.t) this.onUpdate({ symbol: message.S, last: message.p, lastSize: message.s, ts: Date.parse(message.t) });
        break;
      case 'error': {
        const code = message.code ?? 0;
        this.explained = true;
        const fatal = FATAL[code];
        if (fatal) {
          this.fatal = true;
          this.onStatus({ state: 'error', detail: fatal(this.options.feed) });
          this.socket?.close();
        } else {
          this.onStatus({ state: 'error', detail: RECOVERABLE[code] ?? `Alpaca reported a problem: ${message.msg ?? `code ${code}`}.` });
        }
        break;
      }
      default:
        break;
    }
  }

  private send(payload: object): void {
    // Not connected yet: the full symbol set is replayed on authentication.
    if (this.authenticated && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload));
  }
}

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { config } from '../config.js';
import { isDatabaseBusy } from '../db/pool.js';
import { engine, type OrderEvent } from '../engine/matchingEngine.js';
import { logger } from '../lib/logger.js';
import { shownDepth } from '../market/depth.js';
import { market } from '../market/marketData.js';
import type { FeedStatus } from '../market/provider.js';
import { createRedis, keys } from '../redis/client.js';
import { verifyToken } from '../services/auth.service.js';
import { getLeaderboard, type Leaderboard } from '../services/leaderboard.service.js';
import { findPortfolioId } from '../services/portfolio.service.js';
import { assertSessionLive, sessionEvents } from '../services/session.service.js';
import { SYMBOL_PATTERN, type AuthUser, type Quote } from '../types.js';
import { presence } from './presence.js';

/**
 * Client -> server
 *   { type: 'auth', token }                    must be the first message
 *   { type: 'subscribe', symbols: [...] }      start Level 1 quotes
 *   { type: 'unsubscribe', symbols: [...] }
 *   { type: 'leaderboard', competitionId }     follow one competition's standings
 *   { type: 'ping' }
 *
 * Server -> client
 *   { type: 'ready', traderId, provider, feed: FeedStatus }
 *   { type: 'feed', data: FeedStatus }                 upstream feed health changed
 *   { type: 'quote', data: Quote }                     the current quote, sent once on subscribing
 *   { type: 'quotes', data: Quote[] }                  every subscribed quote that changed, five times a second
 *   { type: 'order', competitionId, data: Order }      the caller's own order updates
 *   { type: 'leaderboard', data: Leaderboard & { me } }
 *   { type: 'error', code, message }
 *   { type: 'pong' }
 */

const FLUSH_MS = 200;
/** Level 2 changes with every quote and every fill; twice a second is as fast as anyone can read it. */
const DEPTH_MS = 500;
const HEARTBEAT_MS = 30_000;
const AUTH_TIMEOUT_MS = 10_000;
const MAX_SYMBOLS_PER_CLIENT = 100;
/** Slow consumers are skipped rather than allowed to queue unbounded data. */
const MAX_BUFFERED_BYTES = 1_000_000;

const symbols = z.array(z.string().trim().toUpperCase().regex(SYMBOL_PATTERN)).min(1).max(50);
const clientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(1).max(4096) }),
  z.object({ type: z.literal('subscribe'), symbols }),
  z.object({ type: z.literal('unsubscribe'), symbols }),
  z.object({ type: z.literal('leaderboard'), competitionId: z.uuid() }),
  // Level 2 for one symbol at a time (the one on screen); null stops it.
  z.object({ type: z.literal('depth'), symbol: z.string().trim().toUpperCase().regex(SYMBOL_PATTERN).nullable() }),
  z.object({ type: z.literal('ping') }),
]);
type ClientMessage = z.infer<typeof clientMessage>;

interface Client {
  socket: WebSocket;
  user: AuthUser | null;
  symbols: Set<string>;
  /** Symbols whose subscription is still resolving, to make duplicate requests harmless. */
  pending: Set<string>;
  competitionId: string | null;
  /** The symbol this client is receiving Level 2 for. */
  depthSymbol: string | null;
  /** The symbol it asked for. Level 2 starts once that symbol's quote subscription is in place. */
  depthWanted: string | null;
  alive: boolean;
  authTimer: NodeJS.Timeout;
}

export class Gateway {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<Client>();
  private readonly bySymbol = new Map<string, Set<Client>>();
  private readonly byUser = new Map<string, Set<Client>>();
  private readonly dirty = new Set<string>();
  private readonly byDepth = new Map<string, Set<Client>>();
  /** The last book sent for each symbol, so an unchanged book is not sent again. */
  private readonly lastDepth = new Map<string, string>();
  private readonly subscriber = createRedis('gomer-gateway-sub');
  private readonly timers: NodeJS.Timeout[] = [];

  private readonly onQuote = (quote: Quote) => this.dirty.add(quote.symbol);
  private readonly onOrder = (event: OrderEvent) =>
    this.sendToUser(event.userId, { type: 'order', competitionId: event.competitionId, data: event.order });
  /** A password change, reset or deactivation: that user's open terminals are cut off at once. */
  private readonly onSessionsEnded = (userId: string) => {
    for (const client of [...(this.byUser.get(userId) ?? [])]) {
      this.send(client, { type: 'error', code: 'UNAUTHORIZED', message: 'You have been signed out. Please log in again.' });
      client.socket.close(1008, 'Signed out');
    }
  };
  private readonly onFeedStatus = (status: FeedStatus) => {
    const frame = JSON.stringify({ type: 'feed', data: status });
    for (const client of this.clients) if (client.user) this.sendRaw(client, frame);
  };

  constructor() {
    // The HTTP server routes upgrades by path (index.ts), since the bot gateway shares it.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
    this.wss.on('connection', (socket, request) => this.accept(socket, request));

    market.on('quote', this.onQuote);
    market.on('status', this.onFeedStatus);
    engine.on('order', this.onOrder);
    sessionEvents.on('ended', this.onSessionsEnded);
    presence.provide(() => this.byUser.keys());
    this.timers.push(setInterval(() => this.flushQuotes(), FLUSH_MS), setInterval(() => this.flushDepth(), DEPTH_MS), setInterval(() => this.heartbeat(), HEARTBEAT_MS));

    // The leaderboard worker is a separate process; Redis pub/sub carries its updates here.
    this.subscriber.subscribe(keys.leaderboardChannel).catch((err) => logger.error({ err }, 'Leaderboard subscription failed'));
    this.subscriber.on('message', (_channel, message) => void this.onLeaderboard(message));
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(request, socket, head, (ws) => this.wss.emit('connection', ws, request));
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  async close(): Promise<void> {
    this.timers.forEach(clearInterval);
    market.off('quote', this.onQuote);
    market.off('status', this.onFeedStatus);
    engine.off('order', this.onOrder);
    sessionEvents.off('ended', this.onSessionsEnded);
    for (const client of this.clients) client.socket.close(1001, 'Server shutting down');
    this.subscriber.disconnect();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private accept(socket: WebSocket, request: IncomingMessage): void {
    if (this.clients.size >= config.ws.maxClients) {
      socket.close(1013, 'Server is at capacity, try again later');
      return;
    }
    // Browsers always send Origin on WebSocket handshakes; scripts and native clients do not.
    // A page this server served itself may always connect back, whatever address it was reached
    // by (a LAN address when the desktop app is hosting, a public name behind a proxy).
    const origin = request.headers.origin;
    const sameHost = (() => {
      try {
        return Boolean(origin) && new URL(origin!).host === request.headers.host;
      } catch {
        return false;
      }
    })();
    if (origin && !sameHost && !config.corsOrigins.includes(origin)) {
      socket.close(1008, 'Origin not allowed');
      return;
    }

    const client: Client = {
      socket,
      user: null,
      symbols: new Set(),
      pending: new Set(),
      competitionId: null,
      depthSymbol: null,
      depthWanted: null,
      alive: true,
      authTimer: setTimeout(() => socket.close(1008, 'Authentication timeout'), AUTH_TIMEOUT_MS),
    };
    this.clients.add(client);

    socket.on('pong', () => (client.alive = true));
    socket.on('error', (err) => logger.debug({ err: err.message }, 'WebSocket client error'));
    socket.on('close', () => this.drop(client));
    socket.on('message', (raw) => {
      let message: ClientMessage;
      try {
        message = clientMessage.parse(JSON.parse(raw.toString()));
      } catch {
        this.send(client, { type: 'error', code: 'BAD_MESSAGE', message: 'Unrecognised message' });
        return;
      }
      this.handle(client, message).catch((err) => {
        if (isDatabaseBusy(err)) {
          logger.warn({ err: (err as Error).message }, 'WebSocket request deferred: the database is busy');
          this.send(client, { type: 'error', code: 'BUSY', message: 'The server is busy. Please try again in a moment.' });
          return;
        }
        logger.error({ err }, 'WebSocket message handler failed');
        this.send(client, { type: 'error', code: 'INTERNAL_ERROR', message: 'Could not process that message' });
      });
    });
  }

  private async handle(client: Client, message: ClientMessage): Promise<void> {
    if (message.type === 'ping') return this.send(client, { type: 'pong' });

    if (message.type === 'auth') {
      if (client.user) return;
      try {
        const user = verifyToken(message.token);
        await assertSessionLive(user);
        if (client.user) return; // a second auth message raced the first
        client.user = user;
      } catch (err) {
        if (isDatabaseBusy(err)) throw err; // not the client's fault: tell it to retry, do not sign it out
        this.send(client, { type: 'error', code: 'UNAUTHORIZED', message: 'Invalid or expired session' });
        client.socket.close(1008, 'Unauthorized');
        return;
      }
      clearTimeout(client.authTimer);
      let sockets = this.byUser.get(client.user.id);
      if (!sockets) this.byUser.set(client.user.id, (sockets = new Set()));
      // One trader with many tabs (or a leaking script) gives up the oldest connection first.
      while (sockets.size >= config.ws.maxPerUser) {
        const oldest = sockets.values().next().value!;
        sockets.delete(oldest);
        oldest.socket.close(1008, 'Too many connections for this account');
      }
      sockets.add(client);
      return this.send(client, { type: 'ready', traderId: client.user.traderId, provider: market.providerName, feed: market.feedStatus });
    }

    if (!client.user) return this.send(client, { type: 'error', code: 'UNAUTHORIZED', message: 'Authenticate first' });

    switch (message.type) {
      case 'subscribe':
        await Promise.all(message.symbols.map((symbol) => this.subscribe(client, symbol)));
        break;
      case 'unsubscribe':
        for (const symbol of message.symbols) this.unsubscribe(client, symbol);
        break;
      case 'depth':
        this.watchDepth(client, message.symbol);
        break;
      case 'leaderboard': {
        const allowed = client.user.role === 'ADMIN' || (await findPortfolioId(client.user.id, message.competitionId));
        if (!allowed) return this.send(client, { type: 'error', code: 'FORBIDDEN', message: 'Not enrolled in that competition' });
        client.competitionId = message.competitionId;
        const board = await getLeaderboard(message.competitionId, config.leaderboard.size, client.user.traderId);
        if (board) this.send(client, { type: 'leaderboard', data: board });
        break;
      }
    }
  }

  private async subscribe(client: Client, symbol: string): Promise<void> {
    if (client.symbols.has(symbol) || client.pending.has(symbol)) return;
    if (client.symbols.size + client.pending.size >= MAX_SYMBOLS_PER_CLIENT) {
      return this.send(client, { type: 'error', code: 'SUBSCRIPTION_LIMIT', message: `Limit of ${MAX_SYMBOLS_PER_CLIENT} symbols reached` });
    }

    client.pending.add(symbol);
    const quote = await market.retain(symbol).finally(() => client.pending.delete(symbol));
    if (!quote) return this.send(client, { type: 'error', code: 'UNKNOWN_SYMBOL', symbol, message: `No market data for ${symbol}` });

    // The socket may have closed while the snapshot was loading; give the reference back.
    if (!this.clients.has(client)) return market.release(symbol);

    client.symbols.add(symbol);
    let subscribers = this.bySymbol.get(symbol);
    if (!subscribers) this.bySymbol.set(symbol, (subscribers = new Set()));
    subscribers.add(client);
    this.send(client, { type: 'quote', data: quote });
    if (client.depthWanted === symbol && client.depthSymbol !== symbol) this.watchDepth(client, symbol);
  }

  private unsubscribe(client: Client, symbol: string): void {
    if (!client.symbols.delete(symbol)) return;
    if (client.depthSymbol === symbol) this.watchDepth(client, null);
    const subscribers = this.bySymbol.get(symbol);
    subscribers?.delete(client);
    if (subscribers?.size === 0) this.bySymbol.delete(symbol);
    market.release(symbol);
  }

  /** Points a client's Level 2 at a symbol (or at nothing) and sends the book straight away. */
  private watchDepth(client: Client, symbol: string | null): void {
    if (client.depthSymbol) {
      const watchers = this.byDepth.get(client.depthSymbol);
      watchers?.delete(client);
      if (watchers?.size === 0) {
        this.byDepth.delete(client.depthSymbol);
        this.lastDepth.delete(client.depthSymbol);
      }
    }
    client.depthSymbol = null;
    client.depthWanted = symbol;
    // Only for a symbol the client is streaming, which is what keeps its quote alive. If that
    // subscription is still being set up, subscribe() comes back here when it is done.
    if (!symbol || !client.symbols.has(symbol)) return;
    client.depthSymbol = symbol;
    let watchers = this.byDepth.get(symbol);
    if (!watchers) this.byDepth.set(symbol, (watchers = new Set()));
    watchers.add(client);
    const frame = this.depthFrame(symbol);
    if (frame) this.sendRaw(client, frame);
  }

  /** Prices and sizes as pairs, best first: far smaller on the wire than objects. */
  private depthFrame(symbol: string): string | null {
    const book = market.getDepth(symbol);
    if (!book) return null;
    const shown = shownDepth(book);
    const pairs = (levels: Array<{ price: number; size: number }>) => levels.map((level) => [level.price, level.size]);
    return JSON.stringify({ type: 'depth', data: { symbol, bids: pairs(shown.bids), asks: pairs(shown.asks) } });
  }

  private flushDepth(): void {
    for (const [symbol, watchers] of this.byDepth) {
      const frame = this.depthFrame(symbol);
      if (!frame || frame === this.lastDepth.get(symbol)) continue;
      this.lastDepth.set(symbol, frame);
      for (const client of watchers) this.sendRaw(client, frame);
    }
  }

  private drop(client: Client): void {
    clearTimeout(client.authTimer);
    this.watchDepth(client, null);
    for (const symbol of [...client.symbols]) this.unsubscribe(client, symbol);
    if (client.user) {
      const sockets = this.byUser.get(client.user.id);
      sockets?.delete(client);
      if (sockets?.size === 0) this.byUser.delete(client.user.id);
    }
    this.clients.delete(client);
  }

  /**
   * Coalesces ticks: however fast the feed is, each client gets one frame per
   * flush carrying the latest quote of every symbol of theirs that changed.
   * Each quote is serialised once and shared by all its subscribers, and one
   * frame per client (rather than one per symbol) is what keeps a thousand
   * connections cheap.
   */
  private flushQuotes(): void {
    if (this.dirty.size === 0) return;
    const outbox = new Map<Client, string[]>();
    for (const symbol of this.dirty) {
      const subscribers = this.bySymbol.get(symbol);
      const quote = market.getQuote(symbol);
      if (!subscribers || !quote) continue;
      const json = JSON.stringify(quote);
      for (const client of subscribers) {
        const pending = outbox.get(client);
        if (pending) pending.push(json);
        else outbox.set(client, [json]);
      }
    }
    this.dirty.clear();
    for (const [client, quotes] of outbox) this.sendRaw(client, `{"type":"quotes","data":[${quotes.join(',')}]}`);
  }

  private async onLeaderboard(message: string): Promise<void> {
    let board: Leaderboard;
    try {
      board = JSON.parse(message) as Leaderboard;
    } catch {
      return;
    }
    for (const client of this.clients) {
      if (!client.user || client.competitionId !== board.competitionId) continue;
      const traderId = client.user.traderId;
      const inTop = board.entries.find((entry) => entry.traderId === traderId);
      if (inTop) {
        this.send(client, { type: 'leaderboard', data: { ...board, me: inTop } });
        continue;
      }
      // Outside the top N: look up this trader's own rank.
      getLeaderboard(board.competitionId, config.leaderboard.size, traderId)
        .then((full) => full && this.send(client, { type: 'leaderboard', data: full }))
        .catch((err) => logger.warn({ err: err.message }, 'Could not load trader standing'));
    }
  }

  private heartbeat(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }

  private sendToUser(userId: string, payload: object): void {
    const sockets = this.byUser.get(userId);
    if (!sockets) return;
    const frame = JSON.stringify(payload);
    for (const client of sockets) this.sendRaw(client, frame);
  }

  private send(client: Client, payload: object): void {
    this.sendRaw(client, JSON.stringify(payload));
  }

  private sendRaw(client: Client, frame: string): void {
    const { socket } = client;
    if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < MAX_BUFFERED_BYTES) socket.send(frame);
  }
}

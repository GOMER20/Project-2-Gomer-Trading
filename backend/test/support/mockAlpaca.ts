import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * A local stand-in for Alpaca's market data service, speaking the same REST
 * and WebSocket protocol (checked against the real service's responses).
 * Lets the Alpaca code path be exercised without an account.
 */

export const MOCK_KEY = 'PKMOCKKEY000000000000';
export const MOCK_SECRET = 'mock-secret-not-a-real-credential';

export interface MockSymbol {
  bid: number;
  ask: number;
  last: number;
  prevClose: number;
}

export interface MockAlpaca {
  streamUrl: string;
  dataUrl: string;
  symbols: Map<string, MockSymbol>;
  /** What the stream answers to an auth attempt with the right keys. */
  mode: 'ok' | 'connection-limit';
  /** Total WebSocket connections accepted so far. */
  connections: number;
  /** Symbols the most recent client asked for. */
  subscribed: Set<string>;
  /** Publishes a quote and/or trade to subscribed clients. */
  tick(symbol: string, update: { bid?: number; ask?: number; last?: number }): void;
  /** Drops every open stream connection, as a network failure would. */
  dropConnections(): void;
  close(): Promise<void>;
}

const UNAUTHORIZED = '<html><head><title>401 Authorization Required</title></head><body><center><h1>401 Authorization Required</h1></center></body></html>';

export async function startMockAlpaca(port = 0): Promise<MockAlpaca> {
  const symbols = new Map<string, MockSymbol>([
    ['AAPL', { bid: 229.98, ask: 230.02, last: 230.0, prevClose: 228.5 }],
    ['MSFT', { bid: 430.1, ask: 430.2, last: 430.15, prevClose: 431.0 }],
  ]);
  const clients = new Set<WebSocket>();
  const authenticated = new WeakSet<WebSocket>();

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.headers['apca-api-key-id'] !== MOCK_KEY || request.headers['apca-api-secret-key'] !== MOCK_SECRET) {
      response.writeHead(401, { 'content-type': 'text/html' }).end(UNAUTHORIZED);
      return;
    }
    const match = /^\/v2\/stocks\/([^/]+)\/(snapshot|bars)$/.exec(url.pathname);
    const symbol = match ? symbols.get(decodeURIComponent(match[1]!)) : undefined;
    if (!match || !symbol) {
      response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'not found' }));
      return;
    }
    const now = Date.now();
    const body =
      match[2] === 'snapshot'
        ? {
            latestTrade: { p: symbol.last, s: 100, t: new Date(now).toISOString() },
            latestQuote: { bp: symbol.bid, bs: 3, ap: symbol.ask, as: 2, t: new Date(now).toISOString() },
            dailyBar: { c: symbol.last },
            prevDailyBar: { c: symbol.prevClose },
          }
        : {
            // Newest first, as requested with sort=desc.
            bars: Array.from({ length: Math.min(Number(url.searchParams.get('limit') ?? 5), 600) }, (_, i) => {
              const close = symbol.last - i * 0.05;
              return { t: new Date(Math.floor(now / 60_000) * 60_000 - i * 60_000).toISOString(), o: close - 0.02, h: close + 0.1, l: close - 0.1, c: close, v: 1000 + i };
            }),
            symbol: match[1],
            next_page_token: null,
          };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });

  const wss = new WebSocketServer({ server });
  const send = (socket: WebSocket, ...messages: object[]) => socket.send(JSON.stringify(messages));

  const mock: MockAlpaca = {
    streamUrl: '',
    dataUrl: '',
    symbols,
    mode: 'ok',
    connections: 0,
    subscribed: new Set(),
    tick(name, update) {
      const symbol = symbols.get(name);
      if (!symbol) return;
      Object.assign(symbol, update);
      const t = new Date().toISOString();
      for (const socket of clients) {
        if (!authenticated.has(socket) || !mock.subscribed.has(name)) continue;
        if (update.bid !== undefined || update.ask !== undefined) send(socket, { T: 'q', S: name, bp: symbol.bid, bs: 3, ap: symbol.ask, as: 2, t });
        if (update.last !== undefined) send(socket, { T: 't', S: name, p: symbol.last, s: 100, t });
      }
    },
    dropConnections() {
      for (const socket of clients) socket.terminate();
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of clients) socket.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };

  wss.on('connection', (socket) => {
    mock.connections++;
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    send(socket, { T: 'success', msg: 'connected' });

    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { action: string; key?: string; secret?: string; quotes?: string[]; trades?: string[] };
      if (message.action === 'auth') {
        if (message.key !== MOCK_KEY || message.secret !== MOCK_SECRET) {
          send(socket, { T: 'error', code: 402, msg: 'auth failed' });
          socket.close();
        } else if (mock.mode === 'connection-limit') {
          send(socket, { T: 'error', code: 406, msg: 'connection limit exceeded' });
          socket.close();
        } else {
          authenticated.add(socket);
          mock.subscribed = new Set();
          send(socket, { T: 'success', msg: 'authenticated' });
        }
        return;
      }
      if (!authenticated.has(socket)) return send(socket, { T: 'error', code: 401, msg: 'not authenticated' });
      if (message.action === 'subscribe') for (const s of message.quotes ?? []) mock.subscribed.add(s);
      if (message.action === 'unsubscribe') for (const s of message.quotes ?? []) mock.subscribed.delete(s);
      send(socket, { T: 'subscription', trades: [...mock.subscribed], quotes: [...mock.subscribed], bars: [] });
    });
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: bound } = server.address() as AddressInfo;
  mock.streamUrl = `ws://127.0.0.1:${bound}`;
  mock.dataUrl = `http://127.0.0.1:${bound}`;
  return mock;
}

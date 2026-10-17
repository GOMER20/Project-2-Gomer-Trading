import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { feed, channelBits } from './feed.js';
import { authenticate, type KeyIdentity } from './keys.service.js';
import { account, cancelOrder, GatewayReject, newOrder, openOrders, orderStatus, report } from './pipeline.js';
import type { ChannelName, ExecutionReport, JsonRequest } from './protocol.js';
import { logonAllowed, logonFailed, newSessionId, registry, type Published, type Session } from './session.js';

const LOGON_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
/**
 * Messages a session may send in any one second before it is disconnected. Orders have their own
 * throttle, per key, of at most 5,000 a second; this is the ceiling on everything else alongside them.
 */
const MAX_MESSAGES_PER_SECOND = 12_000;
/** Market data is dropped for a session with this much unsent data; execution reports never are. */
const SLOW_READER_BYTES = 1_000_000;
const STUCK_READER_BYTES = 16_000_000;
const CHANNELS = new Set<ChannelName>(['bbo', 'trades', 'depth']);

const loopback = (address: string | undefined) => !address || address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

/** Who is really on the other end: behind this machine's own tunnel or proxy, the address it forwarded. */
function remoteAddress(request: IncomingMessage): string {
  const peer = request.socket.remoteAddress;
  const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim();
  return (loopback(peer) && forwarded) || peer || 'unknown';
}

/**
 * The standard gateway: JSON over WebSocket at /gateway.
 *
 * A program connects, sends `logon` with its API key, then subscribes to market
 * data and sends orders. Every request may carry an `id`, which is echoed in the
 * reply. Execution reports arrive as `exec` messages on their own, whenever
 * something happens to one of the account's orders.
 */
export class WsGateway {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });
  private readonly alive = new WeakMap<WebSocket, boolean>();
  private readonly heartbeat = setInterval(() => this.checkAlive(), HEARTBEAT_MS);

  constructor() {
    this.heartbeat.unref();
    this.wss.on('connection', (socket, request) => this.accept(socket, request));
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(request, socket, head, (ws) => this.wss.emit('connection', ws, request));
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const socket of this.wss.clients) socket.close(1001, 'Server shutting down');
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private checkAlive(): void {
    for (const socket of this.wss.clients) {
      if (this.alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      this.alive.set(socket, false);
      socket.ping();
    }
  }

  private accept(socket: WebSocket, request: IncomingMessage): void {
    const remote = remoteAddress(request);
    let session: Session | null = null;
    let windowStart = Date.now();
    let inWindow = 0;
    this.alive.set(socket, true);
    socket.on('pong', () => this.alive.set(socket, true));

    const send = (payload: object) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    };
    const reject = (request: { op?: string; id?: string | number; clOrdId?: string }, err: unknown) => {
      const refusal = err instanceof GatewayReject ? err : new GatewayReject('INTERNAL', 'The exchange could not process that.');
      if (!(err instanceof GatewayReject)) logger.error({ err }, 'Gateway WebSocket request failed');
      send({ op: 'reject', id: request.id, ref: request.op, clOrdId: request.clOrdId, code: refusal.reason, text: refusal.message });
    };

    const logonTimer = setTimeout(() => socket.close(1008, 'Logon timeout'), LOGON_TIMEOUT_MS);
    socket.on('close', () => {
      clearTimeout(logonTimer);
      if (!session) return;
      feed.drop(session);
      registry.remove(session);
    });
    socket.on('error', (err) => logger.debug({ err: err.message }, 'Gateway WebSocket error'));

    socket.on('message', (raw) => {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        inWindow = 0;
      }
      if (++inWindow > MAX_MESSAGES_PER_SECOND) return socket.close(1008, 'Message rate limit exceeded');

      let message: JsonRequest;
      try {
        message = JSON.parse(raw.toString()) as JsonRequest;
        if (typeof message !== 'object' || message === null || typeof message.op !== 'string') throw new Error('not a request');
      } catch {
        return reject({}, new GatewayReject('MALFORMED', 'Messages are JSON objects with an "op" field.'));
      }

      if (message.op === 'ping') return send({ op: 'pong', id: message.id, t: message.t, serverTime: Date.now() });

      if (message.op === 'logon') {
        if (session) return reject(message, new GatewayReject('MALFORMED', 'Already logged on.'));
        if (!logonAllowed(remote)) {
          reject(message, new GatewayReject('BAD_CREDENTIALS', 'Too many failed logons from this address. Wait a minute.'));
          return socket.close(1008, 'Too many failed logons');
        }
        const offered = typeof message.apiKey === 'string' ? message.apiKey : '';
        return void authenticate(offered)
          .then((identity) => {
            if (!identity) {
              logonFailed(remote);
              reject(message, new GatewayReject('BAD_CREDENTIALS', 'That API key is not valid, is disabled, or its sandbox is gone.'));
              return socket.close(1008, 'Bad credentials');
            }
            if (session || socket.readyState !== WebSocket.OPEN) return;
            clearTimeout(logonTimer);
            session = this.open(socket, identity, remote);
            send({
              op: 'logon.ack',
              id: message.id,
              sessionId: session.id.toString(),
              traderId: identity.traderId,
              competition: { id: identity.competitionId, name: identity.competitionName, startingBalance: identity.startingBalance },
              limits: { ordersPerSecond: identity.ordersPerSecond, maxOrderQty: config.trading.maxOrderQuantity },
              serverTime: Date.now(),
            });
          })
          .catch((err) => reject(message, err));
      }

      if (!session) return reject(message, new GatewayReject('NOT_LOGGED_ON', 'Send logon first.'));
      void this.handle(session, message, send).catch((err) => reject(message as { op: string; id?: string | number; clOrdId?: string }, err));
    });
  }

  private open(socket: WebSocket, identity: KeyIdentity, remote: string): Session {
    const session: Session = {
      id: newSessionId(),
      identity,
      transport: 'websocket',
      remote,
      connectedAt: Date.now(),
      subscriptions: new Map(),
      counters: { orders: 0, executions: 0, marketData: 0, dropped: 0 },
      sendExecution: (execution: ExecutionReport) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > STUCK_READER_BYTES) return socket.close(1008, 'Not reading execution reports');
        session.counters.executions++;
        socket.send(JSON.stringify({ op: 'exec', ...execution }));
      },
      sendMarketData: (event: Published) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > SLOW_READER_BYTES) return void session.counters.dropped++;
        session.counters.marketData++;
        socket.send(event.json());
      },
      close: (reason: string) => socket.close(1008, reason),
    };
    registry.add(session);
    return session;
  }

  private async handle(session: Session, message: JsonRequest, send: (payload: object) => void): Promise<void> {
    const { identity } = session;
    switch (message.op) {
      case 'subscribe':
      case 'unsubscribe': {
        const channels = Array.isArray(message.channels) ? message.channels.filter((c) => CHANNELS.has(c)) : [];
        const symbols = Array.isArray(message.symbols) ? message.symbols.map((s) => String(s).trim().toUpperCase()).slice(0, 200) : [];
        if (!channels.length || !symbols.length) throw new GatewayReject('MALFORMED', 'Give at least one channel (bbo, trades, depth) and one symbol.');
        const bits = channelBits(channels);
        const unknown: string[] = [];
        for (const symbol of symbols) {
          if (message.op === 'unsubscribe') feed.unsubscribe(session, symbol, bits);
          else if (!(await feed.subscribe(session, symbol, bits))) unknown.push(symbol);
        }
        return send({ op: `${message.op}.ack`, id: message.id, channels, symbols: symbols.filter((s) => !unknown.includes(s)), unknown });
      }
      case 'order.new': {
        session.counters.orders++;
        const order = await newOrder(identity, {
          clOrdId: message.clOrdId,
          symbol: String(message.symbol ?? ''),
          side: message.side === 'BUY' || message.side === 'SELL' ? message.side : undefined,
          type: ['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT'].includes(message.type) ? message.type : undefined,
          timeInForce: message.tif === 'IOC' || message.tif === 'FOK' ? message.tif : 'GTC',
          quantity: Number(message.qty),
          price: message.price,
          stopPrice: message.stopPrice,
        });
        // The execution reports for this order are sent from the engine's event stream and may arrive first.
        return send({ op: 'order.ack', id: message.id, orderId: order.id, clOrdId: order.clientOrderId, ordStatus: report(order).ordStatus });
      }
      case 'order.cancel': {
        const order = await cancelOrder(identity, message);
        return send({ op: 'order.cancel.ack', id: message.id, orderId: order.id, clOrdId: order.clientOrderId });
      }
      case 'order.status':
        return send({ op: 'order.status', id: message.id, ...(await orderStatus(identity, message)) });
      case 'orders.open':
        return send({ op: 'orders.open', id: message.id, orders: await openOrders(identity) });
      case 'account':
        return send({ op: 'account', id: message.id, account: await account(identity) });
      default:
        throw new GatewayReject('MALFORMED', `Unknown op "${String((message as { op: unknown }).op)}".`);
    }
  }
}

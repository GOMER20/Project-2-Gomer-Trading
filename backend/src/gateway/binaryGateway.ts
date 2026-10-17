import fs from 'node:fs';
import net from 'node:net';
import { logger } from '../lib/logger.js';
import { feed } from './feed.js';
import { authenticate } from './keys.service.js';
import { cancelOrder, GatewayReject, newOrder, orderStatus } from './pipeline.js';
import {
  decodeClOrdId,
  decodeHeartbeat,
  decodeLogon,
  decodeNewOrder,
  decodeSubscribe,
  encodeExecReport,
  encodeHeartbeatAck,
  encodeLogonAck,
  encodeReject,
  Framer,
  Msg,
  RejectCode,
  withSeq,
  type ExecutionReport,
} from './protocol.js';
import { logonAllowed, logonFailed, newSessionId, registry, type Published, type Session } from './session.js';

const LOGON_TIMEOUT_MS = 5_000;
const SLOW_READER_BYTES = 1_000_000;
const STUCK_READER_BYTES = 16_000_000;
const NO_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * The low-latency gateway: the binary protocol of protocol.ts over a TCP
 * socket and over a Unix domain socket (same bytes on both).
 *
 * It exists for programs running beside the exchange, on the same machine or
 * network, that want the shortest path in: fixed-size structs they can read
 * with a cast, Nagle's algorithm off, market data pushed in the same turn of
 * the event loop that produced it, and no JSON anywhere. The Unix socket skips
 * the TCP stack as well and is the fastest way in for a program on this host.
 *
 * The first frame must be LOGON. An accepted order is acknowledged by its
 * first execution report; only a refusal gets a REJECT frame.
 */
export class BinaryGateway {
  private readonly servers: net.Server[] = [];
  private readonly sockets = new Set<net.Socket>();

  /** Starts the listeners that are configured. Either, both or neither may be. */
  async listen(options: { tcpPort?: number; tcpHost?: string; unixSocket?: string }): Promise<{ tcp?: string; unix?: string }> {
    const bound: { tcp?: string; unix?: string } = {};
    if (options.tcpPort) {
      const host = options.tcpHost ?? '127.0.0.1';
      await this.start((server) => server.listen(options.tcpPort, host), 'tcp');
      bound.tcp = `${host}:${options.tcpPort}`;
    }
    if (options.unixSocket) {
      // A socket file left by a previous run would make listen() fail.
      fs.rmSync(options.unixSocket, { force: true });
      await this.start((server) => server.listen(options.unixSocket), 'unix');
      fs.chmodSync(options.unixSocket, 0o600); // only this user's programs may connect
      bound.unix = options.unixSocket;
    }
    return bound;
  }

  private start(listen: (server: net.Server) => void, transport: 'tcp' | 'unix'): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer({ noDelay: true }, (socket) => this.accept(socket, transport));
      server.once('error', reject);
      server.once('listening', () => {
        server.off('error', reject);
        server.on('error', (err) => logger.error({ err }, 'Binary gateway listener error'));
        resolve();
      });
      listen(server);
      this.servers.push(server);
    });
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await Promise.all(this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }

  private accept(socket: net.Socket, transport: 'tcp' | 'unix'): void {
    const remote = transport === 'unix' ? 'unix' : (socket.remoteAddress ?? 'unknown');
    const framer = new Framer();
    let session: Session | null = null;
    let outSeq = 0;
    let loggingOn = false;
    this.sockets.add(socket);
    socket.setNoDelay(true);

    const reject = (refSeq: number, refType: number, code: number, text: string, clOrdId = 0n) => {
      if (!socket.destroyed) socket.write(encodeReject(++outSeq, { refSeq, refType, code, clOrdId, text }));
    };
    const refuse = (refSeq: number, refType: number, err: unknown, clOrdId = 0n) => {
      if (err instanceof GatewayReject) return reject(refSeq, refType, err.code, err.message, clOrdId);
      logger.error({ err }, 'Binary gateway request failed');
      reject(refSeq, refType, RejectCode.INTERNAL, 'The exchange could not process that.', clOrdId);
    };

    const logonTimer = setTimeout(() => socket.destroy(), LOGON_TIMEOUT_MS);
    socket.on('error', (err) => logger.debug({ err: err.message }, 'Binary gateway socket error'));
    socket.on('close', () => {
      clearTimeout(logonTimer);
      this.sockets.delete(socket);
      if (!session) return;
      feed.drop(session);
      registry.remove(session);
    });

    const onFrame = (frame: Buffer, type: number, seq: number) => {
      if (type === Msg.HEARTBEAT) return void socket.write(encodeHeartbeatAck(++outSeq, decodeHeartbeat(frame)));

      if (type === Msg.LOGON) {
        if (session || loggingOn) return reject(seq, type, RejectCode.MALFORMED, 'Already logged on.');
        if (!logonAllowed(remote)) {
          reject(seq, type, RejectCode.BAD_CREDENTIALS, 'Too many failed logons. Wait a minute.');
          return void socket.end();
        }
        loggingOn = true;
        return void authenticate(decodeLogon(frame).apiKey)
          .then((identity) => {
            loggingOn = false;
            if (socket.destroyed) return;
            if (!identity) {
              logonFailed(remote);
              reject(seq, type, RejectCode.BAD_CREDENTIALS, 'API key not valid, disabled, or sandbox gone.');
              return void socket.end();
            }
            clearTimeout(logonTimer);
            const opened: Session = {
              id: newSessionId(),
              identity,
              transport,
              remote,
              connectedAt: Date.now(),
              subscriptions: new Map(),
              counters: { orders: 0, executions: 0, marketData: 0, dropped: 0 },
              sendExecution: (execution: ExecutionReport) => {
                if (socket.destroyed) return;
                if (socket.writableLength > STUCK_READER_BYTES) return void socket.destroy();
                opened.counters.executions++;
                socket.write(encodeExecReport(++outSeq, execution));
              },
              sendMarketData: (event: Published) => {
                if (socket.destroyed) return;
                if (socket.writableLength > SLOW_READER_BYTES) return void opened.counters.dropped++;
                opened.counters.marketData++;
                socket.write(withSeq(event.binary(), ++outSeq));
              },
              close: () => socket.destroy(),
            };
            session = opened;
            registry.add(opened);
            socket.write(
              encodeLogonAck(++outSeq, {
                ok: true,
                ordersPerSecond: identity.ordersPerSecond,
                sessionId: opened.id,
                traderId: identity.traderId,
                competitionId: identity.competitionId,
                startingBalance: identity.startingBalance,
              }),
            );
          })
          .catch((err) => {
            loggingOn = false;
            refuse(seq, type, err);
          });
      }

      if (!session) return reject(seq, type, RejectCode.NOT_LOGGED_ON, 'Send LOGON first.');
      const current = session;

      switch (type) {
        case Msg.SUBSCRIBE:
        case Msg.UNSUBSCRIBE: {
          const { symbol, channels } = decodeSubscribe(frame);
          if (type === Msg.UNSUBSCRIBE) return feed.unsubscribe(current, symbol, channels);
          return void feed
            .subscribe(current, symbol, channels)
            .then((known) => (known ? undefined : reject(seq, type, RejectCode.UNKNOWN_SYMBOL, `${symbol} is not tradable here.`)))
            .catch((err) => refuse(seq, type, err));
        }
        case Msg.NEW_ORDER: {
          const order = decodeNewOrder(frame);
          current.counters.orders++;
          return void newOrder(current.identity, {
            clOrdId: order.clOrdId === 0n ? null : order.clOrdId.toString(),
            symbol: order.symbol,
            side: order.side,
            type: order.type,
            timeInForce: order.timeInForce,
            quantity: order.quantity,
            price: order.price,
            stopPrice: order.stopPrice,
          }).catch((err) => refuse(seq, type, err, order.clOrdId));
        }
        case Msg.CANCEL: {
          const clOrdId = decodeClOrdId(frame);
          return void cancelOrder(current.identity, { clOrdId: clOrdId.toString() }).catch((err) => refuse(seq, type, err, clOrdId));
        }
        case Msg.STATUS: {
          const clOrdId = decodeClOrdId(frame);
          return void orderStatus(current.identity, { clOrdId: clOrdId.toString() })
            .then((status) => void (socket.destroyed ? undefined : socket.write(encodeExecReport(++outSeq, { ...status, orderId: status.orderId || NO_UUID }))))
            .catch((err) => refuse(seq, type, err, clOrdId));
        }
        default:
          return reject(seq, type, RejectCode.MALFORMED, `Unknown message type 0x${type.toString(16)}.`);
      }
    };

    socket.on('data', (chunk) => {
      try {
        framer.push(chunk, onFrame);
      } catch (err) {
        // A stream that has lost its framing cannot be recovered; say why and hang up.
        reject(0, 0, RejectCode.MALFORMED, (err as Error).message);
        socket.end();
      }
    });
  }
}

/**
 * Reference client for the binary gateway, in TypeScript.
 *
 * It is what the gateway's own tests and benchmark use, and it is the shortest
 * complete example of speaking the protocol: connect, LOGON, subscribe, send
 * orders, read execution reports. A client in C, Rust or Python does the same
 * things with the struct layouts in docs/gateway/gomer_gateway.h.
 */
import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { OrderSide, OrderType, TimeInForce } from '../types.js';
import {
  BodySize,
  CHANNEL_BITS,
  EXEC_TYPE_CODE,
  frame,
  Framer,
  Msg,
  ORD_STATUS_CODE,
  PRICE_SCALE,
  RejectCode,
  SIDE_CODE,
  SIDE_NAME,
  TIF_CODE,
  TYPE_CODE,
  TYPE_NAME,
  uuidText,
  type BboUpdate,
  type ChannelName,
  type DepthUpdate,
  type ExecType,
  type OrdStatus,
  type TradePrint,
} from './protocol.js';

const fixed = (value: number | undefined) => BigInt(Math.round((value ?? 0) * PRICE_SCALE));
const dollars = (value: bigint) => Number(value) / PRICE_SCALE;
const millis = (nanos: bigint) => Number(nanos / 1_000_000n);
const text = (b: Buffer, offset: number, width: number) => {
  const end = b.indexOf(0, offset);
  return b.toString('ascii', offset, end === -1 || end > offset + width ? offset + width : end);
};
const nameOf = <T extends string>(codes: Record<T, number>, code: number) => (Object.keys(codes) as T[]).find((key) => codes[key] === code)!;

export interface BinaryExecution {
  clOrdId: bigint;
  orderId: string;
  symbol: string;
  execType: ExecType;
  ordStatus: OrdStatus;
  side: OrderSide;
  ordType: OrderType;
  orderQty: number;
  cumQty: number;
  leavesQty: number;
  lastQty: number;
  lastPx: number;
  avgPx: number;
  commission: number;
  slippage: number;
  transactTimeNs: bigint;
}

export interface BinaryReject {
  refSeq: number;
  refType: number;
  code: number;
  reason: string;
  clOrdId: bigint;
  text: string;
}

export interface LogonAck {
  ordersPerSecond: number;
  sessionId: bigint;
  traderId: string;
  competitionId: string;
  startingBalance: number;
}

interface Events {
  exec: [BinaryExecution];
  reject: [BinaryReject];
  bbo: [BboUpdate];
  trade: [TradePrint];
  depth: [DepthUpdate];
  heartbeat: [{ clientTimeNs: bigint; serverTimeNs: bigint }];
  close: [];
}

export class BinaryClient extends EventEmitter<Events> {
  private seq = 0;
  private readonly framer = new Framer();

  private constructor(private readonly socket: net.Socket) {
    super();
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.framer.push(chunk, (data, type) => this.onFrame(data, type)));
    socket.on('close', () => this.emit('close'));
    socket.on('error', () => undefined);
  }

  /** Connects over TCP (`{ host, port }`) or a Unix domain socket (`{ path }`). */
  static connect(where: { host?: string; port: number } | { path: string }): Promise<BinaryClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(where as net.NetConnectOpts);
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        resolve(new BinaryClient(socket));
      });
    });
  }

  /** Sends LOGON and resolves with the acknowledgement, or rejects with the gateway's reason. */
  logon(apiKey: string): Promise<LogonAck> {
    return new Promise((resolve, reject) => {
      const onReject = (refusal: BinaryReject) => {
        this.off('close', onClose);
        reject(new Error(`${refusal.reason}: ${refusal.text}`));
      };
      const onClose = () => reject(new Error('connection closed during logon'));
      this.once('reject', onReject);
      this.once('close', onClose);
      this.pendingLogon = (ack) => {
        this.off('reject', onReject);
        this.off('close', onClose);
        resolve(ack);
      };
      const b = frame(Msg.LOGON, BodySize[Msg.LOGON], ++this.seq);
      b.write(apiKey, 8, 64, 'ascii');
      this.socket.write(b);
    });
  }
  private pendingLogon: ((ack: LogonAck) => void) | null = null;

  subscribe(symbol: string, channels: ChannelName[], on = true): void {
    const b = frame(on ? Msg.SUBSCRIBE : Msg.UNSUBSCRIBE, BodySize[Msg.SUBSCRIBE], ++this.seq);
    b.write(symbol, 8, 8, 'ascii');
    b.writeUInt8(channels.reduce((bits, name) => bits | CHANNEL_BITS[name], 0), 16);
    this.socket.write(b);
  }

  /** NewOrderSingle. Returns the frame's sequence number, which a REJECT refers back to. */
  newOrder(order: { clOrdId: bigint; symbol: string; side: OrderSide; type: OrderType; tif?: TimeInForce; qty: number; price?: number; stopPrice?: number }): number {
    const b = frame(Msg.NEW_ORDER, BodySize[Msg.NEW_ORDER], ++this.seq);
    b.writeBigUInt64LE(order.clOrdId, 8);
    b.write(order.symbol, 16, 8, 'ascii');
    b.writeUInt8(SIDE_CODE[order.side], 24);
    b.writeUInt8(TYPE_CODE[order.type], 25);
    b.writeUInt8(TIF_CODE[order.tif ?? 'GTC'], 26);
    b.writeUInt32LE(order.qty, 28);
    b.writeBigInt64LE(fixed(order.price), 32);
    b.writeBigInt64LE(fixed(order.stopPrice), 40);
    this.socket.write(b);
    return this.seq;
  }

  cancel(clOrdId: bigint): void {
    this.socket.write(this.reference(Msg.CANCEL, clOrdId));
  }

  status(clOrdId: bigint): void {
    this.socket.write(this.reference(Msg.STATUS, clOrdId));
  }

  /** Sends a heartbeat carrying the current time; the reply (a 'heartbeat' event) echoes it, which measures the round trip. */
  heartbeat(): void {
    const b = frame(Msg.HEARTBEAT, BodySize[Msg.HEARTBEAT], ++this.seq);
    b.writeBigUInt64LE(process.hrtime.bigint(), 8);
    this.socket.write(b);
  }

  /** For tests: sends arbitrary bytes. */
  raw(bytes: Buffer): void {
    this.socket.write(bytes);
  }

  close(): void {
    this.socket.destroy();
  }

  /** Resolves with the first event of a kind that passes `test`, or null after the timeout. */
  next<K extends keyof Events>(event: K, test: (...args: Events[K]) => boolean = () => true, timeoutMs = 5000): Promise<Events[K][0] | null> {
    return new Promise((resolve) => {
      const listener = ((...args: Events[K]) => {
        if (!test(...args)) return;
        clearTimeout(timer);
        this.off(event, listener as never);
        resolve(args[0] ?? null);
      }) as never;
      const timer = setTimeout(() => {
        this.off(event, listener);
        resolve(null);
      }, timeoutMs);
      this.on(event, listener);
    });
  }

  private reference(type: number, clOrdId: bigint): Buffer {
    const b = frame(type, 8, ++this.seq);
    b.writeBigUInt64LE(clOrdId, 8);
    return b;
  }

  private onFrame(b: Buffer, type: number): void {
    switch (type) {
      case Msg.LOGON_ACK:
        this.pendingLogon?.({
          ordersPerSecond: b.readUInt32LE(12),
          sessionId: b.readBigUInt64LE(16),
          traderId: text(b, 24, 24),
          competitionId: uuidText(b.subarray(48, 64)),
          startingBalance: dollars(b.readBigInt64LE(64)),
        });
        this.pendingLogon = null;
        break;
      case Msg.HEARTBEAT_ACK:
        this.emit('heartbeat', { clientTimeNs: b.readBigUInt64LE(8), serverTimeNs: b.readBigUInt64LE(16) });
        break;
      case Msg.REJECT: {
        const code = b.readUInt16LE(14);
        this.emit('reject', { refSeq: b.readUInt32LE(8), refType: b.readUInt8(12), code, reason: nameOf(RejectCode, code) ?? String(code), clOrdId: b.readBigUInt64LE(16), text: text(b, 24, 48) });
        break;
      }
      case Msg.EXEC_REPORT:
        this.emit('exec', {
          clOrdId: b.readBigUInt64LE(8),
          orderId: uuidText(b.subarray(16, 32)),
          symbol: text(b, 32, 8),
          execType: nameOf(EXEC_TYPE_CODE, b.readUInt8(40)),
          ordStatus: nameOf(ORD_STATUS_CODE, b.readUInt8(41)),
          side: SIDE_NAME[b.readUInt8(42)]!,
          ordType: TYPE_NAME[b.readUInt8(43)]!,
          orderQty: b.readUInt32LE(44),
          cumQty: b.readUInt32LE(48),
          leavesQty: b.readUInt32LE(52),
          lastQty: b.readUInt32LE(56),
          lastPx: dollars(b.readBigInt64LE(64)),
          avgPx: dollars(b.readBigInt64LE(72)),
          commission: dollars(b.readBigInt64LE(80)),
          slippage: dollars(b.readBigInt64LE(88)),
          transactTimeNs: b.readBigUInt64LE(96),
        });
        break;
      case Msg.BBO:
        this.emit('bbo', { symbol: text(b, 8, 8), bid: dollars(b.readBigInt64LE(16)), ask: dollars(b.readBigInt64LE(24)), bidSize: b.readUInt32LE(32), askSize: b.readUInt32LE(36), ts: millis(b.readBigUInt64LE(40)) });
        break;
      case Msg.TRADE:
        this.emit('trade', { symbol: text(b, 8, 8), price: dollars(b.readBigInt64LE(16)), size: b.readUInt32LE(24), ts: millis(b.readBigUInt64LE(32)) });
        break;
      case Msg.DEPTH: {
        const bids = b.readUInt8(24);
        const asks = b.readUInt8(25);
        const level = (i: number): [number, number] => [dollars(b.readBigInt64LE(32 + i * 16)), b.readUInt32LE(40 + i * 16)];
        this.emit('depth', {
          symbol: text(b, 8, 8),
          ts: millis(b.readBigUInt64LE(16)),
          bids: Array.from({ length: bids }, (_, i) => level(i)),
          asks: Array.from({ length: asks }, (_, i) => level(bids + i)),
        });
        break;
      }
    }
  }
}

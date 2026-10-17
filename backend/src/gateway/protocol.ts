/**
 * Wire formats of the bot gateway.
 *
 * Two encodings carry the same messages:
 *
 *  - JSON over WebSocket (and REST) for ordinary trading programs. See the
 *    `Json*` types below; the field names are the documentation.
 *  - A flat binary protocol over TCP or a Unix domain socket for programs that
 *    count microseconds. Every message is a fixed-layout little-endian struct
 *    (see docs/gateway/gomer_gateway.h for the same layouts as C), so a client
 *    can read one with a single cast and no parsing.
 *
 * Binary conventions: little-endian throughout; prices and money are signed
 * 64-bit integers in units of 1/10000 of a dollar; quantities are unsigned
 * 32-bit share counts; symbols and ids are fixed-width ASCII padded with NUL;
 * times are nanoseconds since the Unix epoch.
 */
import type { OrderSide, OrderType, TimeInForce } from '../types.js';

export const PROTOCOL_VERSION = 1;
export const HEADER_SIZE = 8;
/** No frame is larger than this; a longer length field means a corrupt or hostile stream. */
export const MAX_FRAME = 1024;
export const PRICE_SCALE = 10_000;

export const Msg = {
  LOGON: 0x01,
  LOGON_ACK: 0x02,
  HEARTBEAT: 0x03,
  HEARTBEAT_ACK: 0x04,
  REJECT: 0x05,
  SUBSCRIBE: 0x10,
  UNSUBSCRIBE: 0x11,
  NEW_ORDER: 0x20,
  CANCEL: 0x21,
  STATUS: 0x22,
  EXEC_REPORT: 0x30,
  BBO: 0x40,
  TRADE: 0x41,
  DEPTH: 0x42,
} as const;

/** Body sizes in bytes, excluding the 8-byte header. DEPTH is this plus 16 per level. */
export const BodySize = {
  [Msg.LOGON]: 72,
  [Msg.LOGON_ACK]: 64,
  [Msg.HEARTBEAT]: 8,
  [Msg.HEARTBEAT_ACK]: 16,
  [Msg.REJECT]: 64,
  [Msg.SUBSCRIBE]: 16,
  [Msg.UNSUBSCRIBE]: 16,
  [Msg.NEW_ORDER]: 40,
  [Msg.CANCEL]: 8,
  [Msg.STATUS]: 8,
  [Msg.EXEC_REPORT]: 96,
  [Msg.BBO]: 40,
  [Msg.TRADE]: 32,
  [Msg.DEPTH]: 24,
} as const;

export const Channel = { BBO: 1, TRADES: 2, DEPTH: 4 } as const;
export type ChannelName = 'bbo' | 'trades' | 'depth';
export const CHANNEL_BITS: Record<ChannelName, number> = { bbo: Channel.BBO, trades: Channel.TRADES, depth: Channel.DEPTH };

/** Numeric codes follow FIX where FIX has one (Side, OrdType, TimeInForce). */
export const SIDE_CODE: Record<OrderSide, number> = { BUY: 1, SELL: 2 };
export const SIDE_NAME: Record<number, OrderSide> = { 1: 'BUY', 2: 'SELL' };
export const TYPE_CODE: Record<OrderType, number> = { MARKET: 1, LIMIT: 2, STOP: 3, STOP_LIMIT: 4 };
export const TYPE_NAME: Record<number, OrderType> = { 1: 'MARKET', 2: 'LIMIT', 3: 'STOP', 4: 'STOP_LIMIT' };
export const TIF_CODE: Record<TimeInForce, number> = { GTC: 1, IOC: 3, FOK: 4 };
export const TIF_NAME: Record<number, TimeInForce> = { 0: 'GTC', 1: 'GTC', 3: 'IOC', 4: 'FOK' };

export type ExecType = 'NEW' | 'PARTIAL_FILL' | 'FILL' | 'CANCELED' | 'REJECTED' | 'TRIGGERED' | 'STATUS' | 'RESTATED';
export type OrdStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED';
export const EXEC_TYPE_CODE: Record<ExecType, number> = { NEW: 0, PARTIAL_FILL: 1, FILL: 2, CANCELED: 3, REJECTED: 4, TRIGGERED: 5, STATUS: 6, RESTATED: 7 };
export const ORD_STATUS_CODE: Record<OrdStatus, number> = { NEW: 0, PARTIALLY_FILLED: 1, FILLED: 2, CANCELED: 3, REJECTED: 4 };

/** Why a message was refused. The same codes are used in both encodings. */
export const RejectCode = {
  NOT_LOGGED_ON: 1,
  BAD_CREDENTIALS: 2,
  MALFORMED: 3,
  UNKNOWN_SYMBOL: 4,
  THROTTLED: 5,
  RISK: 6,
  UNKNOWN_ORDER: 7,
  TOO_LATE_TO_CANCEL: 8,
  DUPLICATE_CL_ORD_ID: 9,
  BUSY: 10,
  SANDBOX_CLOSED: 11,
  INTERNAL: 99,
} as const;
export type RejectName = keyof typeof RejectCode;

// --- what both encodings carry -----------------------------------------------

/** Everything a program is told about one step in the life of one of its orders. */
export interface ExecutionReport {
  orderId: string;
  /** The program's own reference. Null for orders it did not send through the gateway (bracket exits, liquidations). */
  clOrdId: string | null;
  symbol: string;
  side: OrderSide;
  ordType: OrderType;
  timeInForce: TimeInForce;
  execType: ExecType;
  ordStatus: OrdStatus;
  orderQty: number;
  /** Shares done so far, and shares still working. */
  cumQty: number;
  leavesQty: number;
  /** This step: shares that just traded and their average price. Zero and null when the step is not a fill. */
  lastQty: number;
  lastPx: number | null;
  /** Average price of everything done so far. */
  avgPx: number | null;
  /** Commission charged on the order so far. */
  commission: number;
  /** The price on the order's side of the book when it arrived. */
  arrivalPx: number | null;
  /** Average price paid above the arrival price (received below it, for a sell), per share. Positive is worse. */
  slippage: number | null;
  slippageBps: number | null;
  /** Why, for a rejection or a cancellation the program did not ask for. */
  text: string | null;
  transactTime: number;
}

export interface BboUpdate {
  symbol: string;
  bid: number;
  bidSize: number;
  ask: number;
  askSize: number;
  ts: number;
}

export interface TradePrint {
  symbol: string;
  price: number;
  size: number;
  ts: number;
}

export interface DepthUpdate {
  symbol: string;
  bids: Array<[price: number, size: number]>;
  asks: Array<[price: number, size: number]>;
  ts: number;
}

// --- binary encoding -----------------------------------------------------------

const toFixed = (value: number | null) => BigInt(Math.round((value ?? 0) * PRICE_SCALE));
const fromFixed = (value: bigint) => Number(value) / PRICE_SCALE;
const nanos = (ms: number) => BigInt(Math.round(ms)) * 1_000_000n;

function ascii(buffer: Buffer, offset: number, width: number, text: string): void {
  buffer.fill(0, offset, offset + width);
  buffer.write(text.slice(0, width), offset, 'ascii');
}

function readAscii(buffer: Buffer, offset: number, width: number): string {
  const end = buffer.indexOf(0, offset);
  return buffer.toString('ascii', offset, end === -1 || end > offset + width ? offset + width : end);
}

const uuidBytes = (id: string) => Buffer.from(id.replace(/-/g, ''), 'hex');
export const uuidText = (bytes: Buffer) => bytes.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

/** Allocates a frame and writes its header. The caller fills in the body from HEADER_SIZE on. */
export function frame(type: number, bodySize: number, seq: number): Buffer {
  const buffer = Buffer.allocUnsafe(HEADER_SIZE + bodySize);
  buffer.fill(0, HEADER_SIZE);
  buffer.writeUInt16LE(HEADER_SIZE + bodySize, 0);
  buffer.writeUInt8(type, 2);
  buffer.writeUInt8(PROTOCOL_VERSION, 3);
  buffer.writeUInt32LE(seq >>> 0, 4);
  return buffer;
}

export function encodeLogonAck(seq: number, ack: { ok: boolean; ordersPerSecond: number; sessionId: bigint; traderId: string; competitionId: string; startingBalance: number }): Buffer {
  const b = frame(Msg.LOGON_ACK, BodySize[Msg.LOGON_ACK], seq);
  b.writeUInt8(ack.ok ? 0 : 1, 8);
  b.writeUInt32LE(ack.ordersPerSecond, 12);
  b.writeBigUInt64LE(ack.sessionId, 16);
  ascii(b, 24, 24, ack.traderId);
  uuidBytes(ack.competitionId).copy(b, 48);
  b.writeBigInt64LE(toFixed(ack.startingBalance), 64);
  return b;
}

export function encodeHeartbeatAck(seq: number, clientTimeNs: bigint): Buffer {
  const b = frame(Msg.HEARTBEAT_ACK, BodySize[Msg.HEARTBEAT_ACK], seq);
  b.writeBigUInt64LE(clientTimeNs, 8);
  b.writeBigUInt64LE(process.hrtime.bigint() - HR_OFFSET, 16);
  return b;
}
/** Turns the monotonic clock into wall-clock nanoseconds, so timestamps have nanosecond steps but real dates. */
const HR_OFFSET = process.hrtime.bigint() - BigInt(Date.now()) * 1_000_000n;
export const nowNanos = () => process.hrtime.bigint() - HR_OFFSET;

export function encodeReject(seq: number, reject: { refSeq: number; refType: number; code: number; clOrdId: bigint; text: string }): Buffer {
  const b = frame(Msg.REJECT, BodySize[Msg.REJECT], seq);
  b.writeUInt32LE(reject.refSeq >>> 0, 8);
  b.writeUInt8(reject.refType, 12);
  b.writeUInt16LE(reject.code, 14);
  b.writeBigUInt64LE(reject.clOrdId, 16);
  ascii(b, 24, 48, reject.text);
  return b;
}

/** A client order id travels as an unsigned 64-bit integer in binary. Anything else (or none) is sent as zero. */
export const clOrdIdNumber = (clOrdId: string | null) => (clOrdId && /^\d{1,19}$/.test(clOrdId) ? BigInt(clOrdId) : 0n);

export function encodeExecReport(seq: number, report: ExecutionReport): Buffer {
  const b = frame(Msg.EXEC_REPORT, BodySize[Msg.EXEC_REPORT], seq);
  b.writeBigUInt64LE(clOrdIdNumber(report.clOrdId), 8);
  uuidBytes(report.orderId).copy(b, 16);
  ascii(b, 32, 8, report.symbol);
  b.writeUInt8(EXEC_TYPE_CODE[report.execType], 40);
  b.writeUInt8(ORD_STATUS_CODE[report.ordStatus], 41);
  b.writeUInt8(SIDE_CODE[report.side], 42);
  b.writeUInt8(TYPE_CODE[report.ordType], 43);
  b.writeUInt32LE(report.orderQty, 44);
  b.writeUInt32LE(report.cumQty, 48);
  b.writeUInt32LE(report.leavesQty, 52);
  b.writeUInt32LE(report.lastQty, 56);
  b.writeBigInt64LE(toFixed(report.lastPx), 64);
  b.writeBigInt64LE(toFixed(report.avgPx), 72);
  b.writeBigInt64LE(toFixed(report.commission), 80);
  b.writeBigInt64LE(toFixed(report.slippage), 88);
  b.writeBigUInt64LE(nanos(report.transactTime), 96);
  return b;
}

export function encodeBbo(seq: number, bbo: BboUpdate): Buffer {
  const b = frame(Msg.BBO, BodySize[Msg.BBO], seq);
  ascii(b, 8, 8, bbo.symbol);
  b.writeBigInt64LE(toFixed(bbo.bid), 16);
  b.writeBigInt64LE(toFixed(bbo.ask), 24);
  b.writeUInt32LE(bbo.bidSize >>> 0, 32);
  b.writeUInt32LE(bbo.askSize >>> 0, 36);
  b.writeBigUInt64LE(nanos(bbo.ts), 40);
  return b;
}

export function encodeTrade(seq: number, trade: TradePrint): Buffer {
  const b = frame(Msg.TRADE, BodySize[Msg.TRADE], seq);
  ascii(b, 8, 8, trade.symbol);
  b.writeBigInt64LE(toFixed(trade.price), 16);
  b.writeUInt32LE(trade.size >>> 0, 24);
  b.writeBigUInt64LE(nanos(trade.ts), 32);
  return b;
}

export function encodeDepth(seq: number, depth: DepthUpdate): Buffer {
  const levels = [...depth.bids, ...depth.asks];
  const b = frame(Msg.DEPTH, BodySize[Msg.DEPTH] + levels.length * 16, seq);
  ascii(b, 8, 8, depth.symbol);
  b.writeBigUInt64LE(nanos(depth.ts), 16);
  b.writeUInt8(depth.bids.length, 24);
  b.writeUInt8(depth.asks.length, 25);
  levels.forEach(([price, size], i) => {
    b.writeBigInt64LE(toFixed(price), 32 + i * 16);
    b.writeUInt32LE(size >>> 0, 40 + i * 16);
  });
  return b;
}

/** Stamps a sequence number into a frame that was encoded once and is being sent to many sessions. */
export function withSeq(shared: Buffer, seq: number): Buffer {
  const copy = Buffer.from(shared);
  copy.writeUInt32LE(seq >>> 0, 4);
  return copy;
}

// Messages a client sends. Decoders trust the length: the framer has already checked it.

export interface BinaryLogon {
  apiKey: string;
  heartbeatMs: number;
}
export const decodeLogon = (b: Buffer): BinaryLogon => ({ apiKey: readAscii(b, 8, 64), heartbeatMs: b.readUInt32LE(72) });

export const decodeSubscribe = (b: Buffer) => ({ symbol: readAscii(b, 8, 8).toUpperCase(), channels: b.readUInt8(16) });

export interface BinaryNewOrder {
  clOrdId: bigint;
  symbol: string;
  side: OrderSide | undefined;
  type: OrderType | undefined;
  timeInForce: TimeInForce | undefined;
  quantity: number;
  price: number;
  stopPrice: number;
}
export const decodeNewOrder = (b: Buffer): BinaryNewOrder => ({
  clOrdId: b.readBigUInt64LE(8),
  symbol: readAscii(b, 16, 8).toUpperCase(),
  side: SIDE_NAME[b.readUInt8(24)],
  type: TYPE_NAME[b.readUInt8(25)],
  timeInForce: TIF_NAME[b.readUInt8(26)],
  quantity: b.readUInt32LE(28),
  price: fromFixed(b.readBigInt64LE(32)),
  stopPrice: fromFixed(b.readBigInt64LE(40)),
});

export const decodeClOrdId = (b: Buffer) => b.readBigUInt64LE(8);
export const decodeHeartbeat = (b: Buffer) => b.readBigUInt64LE(8);

/**
 * Cuts a byte stream into frames. Feed it whatever the socket delivers; it
 * calls `onFrame` once per complete message and keeps the remainder. Throws on
 * a frame whose declared length is impossible, which the caller treats as a
 * reason to hang up.
 */
export class Framer {
  private pending: Buffer | null = null;

  push(chunk: Buffer, onFrame: (frame: Buffer, type: number, seq: number) => void): void {
    let data = this.pending ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = null;
    while (data.length >= HEADER_SIZE) {
      const length = data.readUInt16LE(0);
      const type = data.readUInt8(2);
      if (length < HEADER_SIZE || length > MAX_FRAME) throw new Error(`bad frame length ${length}`);
      if (data.readUInt8(3) !== PROTOCOL_VERSION) throw new Error(`unsupported protocol version ${data.readUInt8(3)}`);
      const expected = (BodySize as Record<number, number | undefined>)[type];
      if (expected !== undefined && length < HEADER_SIZE + expected) throw new Error(`frame of type 0x${type.toString(16)} is too short`);
      if (data.length < length) break;
      onFrame(data.subarray(0, length), type, data.readUInt32LE(4));
      data = data.subarray(length);
    }
    if (data.length > 0) this.pending = Buffer.from(data);
  }
}

// --- JSON encoding -------------------------------------------------------------

/** What a program sends over the WebSocket. `id` is echoed back so replies can be matched to requests. */
export type JsonRequest =
  | { op: 'logon'; apiKey: string; id?: string | number }
  | { op: 'ping'; t?: number; id?: string | number }
  | { op: 'subscribe' | 'unsubscribe'; channels: ChannelName[]; symbols: string[]; id?: string | number }
  | { op: 'order.new'; clOrdId?: string; symbol: string; side: OrderSide; type: OrderType; tif?: TimeInForce; qty: number; price?: number; stopPrice?: number; id?: string | number }
  | { op: 'order.cancel'; orderId?: string; clOrdId?: string; id?: string | number }
  | { op: 'order.status'; orderId?: string; clOrdId?: string; id?: string | number }
  | { op: 'orders.open'; id?: string | number }
  | { op: 'account'; id?: string | number };

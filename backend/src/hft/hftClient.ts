import { EventEmitter } from 'node:events';
import net from 'node:net';

/**
 * The client side of HFT's socket: packs requests into, and unpacks answers
 * from, the fixed layouts in hft/src/hft/wire.hpp. Every number is
 * little-endian; every message is an 8-byte header (kind, size) and a payload.
 *
 * Prices are whole cents. Tags and order IDs are 64-bit, so they are BigInt.
 *
 * Orders, cancels and quotes are sent and not awaited: what became of them
 * arrives as events, in the order HFT dealt with them. hello(), depth(),
 * stats() and ping() are answered, and return promises.
 */

export const HFT_PROTOCOL_VERSION = 1;
export const HFT_MAX_LEVELS = 32;

export const HftSide = { Buy: 0, Sell: 1 } as const;
export type HftSide = (typeof HftSide)[keyof typeof HftSide];
export const HftOrderType = { Limit: 0, Market: 1, IOC: 2, FOK: 3 } as const;
export type HftOrderType = (typeof HftOrderType)[keyof typeof HftOrderType];

const Kind = {
  Hello: 1,
  Order: 2,
  Cancel: 3,
  Quote: 4,
  DepthRequest: 5,
  StatsRequest: 6,
  Ping: 7,
  Shutdown: 8,
  Welcome: 101,
  Accepted: 102,
  Rejected: 103,
  Fill: 104,
  Cancelled: 105,
  CancelRejected: 106,
  Depth: 107,
  Stats: 108,
  Pong: 109,
  Error: 110,
} as const;

const HEADER = 8;
const HELLO_FRESH = 1;

export interface HftBook {
  /** At most eight characters are kept. */
  symbol: string;
  /** Lowest price the book takes, in cents. */
  minPrice: number;
  /** Prices from minPrice up to minPrice + numLevels - 1. */
  numLevels: number;
  /** Most orders that can rest in the book at once. */
  maxOrders: number;
}

export interface HftLevel {
  price: number;
  quantity: number;
}

export interface HftWelcome {
  version: number;
  bookCount: number;
  session: number;
  /** True if HFT kept the books it already had; false if it started with empty ones. */
  resumed: boolean;
}

export interface HftAccepted {
  tag: bigint;
  orderId: bigint;
  /** Shares that traded on arrival. */
  filled: number;
  /** Shares left resting in the book. */
  resting: number;
  symbol: number;
}

export interface HftRejected {
  tag: bigint;
  symbol: number;
}

export interface HftFill {
  tag: bigint;
  orderId: bigint;
  price: number;
  quantity: number;
  /** Of the order, after this fill. */
  remaining: number;
  symbol: number;
  side: HftSide;
  /** True if the order was resting; false if it was the one arriving. */
  maker: boolean;
  /** True if the other side was the house; false if it was another client order. */
  withHouse: boolean;
}

export interface HftCancelAnswer {
  tag: bigint;
  orderId: bigint;
  symbol: number;
}

export interface HftDepth {
  symbol: number;
  bids: HftLevel[];
  asks: HftLevel[];
}

/** What HFT reports about itself; see to_json() in hft/src/hft/stats.hpp. Times are nanoseconds. */
export interface HftTiming {
  count: number;
  min_ns: number;
  mean_ns: number;
  p50_ns: number;
  p90_ns: number;
  p99_ns: number;
  p999_ns: number;
  max_ns: number;
}

export interface HftStats {
  engine: string;
  session: number;
  started: string;
  uptime_seconds: number;
  orders: number;
  cancels: number;
  quotes: number;
  quotes_refused: number;
  depth_requests: number;
  accepted: number;
  rejected: number;
  cancelled: number;
  cancel_rejected: number;
  fills: number;
  trades: number;
  trades_between_clients: number;
  shares: number;
  notional_ticks: number;
  house_orders: number;
  house_cancels: number;
  house_rejected: number;
  engine_commands: number;
  engine_events: number;
  events_dropped: number;
  recorder_waits: number;
  digest: string;
  recording: boolean;
  recording_file: string;
  commands_recorded: number;
  recording_limit: number;
  recording_stopped: boolean;
  recorded_digest: string;
  order_time: HftTiming;
  quote_time: HftTiming;
  busiest_second: number;
  resting_client_orders: number;
  resting_house_orders: number;
  symbols: Array<{ symbol: string; orders: number; quotes: number; trades: number; shares: number; last_price: number }>;
}

interface HftEvents {
  accepted: [HftAccepted];
  rejected: [HftRejected];
  fill: [HftFill];
  cancelled: [HftCancelAnswer];
  cancelRejected: [HftCancelAnswer];
  /** HFT could not understand a message (it hangs up next), or the socket failed. */
  error: [Error];
  close: [];
}

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}

/** A whole message: the header, then `size` bytes for the caller to fill. */
function message(kind: number, size: number): Buffer {
  const buffer = Buffer.alloc(HEADER + size);
  buffer.writeUInt16LE(kind, 0);
  buffer.writeUInt32LE(size, 4);
  return buffer;
}

export class HftClient extends EventEmitter<HftEvents> {
  private socket: net.Socket | null = null;
  private pending: Buffer = Buffer.alloc(0);
  // HFT answers in the order it was asked, so the answers to requests of one
  // kind come back in the order those requests were made.
  private readonly waiting = {
    welcome: [] as Array<Waiter<HftWelcome>>,
    depth: [] as Array<Waiter<HftDepth>>,
    stats: [] as Array<Waiter<HftStats>>,
    pong: [] as Array<Waiter<void>>,
  };
  private pings = 0n;

  constructor(private readonly socketPath: string) {
    super();
  }

  /** Connects to HFT's socket. Rejects if nothing is listening there. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      socket.once('connect', () => {
        socket.off('error', reject);
        socket.on('error', (error) => this.emit('error', error));
        this.socket = socket;
        resolve();
      });
      socket.once('error', reject);
      socket.on('data', (chunk) => this.onData(chunk));
      socket.on('close', () => {
        this.socket = null;
        const closed = new Error('the connection to HFT closed');
        for (const queue of Object.values(this.waiting)) {
          for (const waiter of queue.splice(0)) waiter.reject(closed);
        }
        this.emit('close');
      });
    });
  }

  get connected(): boolean {
    return this.socket !== null;
  }

  /** Bytes written to the socket that the operating system has not yet taken: how far HFT is behind. */
  get backlog(): number {
    return this.socket?.writableLength ?? 0;
  }

  /**
   * Says which books to run. A symbol's number, used everywhere else, is its
   * position in `books`. With `fresh`, HFT starts again with empty books even
   * if it is already running these ones.
   */
  hello(books: HftBook[], { fresh = false } = {}): Promise<HftWelcome> {
    const buffer = message(Kind.Hello, 16 + 24 * books.length);
    buffer.writeUInt32LE(HFT_PROTOCOL_VERSION, HEADER);
    buffer.writeUInt32LE(books.length, HEADER + 4);
    buffer.writeUInt32LE(fresh ? HELLO_FRESH : 0, HEADER + 8);
    books.forEach((book, index) => {
      const at = HEADER + 16 + 24 * index;
      buffer.write(book.symbol.slice(0, 8), at, 'latin1');
      buffer.writeBigInt64LE(BigInt(book.minPrice), at + 8);
      buffer.writeUInt32LE(book.numLevels, at + 16);
      buffer.writeUInt32LE(book.maxOrders, at + 20);
    });
    return this.ask(this.waiting.welcome, buffer);
  }

  /** Sends an order. `price` is ignored for a market order. */
  order(order: { tag: bigint; symbol: number; side: HftSide; price?: number; quantity: number; type?: HftOrderType }): void {
    const buffer = message(Kind.Order, 24);
    buffer.writeBigUInt64LE(order.tag, HEADER);
    buffer.writeBigInt64LE(BigInt(order.price ?? 0), HEADER + 8);
    buffer.writeUInt32LE(order.quantity, HEADER + 16);
    buffer.writeUInt16LE(order.symbol, HEADER + 20);
    buffer.writeUInt8(order.side, HEADER + 22);
    buffer.writeUInt8(order.type ?? HftOrderType.Limit, HEADER + 23);
    this.send(buffer);
  }

  /** Cancels a resting order by the ID its 'accepted' event gave. */
  cancel(cancel: { tag: bigint; symbol: number; orderId: bigint }): void {
    const buffer = message(Kind.Cancel, 24);
    buffer.writeBigUInt64LE(cancel.tag, HEADER);
    buffer.writeBigUInt64LE(cancel.orderId, HEADER + 8);
    buffer.writeUInt16LE(cancel.symbol, HEADER + 16);
    this.send(buffer);
  }

  /**
   * Says what the house should be bidding and offering in one symbol, best
   * price first. HFT cancels and places house orders until that is what is
   * resting. Each side must run strictly away from its best price and the best
   * bid must be below the best offer, or HFT ignores the quote.
   */
  quote(symbol: number, bids: HftLevel[], asks: HftLevel[]): void {
    if (bids.length > HFT_MAX_LEVELS || asks.length > HFT_MAX_LEVELS) throw new RangeError(`a quote carries at most ${HFT_MAX_LEVELS} levels a side`);
    const buffer = message(Kind.Quote, 8 + 16 * (bids.length + asks.length));
    buffer.writeUInt16LE(symbol, HEADER);
    buffer.writeUInt8(bids.length, HEADER + 2);
    buffer.writeUInt8(asks.length, HEADER + 3);
    let at = HEADER + 8;
    for (const level of [...bids, ...asks]) {
      buffer.writeBigInt64LE(BigInt(level.price), at);
      buffer.writeUInt32LE(level.quantity, at + 8);
      at += 16;
    }
    this.send(buffer);
  }

  /** The top of one symbol's book, best first. */
  depth(symbol: number, levels = 10): Promise<HftDepth> {
    const buffer = message(Kind.DepthRequest, 8);
    buffer.writeUInt16LE(symbol, HEADER);
    buffer.writeUInt16LE(levels, HEADER + 2);
    return this.ask(this.waiting.depth, buffer);
  }

  /** HFT's statistics for the session. */
  stats(): Promise<HftStats> {
    return this.ask(this.waiting.stats, message(Kind.StatsRequest, 0));
  }

  /** Resolves once HFT has dealt with everything sent before it. */
  ping(): Promise<void> {
    const buffer = message(Kind.Ping, 8);
    buffer.writeBigUInt64LE(++this.pings, HEADER);
    return this.ask(this.waiting.pong, buffer);
  }

  /** Asks HFT to finish its recording, write its statistics and exit. */
  shutdown(): void {
    this.send(message(Kind.Shutdown, 0));
  }

  close(): void {
    this.socket?.end();
  }

  private send(buffer: Buffer): void {
    if (this.socket === null) throw new Error('not connected to HFT');
    this.socket.write(buffer);
  }

  private ask<T>(queue: Array<Waiter<T>>, buffer: Buffer): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.socket === null) {
        reject(new Error('not connected to HFT'));
        return;
      }
      queue.push({ resolve, reject });
      this.socket.write(buffer);
    });
  }

  private onData(chunk: Buffer): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    let at = 0;
    while (this.pending.length - at >= HEADER) {
      const kind = this.pending.readUInt16LE(at);
      const size = this.pending.readUInt32LE(at + 4);
      if (this.pending.length - at < HEADER + size) break; // the rest has not arrived yet
      this.onMessage(kind, this.pending.subarray(at + HEADER, at + HEADER + size));
      at += HEADER + size;
    }
    this.pending = this.pending.subarray(at);
  }

  private onMessage(kind: number, payload: Buffer): void {
    switch (kind) {
      case Kind.Accepted:
        this.emit('accepted', {
          tag: payload.readBigUInt64LE(0),
          orderId: payload.readBigUInt64LE(8),
          filled: payload.readUInt32LE(16),
          resting: payload.readUInt32LE(20),
          symbol: payload.readUInt16LE(24),
        });
        break;
      case Kind.Rejected:
        this.emit('rejected', { tag: payload.readBigUInt64LE(0), symbol: payload.readUInt16LE(8) });
        break;
      case Kind.Fill:
        this.emit('fill', {
          tag: payload.readBigUInt64LE(0),
          orderId: payload.readBigUInt64LE(8),
          price: Number(payload.readBigInt64LE(16)),
          quantity: payload.readUInt32LE(24),
          remaining: payload.readUInt32LE(28),
          symbol: payload.readUInt16LE(32),
          side: payload.readUInt8(34) === 1 ? HftSide.Sell : HftSide.Buy,
          maker: payload.readUInt8(35) === 1,
          withHouse: payload.readUInt8(36) === 1,
        });
        break;
      case Kind.Cancelled:
      case Kind.CancelRejected:
        this.emit(kind === Kind.Cancelled ? 'cancelled' : 'cancelRejected', {
          tag: payload.readBigUInt64LE(0),
          orderId: payload.readBigUInt64LE(8),
          symbol: payload.readUInt16LE(16),
        });
        break;
      case Kind.Welcome:
        this.waiting.welcome.shift()?.resolve({
          version: payload.readUInt32LE(0),
          bookCount: payload.readUInt32LE(4),
          session: Number(payload.readBigUInt64LE(8)),
          resumed: payload.readUInt8(16) === 1,
        });
        break;
      case Kind.Depth: {
        const bidLevels = payload.readUInt8(2);
        const askLevels = payload.readUInt8(3);
        const level = (index: number): HftLevel => ({
          price: Number(payload.readBigInt64LE(8 + 16 * index)),
          quantity: Number(payload.readBigUInt64LE(16 + 16 * index)),
        });
        this.waiting.depth.shift()?.resolve({
          symbol: payload.readUInt16LE(0),
          bids: Array.from({ length: bidLevels }, (_, index) => level(index)),
          asks: Array.from({ length: askLevels }, (_, index) => level(bidLevels + index)),
        });
        break;
      }
      case Kind.Stats:
        this.waiting.stats.shift()?.resolve(JSON.parse(payload.toString('utf8')) as HftStats);
        break;
      case Kind.Pong:
        this.waiting.pong.shift()?.resolve();
        break;
      case Kind.Error:
        this.emit('error', new Error(`HFT: ${payload.toString('utf8')}`));
        break;
      default:
        break; // a kind from a newer HFT: nothing this client knows what to do with
    }
  }
}

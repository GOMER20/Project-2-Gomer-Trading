import { describe, expect, it } from 'vitest';
import {
  BodySize,
  clOrdIdNumber,
  decodeLogon,
  decodeNewOrder,
  decodeSubscribe,
  encodeBbo,
  encodeDepth,
  encodeExecReport,
  encodeReject,
  encodeTrade,
  frame,
  Framer,
  HEADER_SIZE,
  Msg,
  withSeq,
  type ExecutionReport,
} from '../src/gateway/protocol.js';
import { logonAllowed, logonFailed, takeOrderToken } from '../src/gateway/session.js';
import type { KeyIdentity } from '../src/gateway/keys.service.js';

const execution: ExecutionReport = {
  orderId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  clOrdId: '9007199254740993',
  symbol: 'AAPL',
  side: 'BUY',
  ordType: 'LIMIT',
  timeInForce: 'IOC',
  execType: 'PARTIAL_FILL',
  ordStatus: 'PARTIALLY_FILLED',
  orderQty: 1000,
  cumQty: 300,
  leavesQty: 700,
  lastQty: 300,
  lastPx: 207.24,
  avgPx: 207.2433,
  commission: 1.5,
  arrivalPx: 207.22,
  slippage: 0.0233,
  slippageBps: 1.12,
  text: null,
  transactTime: 1_791_580_000_123,
};

describe('binary frames', () => {
  it('start with an 8-byte header: length, type, version, sequence', () => {
    const b = frame(Msg.BBO, BodySize[Msg.BBO], 42);
    expect(b.length).toBe(HEADER_SIZE + 40);
    expect(b.readUInt16LE(0)).toBe(48);
    expect(b.readUInt8(2)).toBe(Msg.BBO);
    expect(b.readUInt8(3)).toBe(1);
    expect(b.readUInt32LE(4)).toBe(42);
    expect(b.subarray(HEADER_SIZE).every((byte) => byte === 0)).toBe(true);
  });

  it('carry an execution report at fixed offsets, prices in 1/10000 of a dollar', () => {
    const b = encodeExecReport(7, execution);
    expect(b.length).toBe(104);
    expect(b.readBigUInt64LE(8)).toBe(9007199254740993n); // beyond what a double holds exactly
    expect(b.subarray(16, 32).toString('hex')).toBe('0f8fad5bd9cb469fa16570867728950e');
    expect(b.toString('ascii', 32, 36)).toBe('AAPL');
    expect(b.readUInt8(36)).toBe(0); // NUL padded
    expect([b.readUInt8(40), b.readUInt8(41), b.readUInt8(42), b.readUInt8(43)]).toEqual([1, 1, 1, 2]);
    expect([b.readUInt32LE(44), b.readUInt32LE(48), b.readUInt32LE(52), b.readUInt32LE(56)]).toEqual([1000, 300, 700, 300]);
    expect(b.readBigInt64LE(64)).toBe(2_072_400n);
    expect(b.readBigInt64LE(72)).toBe(2_072_433n);
    expect(b.readBigInt64LE(80)).toBe(15_000n);
    expect(b.readBigInt64LE(88)).toBe(233n);
    expect(b.readBigUInt64LE(96)).toBe(1_791_580_000_123_000_000n);
  });

  it('send a client order id that is not a number as zero', () => {
    expect(clOrdIdNumber('my-order-7')).toBe(0n);
    expect(clOrdIdNumber(null)).toBe(0n);
    expect(clOrdIdNumber('12345')).toBe(12345n);
  });

  it('carry a quote, a trade and a book', () => {
    const bbo = encodeBbo(1, { symbol: 'MSFT', bid: 369.98, bidSize: 500, ask: 370.02, askSize: 1200, ts: 1000 });
    expect([bbo.readBigInt64LE(16), bbo.readBigInt64LE(24), bbo.readUInt32LE(32), bbo.readUInt32LE(36)]).toEqual([3_699_800n, 3_700_200n, 500, 1200]);
    const trade = encodeTrade(2, { symbol: 'MSFT', price: 370.01, size: 250, ts: 1000 });
    expect([trade.length, trade.readBigInt64LE(16), trade.readUInt32LE(24)]).toEqual([40, 3_700_100n, 250]);
    const depth = encodeDepth(3, { symbol: 'MSFT', bids: [[369.98, 500], [369.97, 800]], asks: [[370.02, 1200]], ts: 1000 });
    expect(depth.length).toBe(HEADER_SIZE + 24 + 3 * 16);
    expect(depth.readUInt16LE(0)).toBe(depth.length);
    expect([depth.readUInt8(24), depth.readUInt8(25)]).toEqual([2, 1]);
    expect([depth.readBigInt64LE(32), depth.readUInt32LE(40)]).toEqual([3_699_800n, 500]);
    expect([depth.readBigInt64LE(64), depth.readUInt32LE(72)]).toEqual([3_700_200n, 1200]);
  });

  it('carry a rejection with the sequence number of what it refuses', () => {
    const b = encodeReject(9, { refSeq: 5, refType: Msg.NEW_ORDER, code: 6, clOrdId: 77n, text: 'Insufficient buying power' });
    expect([b.readUInt32LE(8), b.readUInt8(12), b.readUInt16LE(14), b.readBigUInt64LE(16)]).toEqual([5, Msg.NEW_ORDER, 6, 77n]);
    expect(b.toString('ascii', 24, 49)).toBe('Insufficient buying power');
  });

  it('can be re-stamped with a sequence number without touching the original', () => {
    const shared = encodeBbo(0, { symbol: 'MSFT', bid: 1, bidSize: 1, ask: 2, askSize: 1, ts: 0 });
    const mine = withSeq(shared, 99);
    expect(mine.readUInt32LE(4)).toBe(99);
    expect(shared.readUInt32LE(4)).toBe(0);
  });
});

describe('decoding what a program sends', () => {
  it('reads a new order', () => {
    const b = frame(Msg.NEW_ORDER, BodySize[Msg.NEW_ORDER], 1);
    b.writeBigUInt64LE(555n, 8);
    b.write('nvda', 16, 8, 'ascii');
    b.writeUInt8(2, 24); // sell
    b.writeUInt8(2, 25); // limit
    b.writeUInt8(4, 26); // fill or kill
    b.writeUInt32LE(250, 28);
    b.writeBigInt64LE(1_375_000n, 32);
    expect(decodeNewOrder(b)).toEqual({ clOrdId: 555n, symbol: 'NVDA', side: 'SELL', type: 'LIMIT', timeInForce: 'FOK', quantity: 250, price: 137.5, stopPrice: 0 });
  });

  it('leaves an unknown side or type undefined, for the pipeline to refuse', () => {
    const b = frame(Msg.NEW_ORDER, BodySize[Msg.NEW_ORDER], 1);
    b.writeUInt8(9, 24);
    b.writeUInt8(9, 25);
    expect(decodeNewOrder(b)).toMatchObject({ side: undefined, type: undefined, timeInForce: 'GTC' });
  });

  it('reads a logon and a subscription', () => {
    const logon = frame(Msg.LOGON, BodySize[Msg.LOGON], 1);
    logon.write('gtk_0123456789_secret', 8, 64, 'ascii');
    expect(decodeLogon(logon).apiKey).toBe('gtk_0123456789_secret');
    const subscribe = frame(Msg.SUBSCRIBE, BodySize[Msg.SUBSCRIBE], 2);
    subscribe.write('aapl', 8, 8, 'ascii');
    subscribe.writeUInt8(5, 16);
    expect(decodeSubscribe(subscribe)).toEqual({ symbol: 'AAPL', channels: 5 });
  });
});

describe('Framer', () => {
  const a = encodeBbo(1, { symbol: 'A', bid: 1, bidSize: 1, ask: 2, askSize: 1, ts: 0 });
  const b = encodeTrade(2, { symbol: 'B', price: 1, size: 1, ts: 0 });
  const collect = (chunks: Buffer[]) => {
    const framer = new Framer();
    const seen: Array<[number, number, number]> = [];
    for (const chunk of chunks) framer.push(chunk, (data, type, seq) => seen.push([type, seq, data.length]));
    return seen;
  };

  it('splits a stream into messages however the bytes arrive', () => {
    const stream = Buffer.concat([a, b, a]);
    const expected = [[Msg.BBO, 1, 48], [Msg.TRADE, 2, 40], [Msg.BBO, 1, 48]];
    expect(collect([stream])).toEqual(expected);
    expect(collect([...stream].map((byte) => Buffer.from([byte])))).toEqual(expected);
    expect(collect([stream.subarray(0, 5), stream.subarray(5, 70), stream.subarray(70)])).toEqual(expected);
  });

  it('refuses a stream that has lost its framing', () => {
    const tooLong = Buffer.from(a);
    tooLong.writeUInt16LE(60_000, 0);
    expect(() => collect([tooLong])).toThrow(/bad frame length/);
    const tooShort = Buffer.from(a);
    tooShort.writeUInt16LE(4, 0);
    expect(() => collect([tooShort])).toThrow(/bad frame length/);
    const wrongVersion = Buffer.from(a);
    wrongVersion.writeUInt8(9, 3);
    expect(() => collect([wrongVersion])).toThrow(/version/);
    const truncatedOrder = frame(Msg.NEW_ORDER, 8, 1);
    expect(() => collect([truncatedOrder])).toThrow(/too short/);
  });
});

describe('order throttle', () => {
  const key = (keyId: string, ordersPerSecond: number) => ({ keyId, ordersPerSecond }) as KeyIdentity;

  it('allows a burst of one second of orders, then refuses', () => {
    const identity = key('burst', 5);
    const taken = Array.from({ length: 8 }, () => takeOrderToken(identity, 1_000_000));
    expect(taken).toEqual([true, true, true, true, true, false, false, false]);
  });

  it('refills at the key rate', () => {
    const identity = key('refill', 10);
    for (let i = 0; i < 10; i++) takeOrderToken(identity, 2_000_000);
    expect(takeOrderToken(identity, 2_000_000)).toBe(false);
    expect(takeOrderToken(identity, 2_000_100)).toBe(true); // 100 ms at 10 a second is one order
    expect(takeOrderToken(identity, 2_000_100)).toBe(false);
    expect(Array.from({ length: 12 }, () => takeOrderToken(identity, 2_005_000)).filter(Boolean)).toHaveLength(10); // never more than the burst
  });

  it('keeps each key its own budget', () => {
    for (let i = 0; i < 3; i++) takeOrderToken(key('one', 3), 3_000_000);
    expect(takeOrderToken(key('one', 3), 3_000_000)).toBe(false);
    expect(takeOrderToken(key('two', 3), 3_000_000)).toBe(true);
  });
});

describe('failed logons', () => {
  it('lock an address out after ten in a minute, and let it back in after', () => {
    const address = '203.0.113.50';
    for (let i = 0; i < 9; i++) logonFailed(address, 5_000_000);
    expect(logonAllowed(address, 5_000_000)).toBe(true);
    logonFailed(address, 5_000_000);
    expect(logonAllowed(address, 5_000_000)).toBe(false);
    expect(logonAllowed('203.0.113.51', 5_000_000)).toBe(true);
    expect(logonAllowed(address, 5_061_000)).toBe(true);
  });
});

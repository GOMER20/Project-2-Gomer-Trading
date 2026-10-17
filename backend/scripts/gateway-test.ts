/**
 * End-to-end test of the bot gateway. Drives a RUNNING stack through every
 * door a trading program can use (REST, WebSocket, binary TCP, binary Unix
 * socket), checks each does what it says, and measures how long an order takes.
 *
 *   npm run dev            # in one terminal
 *   npm run gateway:test   # in another
 *
 * It creates its own competitions and bots through the admin API and removes
 * the bots when it is done.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import WebSocket from 'ws';
import { BinaryClient, type BinaryExecution } from '../src/gateway/client.js';
import { frame, Msg } from '../src/gateway/protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  // rely on the real environment
}

const API = process.env.GATEWAY_TEST_API_URL ?? `http://localhost:${process.env.API_PORT ?? 4000}`;
const TCP_PORT = Number(process.env.GATEWAY_TCP_PORT ?? 0);
const UNIX_SOCKET = process.env.GATEWAY_UNIX_SOCKET ?? '';
const ADMIN_ID = process.env.SEED_ADMIN_ID ?? 'ADMIN';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? '';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++;
  else failed++;
  const suffix = !ok && detail !== undefined ? `\n      got: ${typeof detail === 'string' ? detail : JSON.stringify(detail, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}` : '';
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${suffix}`);
}
const section = (title: string) => console.log(`\n${title}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cents = (value: number) => Math.round(value * 100) / 100;

/* eslint-disable @typescript-eslint/no-explicit-any */
async function http(method: string, route: string, auth?: { token?: string; key?: string }, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(auth?.token ? { authorization: `Bearer ${auth.token}` } : {}),
      ...(auth?.key ? { 'x-api-key': auth.key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** A JSON gateway connection that remembers what it receives and can wait for a reply. */
class Bot {
  readonly messages: any[] = [];
  private nextId = 1;
  private readonly waiting = new Set<(message: any) => void>();
  private constructor(readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      this.messages.push(message);
      for (const waiter of this.waiting) waiter(message);
    });
  }
  /** Resolves the instant a matching message arrives (no polling), for timing. */
  next(test: (m: any) => boolean, timeoutMs = 5000): Promise<any> {
    return new Promise((resolve) => {
      const waiter = (message: any) => {
        if (!test(message)) return;
        clearTimeout(timer);
        this.waiting.delete(waiter);
        resolve(message);
      };
      const timer = setTimeout(() => {
        this.waiting.delete(waiter);
        resolve(null);
      }, timeoutMs);
      this.waiting.add(waiter);
    });
  }
  static async connect(): Promise<Bot> {
    const socket = new WebSocket(`${API.replace(/^http/, 'ws')}/gateway`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return new Bot(socket);
  }
  send(payload: object): void {
    this.socket.send(JSON.stringify(payload));
  }
  /** Sends a request and resolves with the message that answers it (same id). */
  async ask(payload: object, timeoutMs = 8000): Promise<any> {
    const id = this.nextId++;
    this.send({ ...payload, id });
    return this.waitFor((m) => m.id === id, timeoutMs);
  }
  async waitFor(test: (m: any) => boolean, timeoutMs = 8000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.messages.find(test);
      if (hit) return hit;
      if (Date.now() > deadline) return null;
      await sleep(5);
    }
  }
  async closed(timeoutMs = 4000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.socket.readyState !== WebSocket.CLOSED && Date.now() < deadline) await sleep(20);
    return this.socket.readyState === WebSocket.CLOSED;
  }
  close(): void {
    this.socket.close();
  }
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
function summary(samplesMs: number[]): string {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const fmt = (ms: number) => (ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(2)} ms`);
  return `median ${fmt(percentile(sorted, 50))}, 95th ${fmt(percentile(sorted, 95))}, 99th ${fmt(percentile(sorted, 99))}, fastest ${fmt(sorted[0]!)} (${sorted.length} samples)`;
}

async function main(): Promise<void> {
  console.log(`Gateway test against ${API}`);
  const run = crypto.randomBytes(3).toString('hex').toUpperCase();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 2 });
  await redis.connect();

  const admin: string = (await http('POST', '/api/auth/login', undefined, { traderId: ADMIN_ID, password: ADMIN_PASSWORD })).body?.token;
  if (!admin) throw new Error('Cannot sign in as the administrator. Is the stack running and seeded?');
  const window = { startDate: new Date(Date.now() - 1000).toISOString(), endDate: new Date(Date.now() + 3600_000).toISOString() };
  const newCompetition = async (name: string, extra: object = {}) => (await http('POST', '/api/competitions', { token: admin }, { name: `${name} ${run}`, ...window, ...extra })).body.competition.id as string;
  const sandboxA = await newCompetition('Gateway sandbox A');
  const sandboxB = await newCompetition('Gateway sandbox B', { startingBalance: 250_000 });
  const botIds: string[] = [];

  // ---------------------------------------------------------------------------
  section('Admitting a trading program');
  const created = await http('POST', '/api/bots', { token: admin }, { label: `Test bot ${run}`, competitionId: sandboxA, ordersPerSecond: 200 });
  const key: string = created.body?.apiKey;
  const botId: string = created.body?.bot?.id;
  botIds.push(botId);
  check('an administrator creates a bot and receives its API key once', created.status === 201 && /^gtk_[0-9a-f]{10}_[\w-]{43}$/.test(key ?? ''), created.body?.bot);
  check('the bot gets an account of its own, enrolled in the chosen sandbox', created.body.bot.isBot === true && /^BOT-/.test(created.body.bot.traderId) && created.body.bot.competitionId === sandboxA, created.body.bot);
  const listed = await http('GET', '/api/bots', { token: admin });
  check('the key is never shown again, only its public prefix', listed.status === 200 && !JSON.stringify(listed.body).includes(key.slice('gtk_'.length + 11)) && listed.body.bots.some((b: any) => b.id === botId && key.includes(b.keyPrefix)), listed.body.bots?.[0]);
  check('creating bots is for administrators only', (await http('POST', '/api/bots', { key }, { label: 'x', competitionId: sandboxA })).status === 401);

  // ---------------------------------------------------------------------------
  section('Standard gateway - REST');
  const rest = '/api/gateway/v1';
  check('a request without a key is refused', (await http('GET', `${rest}/account`)).status === 401);
  check('a request with a made-up key is refused', (await http('GET', `${rest}/account`, { key: `gtk_0123456789_${'A'.repeat(43)}` })).status === 401);
  const session = await http('GET', `${rest}/session`, { key });
  check('the key resolves to its account and sandbox', session.status === 200 && session.body.competition.id === sandboxA && session.body.limits.ordersPerSecond === 200, session.body);
  check('the session says the market is trading', session.body.market?.open === true, session.body);
  const startAccount = (await http('GET', `${rest}/account`, { key })).body.account;
  check('the sandbox is an isolated $100,000 paper account', startAccount?.cash === 100000 && startAccount.positions.length === 0, startAccount);
  const md = await http('GET', `${rest}/marketdata/AAPL`, { key });
  check('market data over REST: best bid and offer, last trade, depth', md.status === 200 && md.body.bbo.ask > md.body.bbo.bid && md.body.depth.asks.length >= 5, md.body);

  const restBuy = await http('POST', `${rest}/orders`, { key }, { clOrdId: `rest-${run}-1`, symbol: 'AAPL', side: 'BUY', type: 'MARKET', qty: 50 });
  check('NewOrderSingle: a market order fills and reports its execution', restBuy.status === 201 && restBuy.body.order.ordStatus === 'FILLED' && restBuy.body.order.cumQty === 50 && restBuy.body.order.avgPx > 0, restBuy.body);
  check('the report carries the arrival price and the slippage against it', restBuy.body.order.arrivalPx > 0 && restBuy.body.order.slippage !== null && Math.abs(restBuy.body.order.slippage - (restBuy.body.order.avgPx - restBuy.body.order.arrivalPx)) < 0.0002, restBuy.body.order);
  const byClOrdId = await http('GET', `${rest}/orders/rest-${run}-1`, { key });
  const byOrderId = await http('GET', `${rest}/orders/${restBuy.body.order.orderId}`, { key });
  check('OrderStatus by client order id and by exchange order id', byClOrdId.status === 200 && byOrderId.status === 200 && byClOrdId.body.order.orderId === byOrderId.body.order.orderId && byClOrdId.body.order.execType === 'STATUS', byClOrdId.body);
  const duplicate = await http('POST', `${rest}/orders`, { key }, { clOrdId: `rest-${run}-1`, symbol: 'AAPL', side: 'BUY', type: 'MARKET', qty: 1 });
  check('a repeated client order id is refused, so a retry cannot trade twice', duplicate.status === 409 && duplicate.body.error.code === 'DUPLICATE_CL_ORD_ID', duplicate.body);

  const far = cents(md.body.bbo.bid * 0.8);
  const resting = await http('POST', `${rest}/orders`, { key }, { clOrdId: `rest-${run}-2`, symbol: 'AAPL', side: 'BUY', type: 'LIMIT', qty: 10, price: far });
  check('a limit order away from the market rests', resting.status === 201 && resting.body.order.ordStatus === 'NEW' && resting.body.order.leavesQty === 10, resting.body);
  const working = await http('GET', `${rest}/orders`, { key });
  check('working orders can be listed', working.body.orders?.length === 1 && working.body.orders[0].clOrdId === `rest-${run}-2`, working.body);
  const cancelled = await http('DELETE', `${rest}/orders/rest-${run}-2`, { key });
  check('OrderCancelRequest cancels it', cancelled.status === 200 && cancelled.body.order.ordStatus === 'CANCELED', cancelled.body);
  check('cancelling it again is refused', (await http('DELETE', `${rest}/orders/rest-${run}-2`, { key })).status === 409);
  check('an unknown order is 404', (await http('GET', `${rest}/orders/no-such-order`, { key })).status === 404);

  const ioc = await http('POST', `${rest}/orders`, { key }, { symbol: 'AAPL', side: 'BUY', type: 'LIMIT', tif: 'IOC', qty: 10, price: far });
  check('IOC: an order that cannot trade at once is cancelled, never left resting', ioc.status === 201 && ioc.body.order.ordStatus === 'CANCELED' && ioc.body.order.cumQty === 0 && ioc.body.order.leavesQty === 0, ioc.body);
  const fok = await http('POST', `${rest}/orders`, { key }, { symbol: 'AAPL', side: 'BUY', type: 'LIMIT', tif: 'FOK', qty: 10, price: far });
  check('FOK: an order that cannot fill in full at once is refused and nothing is done', fok.status === 422 && /Fill-or-kill/.test(fok.body.error.message), fok.body);
  const fokOk = await http('POST', `${rest}/orders`, { key }, { symbol: 'AAPL', side: 'SELL', type: 'MARKET', tif: 'FOK', qty: 50 });
  check('FOK: an order that can fill in full does', fokOk.status === 201 && fokOk.body.order.ordStatus === 'FILLED' && fokOk.body.order.cumQty === 50, fokOk.body);
  check('a stop cannot be IOC', (await http('POST', `${rest}/orders`, { key }, { symbol: 'AAPL', side: 'BUY', type: 'STOP', tif: 'IOC', qty: 1, stopPrice: cents(md.body.bbo.ask * 1.2) })).status === 422);

  const tooBig = await http('POST', `${rest}/orders`, { key }, { symbol: 'AAPL', side: 'BUY', type: 'MARKET', qty: 90_000 });
  check('pre-trade risk: an order beyond buying power is refused', tooBig.status === 422 && tooBig.body.error.code === 'RISK' && /buying power/.test(tooBig.body.error.message), tooBig.body);
  const longOnly = await newCompetition('Gateway long-only', { allowShorting: false });
  const cautious = await http('POST', '/api/bots', { token: admin }, { label: `Long-only bot ${run}`, competitionId: longOnly, ordersPerSecond: 3 });
  botIds.push(cautious.body.bot.id);
  const naked = await http('POST', `${rest}/orders`, { key: cautious.body.apiKey }, { symbol: 'AAPL', side: 'SELL', type: 'MARKET', qty: 5 });
  check('pre-trade risk: selling shares it does not hold is refused where shorting is off', naked.status === 422 && /Insufficient shares/.test(naked.body.error.message), naked.body);
  check('a malformed order is 400', (await http('POST', `${rest}/orders`, { key }, { symbol: 'AAPL', side: 'BUY', type: 'LIMIT', qty: 1 })).status === 400);
  check('an unknown symbol is 404', (await http('POST', `${rest}/orders`, { key }, { symbol: 'ZZZZZZ', side: 'BUY', type: 'MARKET', qty: 1 })).status === 404);
  const burst = await Promise.all(Array.from({ length: 12 }, () => http('POST', `${rest}/orders`, { key: cautious.body.apiKey }, { symbol: 'AAPL', side: 'BUY', type: 'LIMIT', tif: 'IOC', qty: 1, price: far })));
  check('order throttle: a key sending faster than its limit gets 429', burst.filter((r) => r.status === 429 && r.body.error.code === 'THROTTLED').length >= 8 && burst.some((r) => r.status === 201), burst.map((r) => r.status));

  // ---------------------------------------------------------------------------
  section('Standard gateway - WebSocket (JSON)');
  const stranger = await Bot.connect();
  const early = await stranger.ask({ op: 'account' });
  check('nothing works before logon', early?.op === 'reject' && early.code === 'NOT_LOGGED_ON', early);
  const refused = await stranger.ask({ op: 'logon', apiKey: 'gtk_0123456789_nonsense' });
  check('a bad key is rejected and the connection closed', refused?.code === 'BAD_CREDENTIALS' && (await stranger.closed()), refused);

  const bot = await Bot.connect();
  const ack = await bot.ask({ op: 'logon', apiKey: key });
  check('logon returns the session, the account and its limits', ack?.op === 'logon.ack' && ack.competition.id === sandboxA && ack.limits.ordersPerSecond === 200 && /^BOT-/.test(ack.traderId), ack);
  const pong = await bot.ask({ op: 'ping', t: 123 });
  check('ping is answered with the server time', pong?.op === 'pong' && pong.t === 123 && Math.abs(pong.serverTime - Date.now()) < 5000, pong);

  const subscribed = await bot.ask({ op: 'subscribe', channels: ['bbo', 'trades', 'depth'], symbols: ['AAPL', 'NOSUCH'] });
  check('subscribing reports which symbols exist', subscribed?.op === 'subscribe.ack' && subscribed.symbols.includes('AAPL') && subscribed.unknown.includes('NOSUCH'), subscribed);
  const bbo = await bot.waitFor((m) => m.op === 'bbo' && m.s === 'AAPL');
  check('market data: best bid and offer', bbo?.a > bbo?.b && bbo.bs > 0 && bbo.as > 0, bbo);
  const depth = await bot.waitFor((m) => m.op === 'depth' && m.s === 'AAPL');
  check('market data: depth of book, best first', depth?.asks.length >= 5 && depth.asks[1][0] > depth.asks[0][0] && depth.bids[0][0] > depth.bids[1][0], depth);
  const print = await bot.waitFor((m) => m.op === 'trade' && m.s === 'AAPL', 20_000);
  check('market data: completed trades', print?.p > 0 && print.q >= 0, print);
  const quotesBefore = bot.messages.filter((m) => m.op === 'bbo').length;
  await sleep(1500);
  check('the feed keeps streaming', bot.messages.filter((m) => m.op === 'bbo').length > quotesBefore);

  const wsBuy = await bot.ask({ op: 'order.new', clOrdId: `ws-${run}-1`, symbol: 'AAPL', side: 'BUY', type: 'MARKET', qty: 100 });
  check('order.new is acknowledged with the exchange order id', wsBuy?.op === 'order.ack' && typeof wsBuy.orderId === 'string', wsBuy);
  const fill = await bot.waitFor((m) => m.op === 'exec' && m.clOrdId === `ws-${run}-1` && m.execType === 'FILL');
  check('execution report: the fill, with last and average price, quantities and commission', fill?.ordStatus === 'FILLED' && fill.lastQty === 100 && fill.cumQty === 100 && fill.leavesQty === 0 && fill.lastPx > 0 && fill.avgPx > 0 && fill.commission === 0, fill);
  check('execution report: slippage against the arrival price, in dollars and basis points', fill?.arrivalPx > 0 && fill.slippage >= 0 && fill.slippageBps >= 0, fill);

  const wsRest = await bot.ask({ op: 'order.new', clOrdId: `ws-${run}-2`, symbol: 'AAPL', side: 'SELL', type: 'LIMIT', qty: 100, price: cents(bbo.a * 1.2) });
  const isNew = await bot.waitFor((m) => m.op === 'exec' && m.clOrdId === `ws-${run}-2` && m.execType === 'NEW');
  check('execution report: a resting order is reported NEW', wsRest?.op === 'order.ack' && isNew?.ordStatus === 'NEW' && isNew.leavesQty === 100, isNew);
  const status = await bot.ask({ op: 'order.status', clOrdId: `ws-${run}-2` });
  check('order.status', status?.op === 'order.status' && status.ordStatus === 'NEW' && status.orderId === wsRest.orderId, status);
  const open = await bot.ask({ op: 'orders.open' });
  check('orders.open', open?.orders?.length === 1 && open.orders[0].clOrdId === `ws-${run}-2`, open);
  const cancelAck = await bot.ask({ op: 'order.cancel', clOrdId: `ws-${run}-2` });
  const wasCancelled = await bot.waitFor((m) => m.op === 'exec' && m.clOrdId === `ws-${run}-2` && m.execType === 'CANCELED');
  check('order.cancel is acknowledged and reported', cancelAck?.op === 'order.cancel.ack' && wasCancelled?.ordStatus === 'CANCELED' && wasCancelled.leavesQty === 0, wasCancelled);

  // An order far bigger than the offer, immediate-or-cancel: part trades, the rest is cancelled.
  const sweep = await bot.ask({ op: 'order.new', clOrdId: `ws-${run}-3`, symbol: 'AAPL', side: 'SELL', type: 'LIMIT', tif: 'IOC', qty: 100, price: cents(bbo.b * 0.9) });
  const sold = await bot.waitFor((m) => m.op === 'exec' && m.clOrdId === `ws-${run}-3` && (m.execType === 'FILL' || m.execType === 'PARTIAL_FILL'));
  check('an IOC order that can trade does', sweep?.op === 'order.ack' && sold?.cumQty === 100, sold);
  const accountNow = await bot.ask({ op: 'account' });
  check('account: the sandbox balance reflects the trading', accountNow?.account?.positions.length === 0 && Math.abs(accountNow.account.cash - (100000 + accountNow.account.realizedPnl)) < 0.02, accountNow?.account);

  const risky = await bot.ask({ op: 'order.new', clOrdId: `ws-${run}-4`, symbol: 'AAPL', side: 'BUY', type: 'MARKET', qty: 90_000 });
  check('a refused order comes back as a reject naming the order', risky?.op === 'reject' && risky.code === 'RISK' && risky.clOrdId === `ws-${run}-4` && risky.ref === 'order.new', risky);
  const garbage = await bot.ask({ op: 'order.new', symbol: 'AAPL', side: 'SIDEWAYS', type: 'MARKET', qty: 1 });
  check('a malformed order is rejected without closing the session', garbage?.code === 'MALFORMED' && bot.socket.readyState === WebSocket.OPEN, garbage);

  // Another account's fills must never reach this session.
  const otherBot = await Bot.connect();
  await otherBot.ask({ op: 'logon', apiKey: cautious.body.apiKey });
  await sleep(1100); // let the cautious key's throttle refill
  const before = bot.messages.filter((m) => m.op === 'exec').length;
  const theirs = await otherBot.ask({ op: 'order.new', clOrdId: `other-${run}`, symbol: 'AAPL', side: 'BUY', type: 'MARKET', qty: 10 });
  await otherBot.waitFor((m) => m.op === 'exec' && m.execType === 'FILL');
  await sleep(300);
  check("execution reports go only to the account they belong to", theirs?.op === 'order.ack' && bot.messages.filter((m) => m.op === 'exec').length === before);
  otherBot.close();

  // ---------------------------------------------------------------------------
  section('Real-time P&L hook');
  const hookBuy = await bot.ask({ op: 'order.new', clOrdId: `ws-${run}-5`, symbol: 'MSFT', side: 'BUY', type: 'MARKET', qty: 20 });
  await bot.waitFor((m) => m.op === 'exec' && m.clOrdId === `ws-${run}-5` && m.execType === 'FILL');
  await sleep(150);
  const score = await redis.zscore(`lb:${sandboxA}`, ack.traderId);
  const detail = JSON.parse((await redis.hget(`lb:${sandboxA}:names`, ack.traderId)) ?? '{}');
  const liveAccount = (await bot.ask({ op: 'account' })).account;
  // The board ranks by return on the money each started with; equity and starting money are kept beside it.
  const expected = (liveAccount.totalEquity - liveAccount.startingBalance) / liveAccount.startingBalance;
  check(
    "each fill sets the bot's leaderboard standing in Redis at once",
    hookBuy?.op === 'order.ack' && score !== null && Math.abs(Number(score) - expected) < 1e-4 && Math.abs(detail.e - liveAccount.totalEquity) < 5 && detail.s === liveAccount.startingBalance,
    { score, expected, detail, equity: liveAccount.totalEquity },
  );
  const stream = await redis.xrevrange(`fills:${sandboxA}`, '+', '-', 'COUNT', 1);
  const lastFill = Object.fromEntries((stream[0]?.[1] ?? []).reduce<string[][]>((pairs, value, i, all) => (i % 2 === 0 ? [...pairs, [value, all[i + 1]!]] : pairs), []));
  check('each fill is appended to the competition fill stream with its price', lastFill.symbol === 'MSFT' && lastFill.traderId === ack.traderId && Number(lastFill.quantity) === 20 && Number(lastFill.price) > 0, lastFill);
  const board = await http('GET', `/api/competitions/${sandboxA}/leaderboard`, { token: admin });
  check('and the platform leaderboard shows the bot', board.body.entries?.some((e: any) => e.traderId === ack.traderId), board.body.entries);

  // ---------------------------------------------------------------------------
  const lowLatency: Array<[name: string, where: { port: number } | { path: string }]> = [];
  if (TCP_PORT) lowLatency.push(['binary TCP', { port: TCP_PORT }]);
  if (UNIX_SOCKET) lowLatency.push(['binary Unix socket', { path: UNIX_SOCKET }]);
  let nextClOrdId = BigInt(Date.now()) * 1000n;
  const benchmarks: string[] = [];

  for (const [name, where] of lowLatency) {
    section(`Low-latency gateway - ${name}`);
    const intruder = await BinaryClient.connect(where);
    const noLogon = intruder.next('reject');
    intruder.newOrder({ clOrdId: 1n, symbol: 'AAPL', side: 'BUY', type: 'MARKET', qty: 1 });
    check('an order before LOGON is rejected', (await noLogon)?.reason === 'NOT_LOGGED_ON');
    check('a bad key is rejected', await intruder.logon('gtk_0123456789_nonsense').then(() => false, (err) => /BAD_CREDENTIALS/.test(err.message)));
    intruder.close();

    const client = await BinaryClient.connect(where);
    const logon = await client.logon(key);
    check('LOGON is acknowledged with the trader, sandbox and throttle', logon.traderId === ack.traderId && logon.competitionId === sandboxA && logon.ordersPerSecond === 200 && logon.startingBalance === 100000, logon);

    const beat = client.next('heartbeat');
    client.heartbeat();
    const echoed = await beat;
    check('HEARTBEAT is echoed with the server clock', echoed !== null && echoed.serverTimeNs > 1_700_000_000_000_000_000n, echoed);

    const firstBbo = client.next('bbo', (q) => q.symbol === 'AAPL');
    const firstDepth = client.next('depth', (d) => d.symbol === 'AAPL');
    const firstTrade = client.next('trade', (t) => t.symbol === 'AAPL', 20_000);
    client.subscribe('AAPL', ['bbo', 'trades', 'depth']);
    const quote = await firstBbo;
    check('market data: BBO as a fixed-size struct', quote !== null && quote.ask > quote.bid && quote.bidSize > 0, quote);
    const book = await firstDepth;
    check('market data: depth of book', book !== null && book.asks.length >= 5 && book.asks[1]![0] > book.asks[0]![0] && book.bids[0]![0] > book.bids[1]![0], book);
    check('market data: trades', ((await firstTrade)?.price ?? 0) > 0);
    const unknownSymbol = client.next('reject');
    client.subscribe('NOSUCH', ['bbo']);
    check('subscribing to an unknown symbol is rejected', (await unknownSymbol)?.reason === 'UNKNOWN_SYMBOL');

    const buyId = ++nextClOrdId;
    const bought = client.next('exec', (e) => e.clOrdId === buyId && e.execType === 'FILL');
    client.newOrder({ clOrdId: buyId, symbol: 'AAPL', side: 'BUY', type: 'MARKET', qty: 100 });
    const execution = await bought;
    check('NewOrderSingle: the execution report is the acknowledgement', execution?.ordStatus === 'FILLED' && execution.cumQty === 100 && execution.lastQty === 100 && execution.avgPx > 0 && execution.symbol === 'AAPL' && execution.side === 'BUY', execution);
    check('the report carries slippage and a nanosecond timestamp', execution !== null && execution.slippage >= 0 && execution.transactTimeNs > 1_700_000_000_000_000_000n, execution);

    const restId = ++nextClOrdId;
    const placed = client.next('exec', (e) => e.clOrdId === restId && e.execType === 'NEW');
    client.newOrder({ clOrdId: restId, symbol: 'AAPL', side: 'SELL', type: 'LIMIT', qty: 100, price: cents(quote!.ask * 1.2) });
    check('a resting order is reported NEW', (await placed)?.leavesQty === 100);
    const statusReport = client.next('exec', (e) => e.clOrdId === restId && e.execType === 'STATUS');
    client.status(restId);
    check('OrderStatusRequest', (await statusReport)?.ordStatus === 'NEW');
    const gone = client.next('exec', (e) => e.clOrdId === restId && e.execType === 'CANCELED');
    client.cancel(restId);
    check('OrderCancelRequest', (await gone)?.ordStatus === 'CANCELED');
    const lateCancel = client.next('reject', (r) => r.clOrdId === restId);
    client.cancel(restId);
    check('cancelling again is rejected', (await lateCancel)?.reason === 'TOO_LATE_TO_CANCEL');

    const sellId = ++nextClOrdId;
    const flat = client.next('exec', (e) => e.clOrdId === sellId && e.execType === 'FILL');
    client.newOrder({ clOrdId: sellId, symbol: 'AAPL', side: 'SELL', type: 'MARKET', tif: 'FOK', qty: 100 });
    check('a fill-or-kill market sell closes the position', (await flat)?.cumQty === 100);

    const riskId = ++nextClOrdId;
    const riskReject = client.next('reject', (r) => r.clOrdId === riskId);
    const riskSeq = client.newOrder({ clOrdId: riskId, symbol: 'AAPL', side: 'BUY', type: 'MARKET', qty: 90_000 });
    const risk = await riskReject;
    check('a refused order gets a REJECT naming its sequence number and client order id', risk?.reason === 'RISK' && risk.refSeq === riskSeq && risk.refType === Msg.NEW_ORDER && /buying power/i.test(risk.text), risk);

    // Latency: time from writing a NewOrderSingle to reading its execution report, one order at a time.
    const samples: number[] = [];
    const farBid = cents(quote!.bid * 0.8);
    for (let i = 0; i < 300; i++) {
      const id = ++nextClOrdId;
      const answered = client.next('exec', (e: BinaryExecution) => e.clOrdId === id);
      const sent = process.hrtime.bigint();
      // Immediate-or-cancel away from the market: the full path (risk, order written, report) with no position left behind.
      client.newOrder({ clOrdId: id, symbol: 'AAPL', side: 'BUY', type: 'LIMIT', tif: 'IOC', qty: 1, price: farBid });
      if (await answered) samples.push(Number(process.hrtime.bigint() - sent) / 1e6);
      if (i % 100 === 99) await sleep(600); // stay inside the key's 200 orders a second
    }
    check('300 orders in a row are each answered', samples.length === 300, samples.length);
    benchmarks.push(`${name.padEnd(20)} order -> execution report   ${summary(samples)}`);

    const pings: number[] = [];
    for (let i = 0; i < 300; i++) {
      const answered = client.next('heartbeat');
      const sent = process.hrtime.bigint();
      client.heartbeat();
      if (await answered) pings.push(Number(process.hrtime.bigint() - sent) / 1e6);
    }
    benchmarks.push(`${name.padEnd(20)} heartbeat round trip        ${summary(pings)}`);

    const broken = await BinaryClient.connect(where);
    let hungUp = false;
    broken.once('close', () => (hungUp = true));
    const whyNot = broken.next('reject');
    const badFrame = frame(Msg.NEW_ORDER, 40, 1);
    badFrame.writeUInt16LE(60_000, 0);
    broken.raw(badFrame);
    const reason = await whyNot;
    await sleep(300);
    check('a stream that has lost its framing is told why and hung up on', reason?.reason === 'MALFORMED' && hungUp, { reason, hungUp });
    client.close();
  }
  if (lowLatency.length === 0) console.log('\n(Low-latency gateway not configured: set GATEWAY_TCP_PORT and GATEWAY_UNIX_SOCKET to test it.)');

  // The same measurement over the standard gateways, for comparison.
  {
    const samples: number[] = [];
    await sleep(1100);
    for (let i = 0; i < 150; i++) {
      const id = `lat-${run}-${i}`;
      const answered = bot.next((m) => m.op === 'exec' && m.clOrdId === id);
      const sent = process.hrtime.bigint();
      bot.send({ op: 'order.new', clOrdId: id, symbol: 'AAPL', side: 'BUY', type: 'LIMIT', tif: 'IOC', qty: 1, price: cents(bbo.b * 0.8) });
      if (await answered) samples.push(Number(process.hrtime.bigint() - sent) / 1e6);
    }
    benchmarks.push(`${'WebSocket (JSON)'.padEnd(20)} order -> execution report   ${summary(samples)}`);
    const restSamples: number[] = [];
    await sleep(1100);
    for (let i = 0; i < 100; i++) {
      const sent = process.hrtime.bigint();
      const r = await http('POST', `${rest}/orders`, { key }, { symbol: 'AAPL', side: 'BUY', type: 'LIMIT', tif: 'IOC', qty: 1, price: cents(bbo.b * 0.8) });
      if (r.status === 201) restSamples.push(Number(process.hrtime.bigint() - sent) / 1e6);
    }
    benchmarks.push(`${'REST'.padEnd(20)} order -> response           ${summary(restSamples)}`);
  }

  // ---------------------------------------------------------------------------
  section('The administrator\'s switches');
  const moved = await http('PUT', `/api/bots/${botId}`, { token: admin }, { competitionId: sandboxB });
  check('a bot can be moved to another sandbox', moved.status === 200 && moved.body.bot.competitionId === sandboxB, moved.body);
  check('moving it drops its live connections', await bot.closed());
  const again = await Bot.connect();
  const reAck = await again.ask({ op: 'logon', apiKey: key });
  const fresh = (await again.ask({ op: 'account' }))?.account;
  check('it logs on again into the new sandbox, with that sandbox\'s own fresh balance', reAck?.competition.id === sandboxB && fresh?.cash === 250000 && fresh.positions.length === 0, { reAck, fresh });
  const disabled = await http('PUT', `/api/bots/${botId}`, { token: admin }, { enabled: false });
  check('a bot can be switched off', disabled.body.bot?.enabled === false && (await again.closed()), disabled.body);
  check('a switched-off key is refused everywhere', (await http('GET', `${rest}/account`, { key })).status === 401);
  await http('PUT', `/api/bots/${botId}`, { token: admin }, { enabled: true });
  const rotated = await http('POST', `/api/bots/${botId}/rotate`, { token: admin });
  check('rotating a key replaces it: the old one stops, the new one works', rotated.status === 200 && (await http('GET', `${rest}/account`, { key })).status === 401 && (await http('GET', `${rest}/account`, { key: rotated.body.apiKey })).status === 200);
  const live = (await http('GET', '/api/bots', { token: admin })).body;
  check('the admin list shows where programs can connect', live.endpoints.websocket === '/gateway' && live.endpoints.rest === '/api/gateway/v1', live.endpoints);

  for (const id of botIds) await http('DELETE', `/api/bots/${id}`, { token: admin });
  check('deleting a bot removes its key', (await http('GET', `${rest}/account`, { key: rotated.body.apiKey })).status === 401);

  redis.disconnect();
  console.log('\nLatency (this machine, one order at a time)');
  for (const line of benchmarks) console.log(`  ${line}`);
  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nGateway test aborted: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
  process.exit(1);
});

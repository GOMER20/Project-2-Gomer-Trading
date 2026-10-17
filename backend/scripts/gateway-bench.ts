/**
 * Latency and throughput benchmark for the bot gateway, against a RUNNING stack.
 *
 *   npm run dev             # in one terminal
 *   npm run gateway:bench   # in another
 *
 * It measures what a trading program experiences: the time from writing an
 * order to reading the execution report for it, one order at a time, after a
 * warm-up, over each transport. Then it sends a burst as fast as the socket
 * will take it, to show how many orders a second the exchange gets through.
 *
 * The orders are immediate-or-cancel limit orders away from the market, so
 * each one takes the full path (risk check, order recorded, report sent)
 * without leaving a position behind, plus a run of market orders that really
 * trade.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { BinaryClient } from '../src/gateway/client.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  // rely on the real environment
}

const API = process.env.GATEWAY_TEST_API_URL ?? `http://localhost:${process.env.API_PORT ?? 4000}`;
const TCP_PORT = Number(process.env.GATEWAY_TCP_PORT ?? 0);
const UNIX_SOCKET = process.env.GATEWAY_UNIX_SOCKET ?? '';
const WARM_UP = Number(process.env.BENCH_WARM_UP ?? 3000);
const SAMPLES = Number(process.env.BENCH_SAMPLES ?? 5000);
// No more than the key's one-second allowance, so every order in the burst is taken rather than throttled.
const BURST = Number(process.env.BENCH_BURST ?? 5000);

/* eslint-disable @typescript-eslint/no-explicit-any */
async function http(method: string, route: string, auth?: { token?: string; key?: string }, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(auth?.token ? { authorization: `Bearer ${auth.token}` } : {}), ...(auth?.key ? { 'x-api-key': auth.key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const micros = (ns: bigint) => Number(ns) / 1000;
function line(name: string, samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
  const fmt = (us: number) => (us < 1000 ? `${us.toFixed(0)} µs`.padStart(8) : `${(us / 1000).toFixed(2)} ms`.padStart(8));
  const under = ((sorted.filter((us) => us < 1000).length / sorted.length) * 100).toFixed(2);
  return `  ${name.padEnd(38)} median ${fmt(at(50))}   95th ${fmt(at(95))}   99th ${fmt(at(99))}   99.9th ${fmt(at(99.9))}   under 1 ms: ${under}%`;
}

let stage = 'starting';
process.on('beforeExit', () => console.error(`Benchmark stopped with nothing left to wait for, during: ${stage}`));

async function main(): Promise<void> {
  console.log(`Gateway benchmark against ${API}  (${WARM_UP} warm-up, ${SAMPLES} measured, ${BURST} in the burst)`);
  const admin: string = (await http('POST', '/api/auth/login', undefined, { traderId: process.env.SEED_ADMIN_ID ?? 'ADMIN', password: process.env.SEED_ADMIN_PASSWORD ?? '' })).body?.token;
  if (!admin) throw new Error('Cannot sign in as the administrator. Is the stack running and seeded?');
  const run = crypto.randomBytes(3).toString('hex').toUpperCase();
  const competition = (await http('POST', '/api/competitions', { token: admin }, { name: `Gateway bench ${run}`, startDate: new Date(Date.now() - 1000).toISOString(), endDate: new Date(Date.now() + 3600_000).toISOString(), startingBalance: 10_000_000 })).body.competition;
  const bot = (await http('POST', '/api/bots', { token: admin }, { label: `Bench ${run}`, competitionId: competition.id, ordersPerSecond: 5000 })).body;
  const key: string = bot.apiKey;
  const quote = (await http('GET', '/api/gateway/v1/marketdata/AAPL', { key })).body.bbo;
  const away = Math.round(quote.bid * 0.8 * 100) / 100;
  let nextId = BigInt(Date.now()) * 1000n;
  const results: string[] = [];

  const transports: Array<[string, { port: number } | { path: string }]> = [];
  if (UNIX_SOCKET) transports.push(['binary, Unix socket', { path: UNIX_SOCKET }]);
  if (TCP_PORT) transports.push(['binary, TCP', { port: TCP_PORT }]);

  for (const [name, where] of transports) {
    const client = await BinaryClient.connect(where);
    await client.logon(key);
    // One order in flight at a time; the reply is matched by its client order id.
    let waiting: { id: bigint; resolve: () => void } | null = null;
    client.on('exec', (report) => {
      if (waiting && report.clOrdId === waiting.id) waiting.resolve();
    });
    // A refusal or a dropped connection would otherwise leave the benchmark waiting for a report that never comes.
    client.on('reject', (refusal) => {
      console.error(`Benchmark aborted during ${stage}: the exchange refused an order (${refusal.reason}: ${refusal.text})`);
      process.exit(1);
    });
    client.on('close', () => {
      if (finished) return;
      console.error(`Benchmark aborted during ${stage}: the connection was closed by the exchange`);
      process.exit(1);
    });
    let finished = false;
    const roundTrip = async (order: (id: bigint) => void): Promise<number> => {
      const id = ++nextId;
      const answered = new Promise<void>((resolve) => (waiting = { id, resolve }));
      const sent = process.hrtime.bigint();
      order(id);
      await answered;
      return micros(process.hrtime.bigint() - sent);
    };
    const ioc = (id: bigint) => client.newOrder({ clOrdId: id, symbol: 'AAPL', side: 'BUY', type: 'LIMIT', tif: 'IOC', qty: 1, price: away });
    let side: 'BUY' | 'SELL' = 'BUY';
    const trade = (id: bigint) => {
      client.newOrder({ clOrdId: id, symbol: 'AAPL', side, type: 'MARKET', tif: 'IOC', qty: 1 });
      side = side === 'BUY' ? 'SELL' : 'BUY';
    };

    stage = `${name}: warm-up`;
    for (let i = 0; i < WARM_UP; i++) await roundTrip(i % 2 ? ioc : trade);
    stage = `${name}: orders that do not fill`;
    const quiet: number[] = [];
    for (let i = 0; i < SAMPLES; i++) quiet.push(await roundTrip(ioc));
    stage = `${name}: orders that fill`;
    results.push(line(`${name}: order, no fill`, quiet));
    const filled: number[] = [];
    for (let i = 0; i < SAMPLES; i++) filled.push(await roundTrip(trade));
    results.push(line(`${name}: market order that fills`, filled));

    stage = `${name}: heartbeats`;
    const beats: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const answered = client.next('heartbeat');
      const sent = process.hrtime.bigint();
      client.heartbeat();
      await answered;
      beats.push(micros(process.hrtime.bigint() - sent));
    }
    results.push(line(`${name}: heartbeat (the wire alone)`, beats));

    stage = `${name}: burst`;
    // Throughput: everything written at once, timed until the last report is back.
    let outstanding = BURST;
    const drained = new Promise<void>((resolve) => {
      const count = () => {
        if (--outstanding === 0) {
          client.off('exec', count);
          client.off('reject', count);
          resolve();
        }
      };
      client.on('exec', count);
      client.on('reject', count); // an order over the throttle still counts as answered
    });
    client.removeAllListeners('reject');
    await new Promise((resolve) => setTimeout(resolve, 1200)); // let the order throttle refill
    const started = process.hrtime.bigint();
    for (let i = 0; i < BURST; i++) ioc(++nextId);
    await drained;
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    finished = true;
    results.push(`  ${`${name}: burst of ${BURST}`.padEnd(38)} answered in ${(seconds * 1000).toFixed(0)} ms: ${Math.round(BURST / seconds).toLocaleString('en-US')} orders a second`);
    client.close();
  }

  {
    stage = 'WebSocket';
    const socket = new WebSocket(`${API.replace(/^http/, 'ws')}/gateway`);
    await new Promise<void>((resolve) => socket.once('open', () => resolve()));
    let finished = false;
    socket.on('close', (code, reason) => {
      if (finished) return;
      console.error(`Benchmark aborted during ${stage}: the exchange closed the WebSocket (${code} ${reason.toString()})`);
      process.exit(1);
    });
    let waiting: { id: string; resolve: () => void } | null = null;
    const ready = new Promise<void>((resolve) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.op === 'logon.ack') resolve();
        if (message.op === 'exec' && waiting && message.clOrdId === waiting.id) waiting.resolve();
        if (message.op === 'reject') {
          console.error(`Benchmark aborted during ${stage}: the exchange refused a message (${message.code}: ${message.text})`);
          process.exit(1);
        }
      });
    });
    socket.send(JSON.stringify({ op: 'logon', apiKey: key }));
    await ready;
    const roundTrip = async (): Promise<number> => {
      const id = `b${++nextId}`;
      const answered = new Promise<void>((resolve) => (waiting = { id, resolve }));
      const sent = process.hrtime.bigint();
      socket.send(JSON.stringify({ op: 'order.new', clOrdId: id, symbol: 'AAPL', side: 'BUY', type: 'LIMIT', tif: 'IOC', qty: 1, price: away }));
      await answered;
      return micros(process.hrtime.bigint() - sent);
    };
    for (let i = 0; i < WARM_UP; i++) await roundTrip();
    const samples: number[] = [];
    for (let i = 0; i < SAMPLES; i++) samples.push(await roundTrip());
    results.push(line('WebSocket, JSON: order, no fill', samples));
    finished = true;
    socket.close();
  }

  const health = (await http('GET', '/health')).body;
  await http('DELETE', `/api/bots/${bot.bot.id}`, { token: admin });

  console.log('\nOrder sent to execution report received, one at a time, as the client sees it:');
  for (const result of results) console.log(result);
  console.log(`\nInside the exchange (decoded order to report handed to the socket), last ${Math.min(4096, health.gatewayOrders.orders)} orders:`);
  console.log(`  median ${health.gatewayOrders.medianMicros} µs, 95th ${health.gatewayOrders.p95Micros} µs, 99th ${health.gatewayOrders.p99Micros} µs`);
  console.log(`\nDatabase writer afterwards: ${health.engine.unwritten} steps unwritten, ${health.engine.writeLagMs} ms behind`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nBenchmark aborted: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
  process.exit(1);
});

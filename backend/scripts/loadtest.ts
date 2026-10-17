/**
 * Load test. Simulates a crowd of traders using a RUNNING stack the way the
 * terminal does, and reports whether it stayed up and how it coped.
 *
 *   npm run loadtest                       300 traders for 30 seconds
 *   TRADERS=600 SECONDS=60 npm run loadtest
 *
 * Each simulated trader logs in, opens the WebSocket, subscribes to a
 * watchlist, then keeps polling their portfolio and the leaderboard and
 * placing orders. The run fails if the server stops answering, returns
 * server errors, drops connections, or lets an account's cash go wrong.
 *
 * It creates its own traders and competition through the admin API.
 *
 * The crowd is spread over several processes (about 100 traders each). One
 * extra trader, the "observer", has a process to themselves and simply places
 * an order and reads their portfolio once a second: their timings are what one
 * person at a terminal actually experiences while the crowd is there.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  // rely on the real environment
}

const API = process.env.LOADTEST_API_URL ?? `http://localhost:${process.env.API_PORT ?? 4000}`;
const WS_URL = `${API.replace(/^http/, 'ws')}/ws`;
const TRADERS = Number(process.env.TRADERS ?? 300);
const SECONDS = Number(process.env.SECONDS ?? 30);
/** Average seconds between one trader's orders. */
const ORDER_EVERY = Number(process.env.ORDER_EVERY ?? 3);
const SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'META', 'AMD', 'SPY', 'QQQ'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(items: T[]) => items[Math.floor(Math.random() * items.length)]!;

interface Observation {
  orders: number;
  failed: number;
  median: number;
  p95: number;
  slowest: number;
}

/** Runs in its own process: one ordinary trader, one order and one portfolio read per second. */
async function observe(traderId: string, password: string, competitionId: string, seconds: number): Promise<void> {
  const call = async (method: string, route: string, token?: string, body?: unknown) => {
    const started = performance.now();
    const response = await fetch(`${API}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    const parsed: any = response ? await response.json().catch(() => null) : null;
    return { ok: Boolean(response?.ok), ms: performance.now() - started, body: parsed };
  };
  // Sign in before the crowd arrives; like anyone else, retry if told the server is busy.
  let token = '';
  for (let attempt = 0; attempt < 30 && !token; attempt++) {
    token = (await call('POST', '/api/auth/login', undefined, { traderId, password })).body?.token ?? '';
    if (!token) await sleep(1500);
  }
  const samples: Array<{ ok: boolean; ms: number }> = [];
  const until = Date.now() + seconds * 1000;
  for (let i = 0; Date.now() < until; i++) {
    samples.push(await call('POST', '/api/orders', token, { competitionId, ticker: 'KO', side: i % 2 ? 'SELL' : 'BUY', type: 'MARKET', quantity: 1 }));
    samples.push(await call('GET', `/api/portfolios/${competitionId}`, token));
    await sleep(1000);
  }
  const times = samples.map((sample) => sample.ms).sort((x, y) => x - y);
  const result: Observation = {
    orders: samples.length,
    failed: samples.filter((sample) => !sample.ok).length,
    median: times[Math.floor(times.length / 2)] ?? 0,
    p95: times[Math.floor(times.length * 0.95)] ?? 0,
    slowest: times[times.length - 1] ?? 0,
  };
  console.log(JSON.stringify(result));
}

interface CrowdReport {
  stats: Omit<typeof stats, 'byStatus'> & { byStatus: Array<[number, number]> };
  signedIn: number;
  tokens: string[];
}

/** Runs in its own process: a share of the crowd. One Node process can only play so many traders honestly. */
async function crowd(ids: string[], password: string, competitionId: string, until: number, rampMs: number): Promise<void> {
  const sessions = await Promise.all(ids.map((traderId, i) => sleep((i / ids.length) * rampMs).then(() => trader(traderId, password, competitionId, until))));
  const signedIn = sessions.filter((session): session is { token: string } => session !== null);
  const report: CrowdReport = { stats: { ...stats, byStatus: [...stats.byStatus] }, signedIn: signedIn.length, tokens: signedIn.slice(0, 6).map((session) => session.token) };
  await new Promise<void>((resolve) => process.stdout.write(`${JSON.stringify(report)}\n`, () => resolve()));
}

function startCrowd(ids: string[], password: string, competitionId: string, until: number, rampMs: number): Promise<CrowdReport | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--crowd'], { stdio: ['pipe', 'pipe', 'inherit'] });
    child.stdin.end(JSON.stringify({ ids, password, competitionId, until, rampMs }));
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.on('exit', () => {
      try {
        resolve(JSON.parse(output.trim().split('\n').pop() ?? ''));
      } catch {
        resolve(null);
      }
    });
  });
}

function startObserver(traderId: string, password: string, competitionId: string, seconds: number): Promise<Observation | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--observe', traderId, password, competitionId, String(seconds)], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.on('exit', () => {
      try {
        resolve(JSON.parse(output.trim().split('\n').pop() ?? ''));
      } catch {
        resolve(null);
      }
    });
  });
}

const stats = {
  requests: 0,
  byStatus: new Map<number, number>(),
  latencies: [] as number[],
  /** Response times by kind of request, successful answers only. */
  byKind: { 'sign in': [] as number[], 'place order': [] as number[], 'portfolio / leaderboard': [] as number[] },
  ordersFilled: 0,
  ordersResting: 0,
  ordersRejected: 0,
  quotes: 0,
  socketsOpened: 0,
  socketsDropped: 0,
  networkErrors: 0,
  loginRetries: 0,
};

/* eslint-disable @typescript-eslint/no-explicit-any */
async function api(method: string, route: string, token?: string, body?: unknown, timeoutMs = 20_000): Promise<{ status: number; body: any }> {
  const started = performance.now();
  try {
    const response = await fetch(`${API}${route}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const parsed = await response.json().catch(() => null);
    stats.requests++;
    stats.latencies.push(performance.now() - started);
    if (response.ok) {
      const kind = route.startsWith('/api/auth') ? 'sign in' : route === '/api/orders' ? 'place order' : route.startsWith('/api/portfolios') || route.endsWith('/leaderboard') ? 'portfolio / leaderboard' : null;
      if (kind) stats.byKind[kind].push(performance.now() - started);
    }
    stats.byStatus.set(response.status, (stats.byStatus.get(response.status) ?? 0) + 1);
    return { status: response.status, body: parsed };
  } catch {
    stats.networkErrors++;
    return { status: 0, body: null };
  }
}

/** Runs tasks with at most `limit` in flight. */
async function inBatches<T>(items: T[], limit: number, task: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        await task(items[index]!, index);
      }
    }),
  );
}

async function trader(traderId: string, password: string, competitionId: string, until: number): Promise<{ token: string } | null> {
  // A person who is told the server is busy waits a moment and tries again.
  let token: string | undefined;
  for (let attempt = 0; attempt < 25 && !token; attempt++) {
    if (attempt > 0) {
      stats.loginRetries++;
      await sleep(1000 + Math.random() * 2500);
    }
    token = (await api('POST', '/api/auth/login', undefined, { traderId, password }, 45_000)).body?.token;
  }
  if (!token) return null;

  const socket = new WebSocket(WS_URL);
  let closing = false;
  socket.on('open', () => {
    stats.socketsOpened++;
    socket.send(JSON.stringify({ type: 'auth', token }));
  });
  socket.on('message', (raw) => {
    // Quotes are counted without being parsed: this one process stands in for hundreds of browsers.
    const text = raw.toString();
    if (text.startsWith('{"type":"quote')) stats.quotes++;
    else if (text.startsWith('{"type":"ready"')) {
      socket.send(JSON.stringify({ type: 'subscribe', symbols: SYMBOLS }));
      socket.send(JSON.stringify({ type: 'leaderboard', competitionId }));
    }
  });
  socket.on('close', () => {
    if (!closing) stats.socketsDropped++;
  });
  socket.on('error', () => undefined);

  let lastPoll = 0;
  while (Date.now() < until) {
    await sleep(ORDER_EVERY * 1000 * (0.4 + Math.random() * 1.2));
    if (Date.now() >= until) break;

    // Mostly market orders either way, some resting limits far from the market.
    const resting = Math.random() < 0.15;
    const order = await api('POST', '/api/orders', token, {
      competitionId,
      ticker: pick(SYMBOLS),
      side: Math.random() < 0.5 ? 'BUY' : 'SELL',
      quantity: 1 + Math.floor(Math.random() * 20),
      ...(resting ? { type: 'LIMIT', limitPrice: 1 } : { type: 'MARKET' }),
    });
    if (order.status === 201) order.body.order.status === 'FILLED' ? stats.ordersFilled++ : stats.ordersResting++;
    else if (order.status === 422) stats.ordersRejected++;

    if (Date.now() - lastPoll > 5000) {
      lastPoll = Date.now();
      void api('GET', `/api/portfolios/${competitionId}`, token);
      void api('GET', `/api/competitions/${competitionId}/leaderboard`, token);
    }
  }
  closing = true;
  socket.close();
  return { token };
}

/**
 * Removes everything this run created. Thousands of leftover portfolios in a
 * still-running competition would keep the leaderboard worker busy and skew
 * the next run. Needs direct database access, so it is skipped (with a note)
 * when DATABASE_URL does not point at the server under test.
 */
async function cleanUp(run: string, competitionId: string): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query('DELETE FROM competitions WHERE id = $1', [competitionId]);
    const removed = await client.query('DELETE FROM users WHERE trader_id LIKE $1', [`LOAD\\_${run}\\_%`]);
    console.log(`  cleaned up             ${removed.rowCount} test traders and their competition removed`);
  } catch (err) {
    console.log(`  cleaned up             no (${(err as Error).message}); remove "Load test ${run}" by hand`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function percentile(sorted: number[], p: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0;
}

async function main(): Promise<void> {
  console.log(`Load test: ${TRADERS} traders for ${SECONDS}s against ${API}`);
  const before = await api('GET', '/health');
  if (before.status !== 200) throw new Error('The server is not healthy before the test. Start it with `npm run dev`.');

  const admin: string | undefined = (await api('POST', '/api/auth/login', undefined, { traderId: process.env.SEED_ADMIN_ID ?? 'ADMIN', password: process.env.SEED_ADMIN_PASSWORD ?? '' })).body?.token;
  if (!admin) throw new Error('Admin login failed. Is the database seeded?');

  const run = crypto.randomBytes(3).toString('hex').toUpperCase();
  const password = crypto.randomBytes(12).toString('base64url');
  const ids = Array.from({ length: TRADERS }, (_, i) => `LOAD_${run}_${String(i + 1).padStart(4, '0')}`);
  const observerId = `LOAD_${run}_WATCH`;

  let created = 0;
  await inBatches(ids, 16, async (traderId) => {
    if ((await api('POST', '/api/users', admin, { traderId, password })).status === 201) created++;
  });
  await api('POST', '/api/users', admin, { traderId: observerId, password });
  const competition = await api('POST', '/api/competitions', admin, {
    name: `Load test ${run}`,
    startDate: new Date(Date.now() - 1000).toISOString(),
    endDate: new Date(Date.now() + (SECONDS + 600) * 1000).toISOString(),
    traderIds: [observerId],
  });
  const competitionId: string | undefined = competition.body?.competition?.id;
  if (!competitionId) throw new Error(`Could not create the competition: ${JSON.stringify(competition.body)}`);
  let enrolled = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const batch = await api('POST', `/api/competitions/${competitionId}/participants`, admin, { traderIds: ids.slice(i, i + 500) });
    enrolled += batch.body?.enrollment?.enrolled.length ?? 0;
  }
  console.log(`  created ${created} traders and enrolled ${enrolled}`);

  // Setup traffic is not what is being measured.
  stats.requests = 0;
  stats.latencies = [];
  stats.byStatus.clear();
  for (const list of Object.values(stats.byKind)) list.length = 0;

  // Watch the server from the outside for the whole run.
  const health: Array<{ ok: boolean; lag: number }> = [];
  /** The server's own ten-second summaries of how long it took to answer. */
  const serverSide: Array<{ requests: number; median: number; p95: number; slowest: number }> = [];
  const until = Date.now() + SECONDS * 1000;
  const watcher = (async () => {
    while (Date.now() < until + 2000) {
      const response: any = await fetch(`${API}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => null);
      health.push({ ok: response?.status === 'ok', lag: response?.eventLoopLagMs ?? -1 });
      if (response?.responseTimeMs?.trading?.requests) serverSide.push(response.responseTimeMs.trading);
      await sleep(1000);
    }
  })();

  const observer = startObserver(observerId, password, competitionId, SECONDS);
  await sleep(2500); // the observer is an ordinary trader who was already signed in
  const started = Date.now();
  // About 100 traders per process, so the crowd is not held back by the tool simulating it.
  const processes = Math.min(os.availableParallelism(), Math.max(1, Math.ceil(TRADERS / 100)));
  const groups = Array.from({ length: processes }, (_, g) => ids.filter((_, i) => i % processes === g));
  const reports = await Promise.all(groups.map((group) => startCrowd(group, password, competitionId, until, 3000)));
  await watcher;
  const elapsed = (Date.now() - started) / 1000;
  const seen = await observer;

  // Fold every crowd process's numbers into one set.
  const sampleTokens: string[] = [];
  let loggedIn = 0;
  let lostProcesses = 0;
  for (const report of reports) {
    if (!report) {
      lostProcesses++;
      continue;
    }
    loggedIn += report.signedIn;
    sampleTokens.push(...report.tokens);
    for (const key of ['requests', 'ordersFilled', 'ordersResting', 'ordersRejected', 'quotes', 'socketsOpened', 'socketsDropped', 'networkErrors', 'loginRetries'] as const) stats[key] += report.stats[key];
    for (const [code, count] of report.stats.byStatus) stats.byStatus.set(code, (stats.byStatus.get(code) ?? 0) + count);
    for (const kind of Object.keys(stats.byKind) as Array<keyof typeof stats.byKind>) stats.byKind[kind].push(...report.stats.byKind[kind]);
  }

  // Did the books stay right under pressure? Recompute a sample of accounts from their own fills.
  const sample = sampleTokens.slice(0, 25);
  let reconciled = 0;
  await sleep(2000); // let the last fills land
  for (const token of sample) {
    let portfolio = await api('GET', `/api/portfolios/${competitionId}`, token);
    let history = await api('GET', `/api/portfolios/${competitionId}/orders?limit=500`, token);
    for (let attempt = 0; attempt < 5 && (portfolio.status !== 200 || history.status !== 200); attempt++) {
      await sleep(1000); // "busy" is not "wrong": ask again
      portfolio = await api('GET', `/api/portfolios/${competitionId}`, token);
      history = await api('GET', `/api/portfolios/${competitionId}/orders?limit=500`, token);
    }
    const expected = (history.body?.orders ?? [])
      .filter((o: any) => o.status === 'FILLED')
      .reduce((cash: number, o: any) => cash + (o.side === 'SELL' ? 1 : -1) * o.quantity * o.fillPrice, 100000);
    if (portfolio.body?.portfolio && Math.abs(portfolio.body.portfolio.cash - expected) < 0.02) reconciled++;
  }
  const after = await api('GET', '/health');
  await cleanUp(run, competitionId);

  const status = (from: number, to: number) => [...stats.byStatus].filter(([code]) => code >= from && code <= to).reduce((sum, [, n]) => sum + n, 0);
  const serverErrors = status(500, 502) + status(504, 599);
  const shed = stats.byStatus.get(503) ?? 0;
  const limited = stats.byStatus.get(429) ?? 0;
  const worstLag = Math.max(...health.map((h) => h.lag));
  const downSeconds = health.filter((h) => !h.ok).length;

  console.log(`
  traders signed in      ${loggedIn} / ${TRADERS} (${stats.loginRetries} retried after a "busy" answer)
  requests               ${stats.requests} in ${elapsed.toFixed(0)}s (${(stats.requests / elapsed).toFixed(0)}/s)
${Object.entries(stats.byKind)
  .map(([kind, list]) => {
    const ordered = [...list].sort((x, y) => x - y);
    return `  crowd: ${kind.padEnd(15)} median ${percentile(ordered, 50).toFixed(0)} ms, 95th ${percentile(ordered, 95).toFixed(0)} ms, slowest ${(ordered[ordered.length - 1] ?? 0).toFixed(0)} ms (${list.length})`;
  })
  .join('\n')}
  server's own timing    ${serverSide.length ? `trading requests: median ${Math.max(...serverSide.map((w) => w.median))} ms, 95th ${Math.max(...serverSide.map((w) => w.p95))} ms, slowest ${Math.max(...serverSide.map((w) => w.slowest))} ms (worst ten-second window)` : 'not reported'}
  what one trader saw    ${seen ? `${seen.orders} requests, ${seen.failed} failed, median ${seen.median.toFixed(0)} ms, 95th ${seen.p95.toFixed(0)} ms, slowest ${seen.slowest.toFixed(0)} ms` : 'observer did not report'}
  orders                 ${stats.ordersFilled} filled, ${stats.ordersResting} resting, ${stats.ordersRejected} refused by risk rules
  price updates          ${stats.quotes} frames delivered (${(stats.quotes / elapsed).toFixed(0)}/s)
  WebSocket connections  ${stats.socketsOpened} opened, ${stats.socketsDropped} dropped
  server errors (5xx)    ${serverErrors}
  turned away as busy    ${shed} (503), rate limited ${limited} (429)
  failed to connect      ${stats.networkErrors}
  health checks          ${health.length - downSeconds} ok of ${health.length}, worst event-loop delay ${worstLag} ms
  accounts reconciled    ${reconciled} / ${sample.length}
  healthy afterwards     ${after.status === 200 && after.body?.status === 'ok'}`);

  const problems: string[] = [];
  if (after.status !== 200) problems.push('the server is not healthy after the test');
  if (downSeconds > 0) problems.push(`health check failed ${downSeconds} time(s) during the run`);
  if (serverErrors > 0) problems.push(`${serverErrors} server errors`);
  if (stats.networkErrors > 0) problems.push(`${stats.networkErrors} requests could not connect`);
  if (stats.socketsDropped > 0) problems.push(`${stats.socketsDropped} WebSocket connections were dropped`);
  if (lostProcesses > 0) problems.push(`${lostProcesses} crowd process(es) did not report`);
  if (loggedIn < TRADERS) problems.push(`${TRADERS - loggedIn} traders could not sign in`);
  if (!seen) problems.push('the observer could not trade');
  else {
    if (seen.failed > 0) problems.push(`the observer had ${seen.failed} failed requests`);
    if (seen.median > 250) problems.push(`trading was slow for the observer (median ${seen.median.toFixed(0)} ms)`);
  }
  if (reconciled < sample.length) problems.push(`${sample.length - reconciled} sampled accounts do not reconcile`);

  console.log(problems.length ? `\n\x1b[31mFAILED:\x1b[0m ${problems.join('; ')}` : '\n\x1b[32mPASSED: the server stayed up, answered everything, and every sampled account is correct.\x1b[0m');
  process.exit(problems.length ? 1 : 0);
}

if (process.argv[2] === '--crowd') {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { ids, password, competitionId, until, rampMs } = JSON.parse(input);
  await crowd(ids, password, competitionId, until, rampMs);
  process.exit(0);
}

if (process.argv[2] === '--observe') {
  const [, , , traderId, password, competitionId, seconds] = process.argv;
  await observe(traderId!, password!, competitionId!, Number(seconds));
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nLoad test aborted: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

/**
 * End-to-end smoke test. Drives a RUNNING stack (API + worker) over HTTP and
 * WebSocket exactly as the frontend does, and checks the money adds up.
 *
 *   npm run dev      # in one terminal
 *   npm run smoke    # in another
 *
 * It creates its own throwaway traders and competitions through the admin API,
 * so it never touches the demo accounts.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  // rely on the real environment
}

const API = process.env.SMOKE_API_URL ?? `http://localhost:${process.env.API_PORT ?? 4000}`;
const WS_URL = `${API.replace(/^http/, 'ws')}/ws`;
const ADMIN_ID = process.env.SEED_ADMIN_ID ?? 'ADMIN';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? '';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++;
  else failed++;
  const suffix = !ok && detail !== undefined ? `\n      got: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '';
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${suffix}`);
}
const section = (title: string) => console.log(`\n${title}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const near = (a: number, b: number, tolerance = 0.005) => Math.abs(a - b) <= tolerance;

/* eslint-disable @typescript-eslint/no-explicit-any */
async function api(method: string, route: string, token?: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** Minimal WebSocket client that remembers everything it receives. */
class Feed {
  readonly messages: any[] = [];
  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      // Streaming quotes arrive batched; unpack them so every quote can be looked up the same way.
      if (message.type === 'quotes') for (const data of message.data) this.messages.push({ type: 'quote', data });
      else this.messages.push(message);
    });
  }

  static async connect(token: string): Promise<Feed> {
    const socket = new WebSocket(WS_URL);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const feed = new Feed(socket);
    feed.send({ type: 'auth', token });
    await feed.waitFor((m) => m.type === 'ready');
    return feed;
  }

  send(payload: object): void {
    this.socket.send(JSON.stringify(payload));
  }

  async waitFor(predicate: (message: any) => boolean, timeoutMs = 8_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.messages.find(predicate);
      if (hit) return hit;
      if (Date.now() > deadline) return null;
      await sleep(25);
    }
  }

  latestQuote(symbol: string): any {
    return this.messages.findLast((m) => m.type === 'quote' && m.data.symbol === symbol)?.data;
  }

  close(): void {
    this.socket.close();
  }

  /** Resolves true once the server has closed the connection, false if it is still open after the timeout. */
  async closedWithin(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.socket.readyState !== WebSocket.CLOSED && Date.now() < deadline) await sleep(25);
    return this.socket.readyState === WebSocket.CLOSED;
  }
}

async function main(): Promise<void> {
  console.log(`Smoke test against ${API}`);
  const run = crypto.randomBytes(3).toString('hex').toUpperCase();
  const traderA = `SMOKE_A_${run}`;
  const traderB = `SMOKE_B_${run}`;
  const password = crypto.randomBytes(12).toString('base64url');

  // -------------------------------------------------------------------------
  section('Phase 2 - auth');
  const health = await api('GET', '/health');
  check('health endpoint reports ok', health.status === 200 && health.body.status === 'ok', health.body);
  const provider: string = health.body?.marketData;

  // Wrong sign-ins count towards a lock-out for that trader id, so each run uses ids of its own.
  check('login for an unknown trader is 401', (await api('POST', '/api/auth/login', undefined, { traderId: `NOBODY_${run}`, password: 'whatever-123' })).status === 401);
  const adminLogin = await api('POST', '/api/auth/login', undefined, { traderId: ADMIN_ID.toLowerCase(), password: ADMIN_PASSWORD });
  check('admin login returns a JWT (trader id is case-insensitive)', adminLogin.status === 200 && typeof adminLogin.body.token === 'string', adminLogin.body);
  const admin: string = adminLogin.body.token;
  if (!admin) throw new Error('Cannot continue without an admin session. Is the database seeded?');

  check('protected route without a token is 401', (await api('GET', '/api/competitions')).status === 401);
  check('protected route with a forged token is 401', (await api('GET', '/api/competitions', `${admin.slice(0, -4)}AAAA`)).status === 401);

  // -------------------------------------------------------------------------
  section('Phase 2 - competition management');
  for (const traderId of [traderA, traderB]) {
    const created = await api('POST', '/api/users', admin, { traderId, password, displayName: `Smoke ${traderId.slice(6, 7)}` });
    check(`admin creates trader ${traderId}`, created.status === 201, created.body);
  }
  check('login with a wrong password is 401', (await api('POST', '/api/auth/login', undefined, { traderId: traderA, password: 'definitely-wrong' })).status === 401);
  check('duplicate trader id is 409', (await api('POST', '/api/users', admin, { traderId: traderA, password })).status === 409);
  check('short password is 400', (await api('POST', '/api/users', admin, { traderId: `X${run}`, password: 'short' })).status === 400);

  const window = { startDate: new Date(Date.now() - 1000).toISOString(), endDate: new Date(Date.now() + 3600_000).toISOString() };
  const created = await api('POST', '/api/competitions', admin, { name: `Smoke ${run}`, ...window, traderIds: [traderA] });
  check('admin creates a competition and enrols trader A', created.status === 201 && created.body.enrollment.enrolled.length === 1, created.body);
  const competitionId: string = created.body.competition.id;
  check('competition defaults to a $100,000 balance and is ACTIVE', created.body.competition.startingBalance === 100000 && created.body.competition.status === 'ACTIVE', created.body.competition);

  const added = await api('POST', `/api/competitions/${competitionId}/participants`, admin, { traderIds: [traderA, traderB, 'NO_SUCH_TRADER'] });
  check(
    'adding participants is idempotent and reports unknown ids',
    added.body.enrollment?.enrolled.join() === traderB && added.body.enrollment.alreadyEnrolled.join() === traderA && added.body.enrollment.notFound.join() === 'NO_SUCH_TRADER',
    added.body,
  );
  check('competition with end before start is 400', (await api('POST', '/api/competitions', admin, { name: 'Backwards', startDate: window.endDate, endDate: window.startDate })).status === 400);

  const a: string = (await api('POST', '/api/auth/login', undefined, { traderId: traderA, password })).body.token;
  const b: string = (await api('POST', '/api/auth/login', undefined, { traderId: traderB, password })).body.token;
  check('traders can log in', Boolean(a && b));
  check('a trader cannot create competitions (403)', (await api('POST', '/api/competitions', a, { name: 'Nope', ...window })).status === 403);
  check('a trader cannot list users (403)', (await api('GET', '/api/users', a)).status === 403);
  const mine = await api('GET', '/api/competitions', a);
  check('a trader sees only competitions they are enrolled in', mine.body.competitions?.length === 1 && mine.body.competitions[0].id === competitionId, mine.body);

  const portfolioUrl = `/api/portfolios/${competitionId}`;
  const fresh = (await api('GET', portfolioUrl, a)).body.portfolio;
  check('fresh portfolio: $100,000 cash, buying power and equity', fresh?.cash === 100000 && fresh.buyingPower === 100000 && fresh.totalEquity === 100000 && fresh.positions.length === 0, fresh);

  // -------------------------------------------------------------------------
  section('Phase 3 - market data over WebSocket');
  const feed = await Feed.connect(a);
  check('WebSocket authenticates with the JWT', feed.messages.some((m) => m.type === 'ready' && m.traderId === traderA));
  feed.send({ type: 'subscribe', symbols: ['AAPL', 'TSLA'] });
  const first = await feed.waitFor((m) => m.type === 'quote' && m.data.symbol === 'AAPL');
  check('subscribing delivers a Level 1 quote', Boolean(first) && first.data.bid > 0 && first.data.ask >= first.data.bid, first);
  if (provider === 'simulated') {
    const before = feed.messages.filter((m) => m.type === 'quote').length;
    await sleep(1500);
    check('quotes keep streaming', feed.messages.filter((m) => m.type === 'quote').length > before);
  }
  feed.send({ type: 'subscribe', symbols: ['ZZZZZZ'] });
  check('unknown symbols are reported, not silently ignored', Boolean(await feed.waitFor((m) => m.type === 'error' && m.code === 'UNKNOWN_SYMBOL')));

  const unauthenticated = new WebSocket(WS_URL);
  const refusal = await new Promise<any>((resolve) => {
    unauthenticated.once('open', () => unauthenticated.send(JSON.stringify({ type: 'subscribe', symbols: ['AAPL'] })));
    unauthenticated.once('message', (raw) => resolve(JSON.parse(raw.toString())));
    setTimeout(() => resolve(null), 3000);
  });
  unauthenticated.close();
  check('WebSocket refuses to stream before authentication', refusal?.code === 'UNAUTHORIZED', refusal);

  const bars = await api('GET', '/api/market/bars/AAPL?timeframe=5Min&limit=50', a);
  const times: number[] = (bars.body.bars ?? []).map((bar: any) => bar.time);
  check('chart history returns ascending OHLC bars', bars.status === 200 && times.length > 1 && times.every((t, i) => i === 0 || t > times[i - 1]!), { status: bars.status, count: times.length });

  // -------------------------------------------------------------------------
  section('Phase 3 - matching engine');
  const order = (token: string, body: object) => api('POST', '/api/orders', token, { competitionId, ...body });

  const quoteBefore = feed.latestQuote('AAPL');
  const buy = await order(a, { ticker: 'aapl', side: 'BUY', type: 'MARKET', quantity: 100 });
  check('market buy fills immediately', buy.status === 201 && buy.body.order.status === 'FILLED', buy.body);
  const buyPrice: number = buy.body.order.fillPrice;
  check('market buy fills at the ask plus $0.01 slippage', Math.abs(buyPrice - (quoteBefore.ask + 0.01)) < 1, { buyPrice, ask: quoteBefore.ask });
  check('the fill is pushed to the trader over WebSocket', Boolean(await feed.waitFor((m) => m.type === 'order' && m.data.id === buy.body.order.id && m.data.status === 'FILLED')));

  let portfolio = (await api('GET', portfolioUrl, a)).body.portfolio;
  check('cash is debited exactly quantity x fill price', near(portfolio.cash, 100000 - 100 * buyPrice), { cash: portfolio.cash, expected: 100000 - 100 * buyPrice });
  const aapl = portfolio.positions.find((p: any) => p.ticker === 'AAPL');
  check('position opens at the fill price', aapl?.quantity === 100 && near(aapl.averagePrice, buyPrice), aapl);
  check('buying power drops by the position value', near(portfolio.buyingPower, portfolio.totalEquity - Math.abs(aapl.marketValue), 0.02), portfolio);

  const tooBig = await order(a, { ticker: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 100000 });
  check('risk check rejects an order beyond buying power (422)', tooBig.status === 422 && tooBig.body.error.code === 'ORDER_REJECTED' && /Insufficient buying power/.test(tooBig.body.error.message), tooBig.body);
  check('a rejected order changes nothing', near((await api('GET', portfolioUrl, a)).body.portfolio.cash, portfolio.cash));

  check('quantity of zero is 400', (await order(a, { ticker: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 0 })).status === 400);
  check('fractional quantity is 400', (await order(a, { ticker: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1.5 })).status === 400);
  check('limit order without a price is 400', (await order(a, { ticker: 'AAPL', side: 'BUY', type: 'LIMIT', quantity: 1 })).status === 400);
  check('market order with a limit price is 400', (await order(a, { ticker: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1, limitPrice: 10 })).status === 400);
  check('unknown ticker is rejected (422)', (await order(a, { ticker: 'ZZZZZZ', side: 'BUY', type: 'MARKET', quantity: 1 })).status === 422);

  const farAbove = Math.round(feed.latestQuote('AAPL').ask * 1.5 * 100) / 100;
  const resting = await order(a, { ticker: 'AAPL', side: 'SELL', type: 'LIMIT', quantity: 100, limitPrice: farAbove });
  check('a limit sell above the market rests as OPEN', resting.status === 201 && resting.body.order.status === 'OPEN', resting.body);
  const openOrders = await api('GET', `${portfolioUrl}/orders?status=OPEN`, a);
  check('account history lists the working order', openOrders.body.orders?.some((o: any) => o.id === resting.body.order.id), openOrders.body);
  const cancelled = await api('DELETE', `/api/orders/${resting.body.order.id}`, a);
  check('cancelling a resting order works', cancelled.status === 200 && cancelled.body.order.status === 'CANCELLED', cancelled.body);
  check('cancelling it twice is 409', (await api('DELETE', `/api/orders/${resting.body.order.id}`, a)).status === 409);
  check("another trader cannot cancel someone else's order (404)", (await api('DELETE', `/api/orders/${buy.body.order.id}`, b)).status === 404);

  const crossing = Math.round((feed.latestQuote('AAPL').ask + 1) * 100) / 100;
  const marketable = await order(a, { ticker: 'AAPL', side: 'BUY', type: 'LIMIT', quantity: 10, limitPrice: crossing });
  check('a limit buy through the ask fills immediately, at or below its limit', marketable.body.order?.status === 'FILLED' && marketable.body.order.fillPrice <= crossing, marketable.body);

  if (provider === 'simulated') {
    // Bracket the market on the most volatile symbol: a random walk reaches one side within seconds.
    const tsla = feed.latestQuote('TSLA');
    const below = Math.round((tsla.ask - 0.03) * 100) / 100;
    const above = Math.round((tsla.bid + 0.03) * 100) / 100;
    const bid = await order(a, { ticker: 'TSLA', side: 'BUY', type: 'LIMIT', quantity: 5, limitPrice: below });
    const offer = await order(a, { ticker: 'TSLA', side: 'SELL', type: 'LIMIT', quantity: 5, limitPrice: above });
    const ids = [bid.body.order?.id, offer.body.order?.id];
    check('limit orders either side of the market are accepted', ids.every(Boolean), [bid.body, offer.body]);
    const filled =
      [bid, offer].map((r) => r.body.order).find((o) => o?.status === 'FILLED') ??
      (await feed.waitFor((m) => m.type === 'order' && ids.includes(m.data.id) && m.data.status === 'FILLED', 60_000))?.data;
    check(
      'a resting limit order fills when the market reaches it, at no worse than its limit',
      Boolean(filled) && (filled.side === 'BUY' ? filled.fillPrice <= below : filled.fillPrice >= above),
      filled ?? 'neither side filled within 60s',
    );
    for (const id of ids) if (id && id !== filled?.id) await api('DELETE', `/api/orders/${id}`, a);
  }

  const flip = await order(a, { ticker: 'AAPL', side: 'SELL', type: 'MARKET', quantity: 160 });
  check('selling 160 against a 110 long fills (flips to short)', flip.body.order?.status === 'FILLED', flip.body);
  portfolio = (await api('GET', portfolioUrl, a)).body.portfolio;
  const short = portfolio.positions.find((p: any) => p.ticker === 'AAPL');
  check('position is now short 50 at the sell price', short?.quantity === -50 && short.side === 'SHORT' && near(short.averagePrice, flip.body.order.fillPrice), short);
  const expectedRealized = 110 * (flip.body.order.fillPrice - (100 * buyPrice + 10 * marketable.body.order.fillPrice) / 110);
  check('realised P&L on the closed 110 shares is correct', near(flip.body.order.realizedPnl, expectedRealized, 0.02), { got: flip.body.order.realizedPnl, expectedRealized });

  const cover = await order(a, { ticker: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 50 });
  check('buying 50 covers the short', cover.body.order?.status === 'FILLED', cover.body);
  portfolio = (await api('GET', portfolioUrl, a)).body.portfolio;
  check('AAPL position is flat and removed', !portfolio.positions.some((p: any) => p.ticker === 'AAPL'), portfolio.positions);

  const marketValue = portfolio.positions.reduce((sum: number, p: any) => sum + p.marketValue, 0);
  check('equity = cash + market value of positions', near(portfolio.totalEquity, portfolio.cash + marketValue, 0.02), portfolio);
  check('total P&L = equity - starting balance', near(portfolio.totalPnl, portfolio.totalEquity - 100000, 0.02), portfolio);
  const history = await api('GET', `${portfolioUrl}/orders?limit=500`, a);
  const cashFromFills = history.body.orders
    .filter((o: any) => o.status === 'FILLED')
    .reduce((cash: number, o: any) => cash + (o.side === 'SELL' ? 1 : -1) * o.quantity * o.fillPrice, 100000);
  check('cash reconciles with the order history to the cent', near(portfolio.cash, cashFromFills, 0.011), { cash: portfolio.cash, cashFromFills });
  const realizedFromFills = history.body.orders.reduce((sum: number, o: any) => sum + (o.realizedPnl ?? 0), 0);
  check('portfolio realised P&L equals the sum over fills', near(portfolio.realizedPnl, realizedFromFills, 0.011), { realized: portfolio.realizedPnl, realizedFromFills });

  const untouched = (await api('GET', portfolioUrl, b)).body.portfolio;
  check("trader B's portfolio is isolated from trader A's trading", untouched?.cash === 100000 && untouched.positions.length === 0, untouched);

  // Concurrency: 8 simultaneous buys that each fit alone but not together.
  const price = feed.latestQuote('AAPL').ask;
  const each = Math.floor(100000 / price / 3);
  const burst = await Promise.all(Array.from({ length: 8 }, () => order(b, { ticker: 'AAPL', side: 'BUY', type: 'MARKET', quantity: each })));
  const accepted = burst.filter((r) => r.status === 201).length;
  const afterBurst = (await api('GET', portfolioUrl, b)).body.portfolio;
  check(`concurrent orders cannot overspend (${accepted} of 8 accepted, cash stays >= 0)`, accepted >= 2 && accepted <= 3 && afterBurst.cash >= 0, { accepted, cash: afterBurst.cash });

  // Two orders at the same instant, each wanting most of the account: only one can have it.
  const race = await api('POST', '/api/competitions', admin, { name: `Smoke race ${run}`, ...window, traderIds: [traderA] });
  const raceQuote = (await api('GET', '/api/market/quote/MSFT', a)).body.quote;
  const most = Math.floor(60_000 / raceQuote.ask);
  const both = await Promise.all([1, 2].map(() => api('POST', '/api/orders', a, { competitionId: race.body.competition.id, ticker: 'MSFT', side: 'BUY', type: 'MARKET', quantity: most })));
  const raced = (await api('GET', `/api/portfolios/${race.body.competition.id}`, a)).body.portfolio;
  check(
    'two simultaneous orders cannot both spend the same buying power',
    both.filter((r) => r.status === 201).length === 1 && both.filter((r) => r.status === 422 && /buying power/.test(r.body.error.message)).length === 1 && raced.cash > 0 && raced.positions[0]?.quantity === most,
    { statuses: both.map((r) => r.status), cash: raced.cash, held: raced.positions[0]?.quantity },
  );

  // -------------------------------------------------------------------------
  section('Phase 3 - short-selling rule');
  const noShort = await api('POST', '/api/competitions', admin, { name: `Smoke long-only ${run}`, ...window, allowShorting: false, traderIds: [traderA] });
  const longOnly: string = noShort.body.competition.id;
  const naked = await api('POST', '/api/orders', a, { competitionId: longOnly, ticker: 'AAPL', side: 'SELL', type: 'MARKET', quantity: 10 });
  check('selling shares you do not hold is rejected where shorting is disabled', naked.status === 422 && /Insufficient shares/.test(naked.body.error.message), naked.body);
  const second = (await api('GET', `/api/portfolios/${longOnly}`, a)).body.portfolio;
  check('each competition gets its own fresh $100,000 portfolio', second?.cash === 100000, second);

  // -------------------------------------------------------------------------
  section('Pro - stop orders');
  const tslaNow = feed.latestQuote('TSLA');
  const wrongSide = await order(a, { ticker: 'TSLA', side: 'BUY', type: 'STOP', quantity: 5, stopPrice: Math.round((tslaNow.ask - 1) * 100) / 100 });
  check('a buy stop below the market is refused with an explanation', wrongSide.status === 422 && /buy stop must be above/.test(wrongSide.body.error.message), wrongSide.body);
  check('a stop order without a stop price is 400', (await order(a, { ticker: 'TSLA', side: 'BUY', type: 'STOP', quantity: 5 })).status === 400);
  check('a stop order with a limit price is 400', (await order(a, { ticker: 'TSLA', side: 'BUY', type: 'STOP', quantity: 5, stopPrice: 999, limitPrice: 999 })).status === 400);
  check(
    'a buy stop-limit with its limit below its stop is 400',
    (await order(a, { ticker: 'TSLA', side: 'BUY', type: 'STOP_LIMIT', quantity: 5, stopPrice: 999, limitPrice: 998 })).status === 400,
  );

  if (provider === 'simulated') {
    // Bracket the market again, far enough away that the price cannot get there before the
    // order does, close enough that one of the two stops is reached within seconds.
    const q = feed.latestQuote('TSLA');
    const buyStop = Math.round((q.ask + 0.2) * 100) / 100;
    const sellStop = Math.round((q.bid - 0.2) * 100) / 100;
    const up = await order(a, { ticker: 'TSLA', side: 'BUY', type: 'STOP', quantity: 5, stopPrice: buyStop });
    const down = await order(a, { ticker: 'TSLA', side: 'SELL', type: 'STOP', quantity: 5, stopPrice: sellStop });
    const stopIds = [up.body.order?.id, down.body.order?.id];
    check('stop orders rest as OPEN until their price is reached', up.body.order?.status === 'OPEN' && down.body.order?.status === 'OPEN' && up.body.order.stopPrice === buyStop, [up.body, down.body]);
    const fired = (await feed.waitFor((m) => m.type === 'order' && stopIds.includes(m.data.id) && m.data.status === 'FILLED', 60_000))?.data;
    check(
      'a stop fires when the market reaches it and fills at the market, through its stop price',
      Boolean(fired) && fired.triggeredAt !== null && (fired.side === 'BUY' ? fired.fillPrice >= buyStop : fired.fillPrice <= sellStop),
      fired ?? 'neither stop fired within 60s',
    );
    for (const id of stopIds) if (id && id !== fired?.id) await api('DELETE', `/api/orders/${id}`, a);

    const q2 = feed.latestQuote('TSLA');
    const stopAt = Math.round((q2.ask + 0.2) * 100) / 100;
    const limitAt = Math.round((stopAt + 0.5) * 100) / 100;
    const stopLimit = await order(a, { ticker: 'TSLA', side: 'BUY', type: 'STOP_LIMIT', quantity: 5, stopPrice: stopAt, limitPrice: limitAt });
    const sellSide = await order(a, { ticker: 'TSLA', side: 'SELL', type: 'STOP_LIMIT', quantity: 5, stopPrice: Math.round((q2.bid - 0.2) * 100) / 100, limitPrice: Math.round((q2.bid - 0.7) * 100) / 100 });
    const slIds = [stopLimit.body.order?.id, sellSide.body.order?.id];
    check('stop-limit orders are accepted on both sides', slIds.every(Boolean), [stopLimit.body, sellSide.body]);
    const slFired = (await feed.waitFor((m) => m.type === 'order' && slIds.includes(m.data.id) && m.data.status === 'FILLED', 60_000))?.data;
    check(
      'a stop-limit fires at its stop and never fills beyond its limit',
      Boolean(slFired) && slFired.triggeredAt !== null && (slFired.side === 'BUY' ? slFired.fillPrice <= slFired.limitPrice && slFired.fillPrice >= slFired.stopPrice : slFired.fillPrice >= slFired.limitPrice && slFired.fillPrice <= slFired.stopPrice),
      slFired ?? 'neither stop-limit fired within 60s',
    );
    for (const id of slIds) if (id && id !== slFired?.id) await api('DELETE', `/api/orders/${id}`, a);
  }

  // -------------------------------------------------------------------------
  section('Pro - bracket orders');
  // In the long-only competition on purpose: the strictest rules about shares already committed.
  const bracket = (body: object) => api('POST', '/api/orders', a, { competitionId: longOnly, ticker: 'AAPL', ...body });
  const cents = (value: number) => Math.round(value * 100) / 100;
  const exitsOf = async (entryId: string, settled: (exits: any[]) => boolean): Promise<any[]> => {
    let exits: any[] = [];
    for (let i = 0; i < 120; i++) {
      exits = (await api('GET', `/api/portfolios/${longOnly}/orders`, a)).body.orders.filter((o: any) => o.parentId === entryId);
      if (settled(exits)) break;
      await sleep(250);
    }
    return exits;
  };
  let mark = feed.latestQuote('AAPL');
  const upsideDown = await bracket({ side: 'BUY', type: 'MARKET', quantity: 10, takeProfit: cents(mark.bid - 5) });
  check('a take-profit below the entry of a buy is refused', upsideDown.status === 422 && /take-profit must be above/.test(upsideDown.body.error.message), upsideDown.body);
  const noProtection = await bracket({ side: 'BUY', type: 'MARKET', quantity: 10, stopLoss: cents(mark.ask + 5) });
  check('a stop-loss above the entry of a buy is refused', noProtection.status === 422 && /stop-loss must be below/.test(noProtection.body.error.message), noProtection.body);

  const waiting = await bracket({ side: 'BUY', type: 'LIMIT', quantity: 10, limitPrice: cents(mark.bid - 30), takeProfit: cents(mark.bid - 10), stopLoss: cents(mark.bid - 50) });
  check('an entry that has not filled keeps its bracket as instructions only', waiting.status === 201 && waiting.body.order.status === 'OPEN' && waiting.body.order.takeProfit === cents(mark.bid - 10) && (await exitsOf(waiting.body.order.id, () => true)).length === 0, waiting.body);
  await api('DELETE', `/api/orders/${waiting.body.order.id}`, a);

  const entry = await bracket({ side: 'BUY', type: 'MARKET', quantity: 10, takeProfit: cents(mark.ask + 40), stopLoss: cents(mark.bid - 40) });
  check('a market buy with a bracket fills', entry.status === 201 && entry.body.order.status === 'FILLED', entry.body);
  let exits = await exitsOf(entry.body.order.id, (found) => found.length === 2);
  let takeProfit = exits.find((o) => o.type === 'LIMIT');
  let stopLoss = exits.find((o) => o.type === 'STOP');
  check(
    'its take-profit and stop-loss go to work as sell orders of the same size',
    takeProfit?.status === 'OPEN' && stopLoss?.status === 'OPEN' && takeProfit.side === 'SELL' && stopLoss.side === 'SELL' && takeProfit.quantity === 10 && stopLoss.quantity === 10 &&
      takeProfit.limitPrice === cents(mark.ask + 40) && stopLoss.stopPrice === cents(mark.bid - 40),
    exits,
  );
  check('the exits are pushed to the trader over WebSocket', Boolean(await feed.waitFor((m) => m.type === 'order' && m.data.id === takeProfit?.id)) && Boolean(await feed.waitFor((m) => m.type === 'order' && m.data.id === stopLoss?.id)));
  const reducing = await bracket({ side: 'SELL', type: 'LIMIT', quantity: 5, limitPrice: cents(mark.ask + 60), takeProfit: cents(mark.ask + 50) });
  check('a bracket on an order that would reduce the position is refused', reducing.status === 422 && /opens or adds/.test(reducing.body.error.message), reducing.body);

  const byHand = await bracket({ side: 'SELL', type: 'MARKET', quantity: 10 });
  check('closing by hand is not blocked by the working exits', byHand.status === 201 && byHand.body.order.status === 'FILLED', byHand.body);
  exits = await exitsOf(entry.body.order.id, (found) => found.every((o) => o.status !== 'OPEN'));
  check('closing the position cancels both exits', exits.length === 2 && exits.every((o) => o.status === 'CANCELLED' && o.rejectReason === 'Position closed'), exits);

  // A stop-loss a cent under the entry's own limit is above the bid, so the very next quote hits it,
  // which shows one side cancelling the other. Measured from the limit, it is valid wherever the price goes.
  let tight: any;
  for (let attempt = 0; attempt < 5; attempt++) {
    const fresh = (await api('GET', '/api/market/quote/AAPL', a)).body.quote;
    const limitPrice = cents(fresh.ask + 0.05);
    tight = await bracket({ side: 'BUY', type: 'LIMIT', quantity: 10, limitPrice, takeProfit: cents(limitPrice + 40), stopLoss: cents(limitPrice - 0.01) });
    if (tight.status === 201 && tight.body.order.status === 'FILLED') break;
    // The market jumped past the limit in the instant between reading it and trading: withdraw and go again.
    if (tight.status === 201) await api('DELETE', `/api/orders/${tight.body.order.id}`, a);
  }
  check('a second bracketed buy fills', tight.status === 201 && tight.body.order.status === 'FILLED', tight.body);
  exits = await exitsOf(tight.body.order.id, (found) => found.length === 2 && found.every((o) => o.status !== 'OPEN'));
  takeProfit = exits.find((o) => o.type === 'LIMIT');
  stopLoss = exits.find((o) => o.type === 'STOP');
  check('when the stop-loss is hit it sells at the market', stopLoss?.status === 'FILLED' && stopLoss.fillPrice > 0 && near(stopLoss.realizedPnl, 10 * (stopLoss.fillPrice - tight.body.order.fillPrice)), stopLoss);
  check('and the take-profit is cancelled: one cancels the other', takeProfit?.status === 'CANCELLED' && /other side of the bracket/.test(takeProfit.rejectReason), takeProfit);
  const afterBrackets = (await api('GET', `/api/portfolios/${longOnly}`, a)).body.portfolio;
  check('the position is flat and the cash adds up', afterBrackets.positions.length === 0 && near(afterBrackets.cash, 100000 + afterBrackets.realizedPnl), afterBrackets);

  // -------------------------------------------------------------------------
  section('Accounts - passwords, deactivation, who is online');
  const traderC = `SMOKE_C_${run}`;
  await api('POST', '/api/users', admin, { traderId: traderC, password, displayName: 'Smoke C' });
  const signIn = (traderId: string, secret: string) => api('POST', '/api/auth/login', undefined, { traderId, password: secret });
  let c: string = (await signIn(traderC, password)).body.token;
  const roster = (await api('GET', '/api/users', admin)).body.users;
  const userA = roster.find((u: any) => u.traderId === traderA);
  const userC = roster.find((u: any) => u.traderId === traderC);
  check('the admin sees who has the terminal open', userA?.online === true && userC?.online === false, { a: userA?.online, c: userC?.online });

  const wrongCurrent = await api('PUT', '/api/auth/password', c, { currentPassword: 'not-the-password', newPassword: 'another-pass-123' });
  check('changing a password needs the current one', wrongCurrent.status === 400, wrongCurrent.body);
  const newPassword = crypto.randomBytes(12).toString('base64url');
  const changed = await api('PUT', '/api/auth/password', c, { currentPassword: password, newPassword });
  check('a trader can change their own password', changed.status === 200 && typeof changed.body.token === 'string', changed.body);
  check('sessions opened with the old password stop working at once', (await api('GET', '/api/competitions', c)).status === 401);
  check('the session that made the change carries on', (await api('GET', '/api/competitions', changed.body.token)).status === 200);
  check('the old password no longer signs in, the new one does', (await signIn(traderC, password)).status === 401 && (await signIn(traderC, newPassword)).status === 200);

  const reset = await api('PUT', `/api/users/${userC.id}/password`, admin);
  check('an admin can replace a forgotten password with a temporary one', reset.status === 200 && typeof reset.body.temporaryPassword === 'string' && reset.body.temporaryPassword.length >= 10, { status: reset.status });
  check('a reset signs the trader out', (await api('GET', '/api/competitions', changed.body.token)).status === 401);
  const withTemporary = await signIn(traderC, reset.body.temporaryPassword);
  check('the temporary password signs in', withTemporary.status === 200);
  c = withTemporary.body.token;
  check('a trader cannot reset passwords or deactivate anyone', (await api('PUT', `/api/users/${userA.id}/password`, c)).status === 403 && (await api('PUT', `/api/users/${userA.id}/active`, c, { active: false })).status === 403);

  const terminalC = await Feed.connect(c);
  const deactivated = await api('PUT', `/api/users/${userC.id}/active`, admin, { active: false });
  check('an admin can deactivate a trader', deactivated.status === 200 && deactivated.body.user.isActive === false, deactivated.body);
  check('their open terminal is disconnected immediately', await terminalC.closedWithin(3000));
  check('a deactivated trader can neither use their session nor sign in', (await api('GET', '/api/competitions', c)).status === 401 && (await signIn(traderC, reset.body.temporaryPassword)).status === 401);
  const self = roster.find((u: any) => u.traderId === ADMIN_ID.toUpperCase());
  check('an admin cannot deactivate the account they are using', (await api('PUT', `/api/users/${self.id}/active`, admin, { active: false })).status === 400);
  await api('PUT', `/api/users/${userC.id}/active`, admin, { active: true });
  check('reactivating lets them back in', (await signIn(traderC, reset.body.temporaryPassword)).status === 200);
  check("the desktop app's password-free sign-in is not there for anyone else", (await api('POST', '/api/auth/desktop', undefined, { account: 'admin' })).status === 404);

  // -------------------------------------------------------------------------
  section('Pro - Level 2 and partial fills');
  const book = (await api('GET', '/api/market/depth/BAC', a)).body.depth;
  const bacQuote = (await api('GET', '/api/market/quote/BAC', a)).body.quote;
  check(
    'the Level 2 book has several levels a cent apart on each side, best first',
    book?.bids.length >= 5 && book.asks.length >= 5 && near(book.asks[1].price - book.asks[0].price, 0.01, 0.0001) && near(book.bids[0].price - book.bids[1].price, 0.01, 0.0001) && book.asks[0].price > book.bids[0].price,
    book,
  );
  check('its top is the quote', Math.abs(book.asks[0].price - bacQuote.ask) < 0.5 && Math.abs(book.bids[0].price - bacQuote.bid) < 0.5, { book: [book.bids[0], book.asks[0]], quote: [bacQuote.bid, bacQuote.ask] });
  feed.send({ type: 'subscribe', symbols: ['BAC'] });
  await feed.waitFor((m) => m.type === 'quote' && m.data.symbol === 'BAC');
  feed.send({ type: 'depth', symbol: 'BAC' });
  const depthFrame = await feed.waitFor((m) => m.type === 'depth' && m.data.symbol === 'BAC');
  check('Level 2 streams over WebSocket for the symbol on screen', Boolean(depthFrame) && depthFrame.data.asks.length >= 5 && depthFrame.data.asks[0].length === 2, depthFrame);

  // An account big enough to want more shares than the book is showing.
  const whale = await api('POST', '/api/competitions', admin, { name: `Smoke whale ${run}`, ...window, startingBalance: 1_000_000_000, traderIds: [traderA] });
  const whaleId: string = whale.body.competition.id;
  const whaleOrder = (body: object) => api('POST', '/api/orders', a, { competitionId: whaleId, ...body });
  const whaleOrders = async () => (await api('GET', `/api/portfolios/${whaleId}/orders`, a)).body.orders as any[];
  const piecesOf = async (orderId: string) => ((await api('GET', `/api/portfolios/${whaleId}/executions?limit=1000`, a)).body.executions as any[]).filter((e) => e.orderId === orderId);
  const visible = book.asks.reduce((sum: number, level: any) => sum + level.size, 0);

  const sweep = await whaleOrder({ ticker: 'BAC', side: 'BUY', type: 'MARKET', quantity: 100_000 });
  check(
    'a market order larger than the book fills in part and keeps working',
    sweep.status === 201 && sweep.body.order.status === 'OPEN' && sweep.body.order.filledQuantity > 0 && sweep.body.order.filledQuantity < 100_000,
    { ...(sweep.body.order ?? sweep.body), visible },
  );
  let sweepPieces = await piecesOf(sweep.body.order.id);
  const byPrice = [...sweepPieces].sort((x, y) => x.price - y.price);
  check('it trades through the book in pieces, each level at a worse price', sweepPieces.length >= 3 && byPrice.at(-1).price > byPrice[0].price, sweepPieces.map((e) => [e.price, e.quantity]));
  check('the pieces add up to what the order has filled', sweepPieces.reduce((sum, e) => sum + e.quantity, 0) === sweep.body.order.filledQuantity);
  const sweepCost = sweepPieces.reduce((sum, e) => sum + e.price * e.quantity, 0);
  check("the order's fill price is the average of its pieces, above the best offer", near(sweep.body.order.fillPrice, sweepCost / sweep.body.order.filledQuantity, 0.0002) && sweep.body.order.fillPrice > byPrice[0].price, sweep.body.order.fillPrice);

  let working: any = null;
  for (let i = 0; i < 80; i++) {
    working = (await whaleOrders()).find((o) => o.id === sweep.body.order.id);
    if (working.filledQuantity > sweep.body.order.filledQuantity) break;
    await sleep(250);
  }
  check('the rest fills as the book refills', working.filledQuantity > sweep.body.order.filledQuantity && working.status === 'OPEN', working);
  const stopped = await api('DELETE', `/api/orders/${sweep.body.order.id}`, a);
  check('cancelling a part-filled order keeps what has filled', stopped.status === 200 && stopped.body.order.status === 'CANCELLED' && stopped.body.order.filledQuantity >= working.filledQuantity, stopped.body);
  await sleep(1500);
  const settledSweep = (await whaleOrders()).find((o) => o.id === sweep.body.order.id);
  check('and it stops filling', settledSweep.filledQuantity === stopped.body.order.filledQuantity && settledSweep.status === 'CANCELLED', settledSweep);
  sweepPieces = await piecesOf(sweep.body.order.id);
  let whalePortfolio = (await api('GET', `/api/portfolios/${whaleId}`, a)).body.portfolio;
  const bac = whalePortfolio.positions.find((p: any) => p.ticker === 'BAC');
  check('the position is exactly the shares that filled', bac?.quantity === settledSweep.filledQuantity, bac);
  check('cash is debited by exactly the sum of the pieces', near(whalePortfolio.cash, 1_000_000_000 - sweepPieces.reduce((sum, e) => sum + e.price * e.quantity, 0), 0.01), whalePortfolio.cash);

  // A marketable limit order takes what is offered up to its limit; the rest waits at the limit, and its bracket grows with it.
  const pltr = (await api('GET', '/api/market/quote/PLTR', a)).body.quote;
  // The limit is set well through the market, so it is still reachable however the price moves in the next few seconds.
  const reachLimit = cents(pltr.ask * 1.05);
  const reach = await whaleOrder({ ticker: 'PLTR', side: 'BUY', type: 'LIMIT', quantity: 100_000, limitPrice: reachLimit, takeProfit: cents(pltr.ask + 20), stopLoss: cents(pltr.ask - 20) });
  check(
    'a marketable limit order larger than the offer fills in part and rests at its limit',
    reach.status === 201 && reach.body.order.status === 'OPEN' && reach.body.order.filledQuantity > 0 && reach.body.order.fillPrice <= reachLimit + 1e-9 && reach.body.order.filledQuantity < 100_000,
    reach.body.order,
  );
  let grown: any[] = [];
  let entryNow: any = null;
  for (let i = 0; i < 80; i++) {
    const all = await whaleOrders();
    entryNow = all.find((o) => o.id === reach.body.order.id);
    grown = all.filter((o) => o.parentId === reach.body.order.id);
    if (entryNow.filledQuantity > reach.body.order.filledQuantity && grown.length === 2 && grown.every((o) => o.quantity === entryNow.filledQuantity)) break;
    await sleep(250);
  }
  check('more of it fills, at its limit, as sellers arrive', entryNow.filledQuantity > reach.body.order.filledQuantity && entryNow.fillPrice <= reachLimit + 1e-9, entryNow);
  check("its bracket's exits grow to match what has filled", grown.length === 2 && grown.every((o) => o.status === 'OPEN' && o.quantity === entryNow.filledQuantity), { filled: entryNow.filledQuantity, exits: grown.map((o) => o.quantity) });
  await api('DELETE', `/api/orders/${reach.body.order.id}`, a);
  whalePortfolio = (await api('GET', `/api/portfolios/${whaleId}`, a)).body.portfolio;
  const heldPltr: number = whalePortfolio.positions.find((p: any) => p.ticker === 'PLTR')?.quantity ?? 0;
  const dump = await whaleOrder({ ticker: 'PLTR', side: 'SELL', type: 'MARKET', quantity: heldPltr });
  let flat = false;
  for (let i = 0; i < 120 && !flat; i++) {
    flat = !(await api('GET', `/api/portfolios/${whaleId}`, a)).body.portfolio.positions.some((p: any) => p.ticker === 'PLTR');
    if (!flat) await sleep(250);
  }
  const leftExits = (await whaleOrders()).filter((o) => o.parentId === reach.body.order.id);
  check('selling the whole position, in however many pieces, ends flat with both exits cancelled', dump.status === 201 && flat && leftExits.every((o) => o.status === 'CANCELLED'), { dump: dump.body, exits: leftExits.map((o) => [o.status, o.quantity, o.filledQuantity]) });

  // -------------------------------------------------------------------------
  section('Pro - commissions');
  const paid = await api('POST', '/api/competitions', admin, { name: `Smoke commission ${run}`, ...window, commissionPerShare: 0.01, traderIds: [traderA] });
  const paidId: string = paid.body.competition.id;
  check('a competition can charge commission per share', paid.status === 201 && paid.body.competition.commissionPerShare === 0.01, paid.body);
  const paidBuy = await api('POST', '/api/orders', a, { competitionId: paidId, ticker: 'MSFT', side: 'BUY', type: 'MARKET', quantity: 100 });
  check('each order is charged commission on the shares that trade', paidBuy.status === 201 && paidBuy.body.order.commission === 1, paidBuy.body);
  let paidPortfolio = (await api('GET', `/api/portfolios/${paidId}`, a)).body.portfolio;
  check('commission comes out of cash, on top of the price paid', near(paidPortfolio.cash, 100000 - 100 * paidBuy.body.order.fillPrice - 1, 0.011) && paidPortfolio.commissions === 1, paidPortfolio);
  const paidSell = await api('POST', '/api/orders', a, { competitionId: paidId, ticker: 'MSFT', side: 'SELL', type: 'MARKET', quantity: 100 });
  paidPortfolio = (await api('GET', `/api/portfolios/${paidId}`, a)).body.portfolio;
  check('after a round trip, equity is the starting balance plus the trading result less both commissions', paidSell.body.order.commission === 1 && paidPortfolio.commissions === 2 && near(paidPortfolio.totalEquity, 100000 + paidPortfolio.realizedPnl - 2, 0.011), paidPortfolio);
  const tooTight = await api('POST', '/api/competitions', admin, { name: `Smoke bad margin ${run}`, ...window, leverage: 2, maintenanceMargin: 0.5 });
  check('a margin call level a full account would already breach is refused (400)', tooTight.status === 400, tooTight.body);

  // -------------------------------------------------------------------------
  section('Pro - margin call');
  // 2x leverage, called below 49.9%: just under the 50% a fully invested account starts at. A heavy
  // commission takes it under that at once, so the call happens on cue instead of waiting for the market to fall.
  const margin = await api('POST', '/api/competitions', admin, { name: `Smoke margin ${run}`, ...window, leverage: 2, maintenanceMargin: 0.499, commissionPerShare: 1, traderIds: [traderA] });
  const marginId: string = margin.body.competition.id;
  const marginOrder = (body: object) => api('POST', '/api/orders', a, { competitionId: marginId, ...body });
  const bystander = await marginOrder({ ticker: 'INTC', side: 'BUY', type: 'LIMIT', quantity: 1, limitPrice: 1 });
  const intc = (await api('GET', '/api/market/quote/INTC', a)).body.quote;
  const allIn = await marginOrder({ ticker: 'INTC', side: 'BUY', type: 'MARKET', quantity: Math.floor(198_000 / (intc.ask + 1.3)) });
  check('a leveraged account can go all in', bystander.status === 201 && allIn.status === 201 && allIn.body.order.filledQuantity > 0, allIn.body);
  const stretched = (await api('GET', `/api/portfolios/${marginId}`, a)).body.portfolio;
  check('the portfolio reports its margin level and the level at which it is called', stretched.maintenanceMargin === 0.499 && (stretched.marginLevel === null || stretched.marginLevel < 0.55), { level: stretched.marginLevel, call: stretched.maintenanceMargin });
  let called: any = null;
  let afterCall: any = null;
  for (let i = 0; i < 80; i++) {
    afterCall = (await api('GET', `/api/portfolios/${marginId}`, a)).body.portfolio;
    called = ((await api('GET', `/api/portfolios/${marginId}/orders`, a)).body.orders as any[]).find((o) => o.forcedBy === 'MARGIN_CALL');
    if (called && afterCall.positions.length === 0) break;
    await sleep(250);
  }
  check('an account below its maintenance margin is liquidated: its positions are sold at market', called?.side === 'SELL' && called.type === 'MARKET' && called.filledQuantity > 0 && afterCall.positions.length === 0, { called, positions: afterCall?.positions });
  const marginOrders = (await api('GET', `/api/portfolios/${marginId}/orders`, a)).body.orders as any[];
  check('and its working orders are cancelled', marginOrders.find((o) => o.id === bystander.body.order.id)?.status === 'CANCELLED' && /Margin call/.test(marginOrders.find((o) => o.id === bystander.body.order.id)?.rejectReason ?? ''), marginOrders.find((o) => o.id === bystander.body.order.id));
  check('the trader is told over WebSocket', Boolean(await feed.waitFor((m) => m.type === 'order' && m.data.forcedBy === 'MARGIN_CALL')));
  check('what is left is cash, and the account can trade again', afterCall.marginLevel === null && near(afterCall.totalEquity, afterCall.cash, 0.011) && afterCall.totalEquity < 100000 && (await marginOrder({ ticker: 'INTC', side: 'BUY', type: 'MARKET', quantity: 1 })).status === 201, afterCall);

  // -------------------------------------------------------------------------
  section('Phase 5 - leaderboard worker');
  const since = Date.now();
  let board: any = null;
  for (let i = 0; i < 30; i++) {
    board = (await api('GET', `/api/competitions/${competitionId}/leaderboard`, a)).body;
    if (board?.updatedAt && Date.parse(board.updatedAt) > since) break;
    await sleep(1000);
  }
  check('worker refreshes the Redis leaderboard within its interval', Boolean(board?.updatedAt) && Date.parse(board.updatedAt) > since, board);
  const entries: any[] = board?.entries ?? [];
  check('leaderboard lists both traders', entries.length === 2 && entries.some((e) => e.traderId === traderA) && entries.some((e) => e.traderId === traderB), entries);
  check('leaderboard is ranked by equity, highest first', entries.every((e, i) => e.rank === i + 1 && (i === 0 || e.equity <= entries[i - 1].equity)), entries);
  check("leaderboard includes the caller's own standing", board?.me?.traderId === traderA, board?.me);
  const live = (await api('GET', portfolioUrl, a)).body.portfolio;
  check("leaderboard equity tracks the trader's live NAV", Math.abs(board.me.equity - live.totalEquity) < 100, { board: board?.me?.equity, live: live.totalEquity });

  feed.send({ type: 'leaderboard', competitionId });
  check('leaderboard is also pushed over WebSocket', Boolean(await feed.waitFor((m) => m.type === 'leaderboard' && m.data.competitionId === competitionId)));
  const outsider = await api('GET', `/api/competitions/${longOnly}/leaderboard`, b);
  check('leaderboard of a competition you are not in is 403', outsider.status === 403, outsider.body);

  // -------------------------------------------------------------------------
  section('Joining with an invite code');
  const open = await api('POST', '/api/competitions', admin, { name: `Smoke open ${run}`, ...window });
  const joinCode: string = open.body.competition?.joinCode;
  const openId: string = open.body.competition?.id;
  check('a new competition gets a six-character invite code, shown to the admin', /^[A-Z2-9]{6}$/.test(joinCode ?? ''), open.body.competition);
  const asTrader = (await api('GET', '/api/competitions', a)).body.competitions;
  check('traders are never sent invite codes', asTrader.every((c: any) => !('joinCode' in c)), asTrader[0]);

  const preview = await api('GET', `/api/invites/${joinCode}`);
  check('anyone with the code can see what it opens, without an account', preview.status === 200 && preview.body.competition.name === `Smoke open ${run}` && !('id' in preview.body.competition), preview.body);
  check('an unknown invite code is 404', (await api('GET', '/api/invites/ZZZZZZ')).status === 404);

  const joiner = `SMOKE_J_${run}`;
  const refused = await api('POST', '/api/auth/join', undefined, { code: 'ZZZZZZ', traderId: joiner, password });
  check('nobody can create an account without a valid code', refused.status === 404, refused.body);
  check('a short password is refused at sign-up', (await api('POST', '/api/auth/join', undefined, { code: joinCode, traderId: joiner, password: 'short' })).status === 400);
  // Typed the way people type codes: lower case, with a space in the middle.
  const joined = await api('POST', '/api/auth/join', undefined, { code: `${joinCode.slice(0, 3).toLowerCase()} ${joinCode.slice(3).toLowerCase()}`, traderId: joiner.toLowerCase(), password, displayName: 'Smoke Joiner' });
  check('signing up with the code creates the account and signs it in', joined.status === 201 && typeof joined.body.token === 'string' && joined.body.user.traderId === joiner, joined.body);
  const j: string = joined.body.token;
  const joinedPortfolio = (await api('GET', `/api/portfolios/${openId}`, j)).body.portfolio;
  check('the new trader starts with a fresh $100,000 in that competition', joinedPortfolio?.cash === 100000 && joinedPortfolio.positions.length === 0, joinedPortfolio);
  check('the new trader can trade straight away', (await api('POST', '/api/orders', j, { competitionId: openId, ticker: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 10 })).body.order?.status === 'FILLED');
  check('the same Trader ID cannot be taken twice', (await api('POST', '/api/auth/join', undefined, { code: joinCode, traderId: joiner, password })).status === 409);
  check('the new trader can log in again with their password', (await api('POST', '/api/auth/login', undefined, { traderId: joiner, password })).status === 200);

  const existing = await api('POST', `/api/invites/${joinCode}/join`, b);
  check('a trader who already has an account joins with the code', existing.status === 200 && existing.body.alreadyEnrolled === false, existing.body);
  check('joining twice is harmless', (await api('POST', `/api/invites/${joinCode}/join`, b)).body.alreadyEnrolled === true);
  check('joining needs a session when there is no sign-up form', (await api('POST', `/api/invites/${joinCode}/join`)).status === 401);

  const closed = await api('PUT', `/api/competitions/${openId}/invite`, admin, { open: false });
  check('the admin can close sign-up, and the code stops working', closed.body.joinCode === null && (await api('GET', `/api/invites/${joinCode}`)).status === 404, closed.body);
  check('a trader cannot open or close sign-up (403)', (await api('PUT', `/api/competitions/${openId}/invite`, a, { open: true })).status === 403);
  const reopened = await api('PUT', `/api/competitions/${openId}/invite`, admin, { open: true });
  check('reopening issues a working code', /^[A-Z2-9]{6}$/.test(reopened.body.joinCode ?? '') && (await api('GET', `/api/invites/${reopened.body.joinCode}`)).status === 200, reopened.body);

  // -------------------------------------------------------------------------
  section('Connecting from another address');
  const connectFrom = (origin: string) =>
    new Promise<string>((resolve) => {
      const socket = new WebSocket(WS_URL, { origin });
      socket.once('open', () => socket.send(JSON.stringify({ type: 'auth', token: a })));
      socket.once('message', (raw) => {
        resolve(JSON.parse(raw.toString()).type);
        socket.close();
      });
      socket.once('close', (code) => resolve(`closed ${code}`));
      socket.once('error', () => resolve('error'));
    });
  check('a page served by this server may open the live feed', (await connectFrom(API)) === 'ready');
  check('a page from somewhere else may not', (await connectFrom('http://elsewhere.example')) === 'closed 1008');

  // -------------------------------------------------------------------------
  section('US market hours');
  const hours = await api('GET', '/api/market/hours');
  const nextOpen = new Date(hours.body?.session?.opensAt ?? 0);
  check('market hours need no account', hours.status === 200 && typeof hours.body.open === 'boolean' && hours.body.upcoming.length === 5, hours.body);
  check('sessions open at 9:30 am New York time', new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(nextOpen) === '9:30 AM', hours.body?.session);
  check(
    'in India that is 7:00 pm or 8:00 pm, depending on US daylight time',
    ['7:00 pm', '8:00 pm'].includes(new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(nextOpen).toLowerCase()),
    new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(nextOpen),
  );

  // -------------------------------------------------------------------------
  section('Competition end - settlement and winner');
  const live1 = await api('GET', `/api/competitions/${competitionId}/results`, a);
  check('results list every trader with a record, and no winner while running', live1.status === 200 && live1.body.standings.length === 2 && live1.body.winners.length === 0 && live1.body.competition.final === false, live1.body);
  const mine1 = live1.body.standings.find((row: any) => row.traderId === traderA);
  check('a record counts trades, wins and losses', mine1?.trades > 5 && mine1.wins + mine1.losses > 0 && mine1.winRate !== null, mine1);

  // A short competition that ends while we watch.
  const sprintEnd = new Date(Date.now() + 14_000).toISOString();
  const sprint = await api('POST', '/api/competitions', admin, { name: `Smoke sprint ${run}`, startDate: window.startDate, endDate: sprintEnd, traderIds: [traderA, traderB] });
  const sprintId: string = sprint.body.competition.id;
  const sprintOrder = (token: string, body: object) => api('POST', '/api/orders', token, { competitionId: sprintId, ...body });
  await sprintOrder(a, { ticker: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 50 });
  await sprintOrder(b, { ticker: 'TSLA', side: 'SELL', type: 'MARKET', quantity: 20 });
  const leftWorking = await sprintOrder(a, { ticker: 'MSFT', side: 'BUY', type: 'LIMIT', quantity: 10, limitPrice: 1 });

  let final: any = null;
  for (let i = 0; i < 45; i++) {
    final = (await api('GET', `/api/competitions/${sprintId}/results`, a)).body;
    if (final?.competition?.final) break;
    await sleep(1000);
  }
  check('the competition is settled shortly after its end time', final?.competition?.final === true && final.competition.status === 'ENDED', final?.competition);
  check('a winner is declared: the trader with the highest equity', final?.winners?.length >= 1 && final.winners[0].rank === 1 && final.winners[0].equity === Math.max(...final.standings.map((row: any) => row.equity)), final?.winners);
  const settledA = (await api('GET', `/api/portfolios/${sprintId}`, a)).body.portfolio;
  check('settlement closes every position, so the result is plain cash', settledA?.positions.length === 0 && near(settledA.totalEquity, settledA.cash) && near(settledA.unrealizedPnl, 0), settledA);
  const settledB = (await api('GET', `/api/portfolios/${sprintId}`, b)).body.portfolio;
  check('a short position is settled too', settledB?.positions.length === 0 && near(settledB.totalEquity, settledB.cash), settledB);
  check("the final standings match each trader's settled equity", final.standings.every((row: any) => near(row.equity, row.traderId === traderA ? settledA.totalEquity : settledB.totalEquity, 0.011)), final.standings);
  const afterEnd = await sprintOrder(a, { ticker: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1 });
  check('trading is refused once the competition has ended', afterEnd.status === 422 && /has ended/.test(afterEnd.body.error.message), afterEnd.body);
  const frozen = (await api('GET', `/api/portfolios/${sprintId}`, a)).body.portfolio.totalEquity;
  await sleep(3000);
  check('the settled result no longer moves with the market', (await api('GET', `/api/portfolios/${sprintId}`, a)).body.portfolio.totalEquity === frozen);
  let swept: any = null;
  for (let i = 0; i < 75 && swept?.status !== 'CANCELLED'; i++) {
    swept = (await api('GET', `/api/portfolios/${sprintId}/orders`, a)).body.orders.find((o: any) => o.id === leftWorking.body.order.id);
    if (swept?.status !== 'CANCELLED') await sleep(1000);
  }
  check('orders left working are cancelled when the competition ends', swept?.status === 'CANCELLED', swept);

  // -------------------------------------------------------------------------
  // Starting money: changed for a whole competition, profits and losses kept
  // -------------------------------------------------------------------------
  const rich = await api('POST', '/api/competitions', admin, { name: `Smoke money ${run}`, ...window, startingBalance: 100_000, traderIds: [traderA, traderB] });
  const richId: string = rich.body.competition.id;
  const bought = await api('POST', '/api/orders', a, { competitionId: richId, ticker: 'MSFT', side: 'BUY', type: 'MARKET', quantity: 150 });
  check('a trader buys in the competition whose money will change', bought.status === 201 && bought.body.order.status === 'FILLED', bought.body);
  const beforeA = (await api('GET', `/api/portfolios/${richId}`, a)).body.portfolio;
  check('a trader cannot change how much money a competition starts with (403)', (await api('PUT', `/api/competitions/${richId}/balance`, a, { startingBalance: 5_000_000 })).status === 403);
  const raised = await api('PUT', `/api/competitions/${richId}/balance`, admin, { startingBalance: 1_000_000 });
  check('the owner raises the starting money to $1,000,000 for every account', raised.status === 200 && raised.body.previous === 100_000 && raised.body.startingBalance === 1_000_000 && raised.body.accounts === 2, raised.body);
  const afterA = (await api('GET', `/api/portfolios/${richId}`, a)).body.portfolio;
  const afterB = (await api('GET', `/api/portfolios/${richId}`, b)).body.portfolio;
  check('cash moves by the difference and the position is untouched', near(afterA.cash, beforeA.cash + 900_000, 0.011) && afterA.positions[0]?.quantity === 150 && afterA.startingBalance === 1_000_000, { beforeA, afterA });
  check('profit and loss are the same as before (only the market moves them)', Math.abs(afterA.realizedPnl - beforeA.realizedPnl) < 0.011 && Math.abs(afterA.totalPnl - beforeA.totalPnl) < 50, { before: beforeA.totalPnl, after: afterA.totalPnl });
  check('an account that had not traded now holds exactly the new amount', near(afterB.cash, 1_000_000) && near(afterB.totalPnl, 0), afterB);
  const listed = (await api('GET', `/api/competitions/${richId}`, admin)).body.competition;
  check('the competition itself records the new amount', listed?.startingBalance === 1_000_000, listed);
  const bigOrder = await api('POST', '/api/orders', b, { competitionId: richId, ticker: 'MSFT', side: 'BUY', type: 'MARKET', quantity: 1500 });
  check('the extra money can be traded with at once', bigOrder.status === 201 && bigOrder.body.order.status === 'FILLED', bigOrder.body);
  const tooLow = await api('PUT', `/api/competitions/${richId}/balance`, admin, { startingBalance: 1_000 });
  check('lowering it below what someone has already spent is refused, with the least it can be', tooLow.status === 409 && /least it can start with/.test(tooLow.body.error.message), tooLow.body);
  check('the money of a finished competition cannot be changed', (await api('PUT', `/api/competitions/${sprintId}/balance`, admin, { startingBalance: 1_000_000 })).status === 409);
  const lowered = await api('PUT', `/api/competitions/${richId}/balance`, admin, { startingBalance: 900_000 });
  const loweredA = (await api('GET', `/api/portfolios/${richId}`, a)).body.portfolio;
  check('it can be lowered again, and cash falls by the difference', lowered.status === 200 && near(loweredA.cash, afterA.cash - 100_000, 0.011), { lowered: lowered.body, cash: loweredA.cash });

  feed.close();
  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nSmoke test aborted: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

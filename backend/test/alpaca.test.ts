import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AlpacaProvider as AlpacaProviderClass } from '../src/market/alpacaProvider.js';
import type { FeedStatus, QuoteUpdate } from '../src/market/provider.js';
import { MOCK_KEY, MOCK_SECRET, startMockAlpaca, type MockAlpaca } from './support/mockAlpaca.js';

// The provider logs through the app logger, which needs a valid configuration.
process.env.JWT_SECRET ??= 'unit-test-secret-unit-test-secret-0123456789';
process.env.LOG_LEVEL = 'silent';

let AlpacaProvider: typeof AlpacaProviderClass;
beforeAll(async () => {
  ({ AlpacaProvider } = await import('../src/market/alpacaProvider.js'));
});

async function until(check: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('AlpacaProvider', () => {
  let mock: MockAlpaca;
  let provider: AlpacaProviderClass;
  let updates: QuoteUpdate[];
  let statuses: FeedStatus[];

  async function connect(overrides: { key?: string; secret?: string } = {}) {
    mock = await startMockAlpaca();
    updates = [];
    statuses = [];
    provider = new AlpacaProvider({
      key: overrides.key ?? MOCK_KEY,
      secret: overrides.secret ?? MOCK_SECRET,
      feed: 'iex',
      streamUrl: mock.streamUrl,
      dataUrl: mock.dataUrl,
      suggestions: ['AAPL', 'MSFT'],
    });
    await provider.start(
      (update) => updates.push(update),
      (status) => statuses.push(status),
    );
  }
  const latestStatus = () => statuses[statuses.length - 1];

  afterEach(async () => {
    await provider?.stop();
    await mock?.close();
  });

  it('authenticates, subscribes and turns quote and trade messages into updates', async () => {
    await connect();
    provider.subscribe(['AAPL']);
    await until(() => latestStatus()?.state === 'streaming', 'the stream to authenticate');
    await until(() => mock.subscribed.has('AAPL'), 'the subscription to reach Alpaca');

    mock.tick('AAPL', { bid: 231.1, ask: 231.14 });
    mock.tick('AAPL', { last: 231.12 });
    await until(() => updates.length >= 2, 'both ticks');

    expect(updates[0]).toMatchObject({ symbol: 'AAPL', bid: 231.1, ask: 231.14, bidSize: 3, askSize: 2 });
    expect(updates[0]!.last).toBeUndefined();
    expect(updates[1]).toMatchObject({ symbol: 'AAPL', last: 231.12 });
    expect(Math.abs(updates[1]!.ts - Date.now())).toBeLessThan(5000);
  });

  it('only streams symbols that are still subscribed', async () => {
    await connect();
    provider.subscribe(['AAPL', 'MSFT']);
    await until(() => mock.subscribed.size === 2, 'both subscriptions');
    provider.unsubscribe(['MSFT']);
    await until(() => !mock.subscribed.has('MSFT'), 'the unsubscribe');

    mock.tick('MSFT', { last: 432 });
    mock.tick('AAPL', { last: 231 });
    await until(() => updates.length >= 1, 'a tick');
    expect(updates.map((u) => u.symbol)).toEqual(['AAPL']);
  });

  it('maps a snapshot to a full Level 1 quote', async () => {
    await connect();
    const quote = await provider.fetchSnapshot('AAPL');
    expect(quote).toMatchObject({ symbol: 'AAPL', bid: 229.98, ask: 230.02, bidSize: 3, askSize: 2, last: 230, prevClose: 228.5 });
    expect(Math.abs(quote!.ts - Date.now())).toBeLessThan(5000);
  });

  it('falls back to the last trade when one side of the book is empty', async () => {
    await connect();
    mock.symbols.set('THIN', { bid: 0, ask: 12.4, last: 12.35, prevClose: 12 });
    expect(await provider.fetchSnapshot('THIN')).toMatchObject({ bid: 12.35, ask: 12.4, last: 12.35 });
  });

  it('reports an unknown symbol as null rather than failing', async () => {
    await connect();
    expect(await provider.fetchSnapshot('NOPE')).toBeNull();
  });

  it('returns chart bars oldest first with epoch-second times', async () => {
    await connect();
    const bars = await provider.fetchBars('AAPL', '1Min', 5);
    expect(bars).toHaveLength(5);
    expect(bars.every((bar, i) => i === 0 || bar.time === bars[i - 1]!.time + 60)).toBe(true);
    expect(bars[4]!.close).toBe(230);
    expect(bars[4]!.time).toBe(Math.floor(Date.now() / 60_000) * 60);
  });

  it('explains rejected keys and stops retrying', async () => {
    await connect({ secret: 'wrong' });
    await until(() => latestStatus()?.state === 'error', 'the auth failure');
    expect(latestStatus()!.detail).toMatch(/rejected the API keys/);

    await new Promise((r) => setTimeout(r, 1500)); // longer than the first reconnect delay
    expect(mock.connections).toBe(1);
    await expect(provider.fetchSnapshot('AAPL')).rejects.toThrow(/401.*Authorization Required/);
  });

  it('reconnects after a dropped connection and restores every subscription', async () => {
    await connect();
    provider.subscribe(['AAPL', 'MSFT']);
    await until(() => mock.subscribed.size === 2, 'the first subscription');

    mock.dropConnections();
    await until(() => mock.connections === 2 && mock.subscribed.size === 2, 'the reconnect and resubscribe');

    mock.tick('MSFT', { last: 433.5 });
    await until(() => updates.some((u) => u.symbol === 'MSFT' && u.last === 433.5), 'a tick on the new connection');
  });

  it('explains the one-connection limit and recovers when the other session ends', async () => {
    mock = await startMockAlpaca();
    mock.mode = 'connection-limit';
    updates = [];
    statuses = [];
    provider = new AlpacaProvider({ key: MOCK_KEY, secret: MOCK_SECRET, feed: 'iex', streamUrl: mock.streamUrl, dataUrl: mock.dataUrl, suggestions: [] });
    await provider.start(
      (update) => updates.push(update),
      (status) => statuses.push(status),
    );
    await until(() => latestStatus()?.state === 'error', 'the connection limit error');
    expect(latestStatus()!.detail).toMatch(/one live data connection/);

    mock.mode = 'ok';
    await until(() => latestStatus()?.state === 'streaming', 'recovery', 6000);
  });
});

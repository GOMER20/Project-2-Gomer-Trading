import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Threads for password hashing (see lib/hashPool.ts): a quarter of the logical
// cores. Hashing is memory-hungry as well as CPU-hungry, and in load tests more
// threads than this made order entry slower for the people already trading
// while a crowd signed in. Signing in may queue for a few seconds; trading must not.
export const HASHING_THREADS = Math.min(8, Math.max(2, Math.floor(os.availableParallelism() / 4)));

const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(here, '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');

// Real environment variables win over the file, so this is safe in production
// where there is no .env at all.
for (const file of [path.join(BACKEND_ROOT, '.env'), path.join(REPO_ROOT, '.env')]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // file is optional
  }
}

const csv = (value: string) =>
  value
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // API_PORT wins. PORT is only a fallback for hosts that inject it, because the
  // frontend's dev server is often started with PORT set in the same environment.
  API_PORT: z.coerce.number().int().positive().optional(),
  PORT: z.coerce.number().int().positive().optional(),
  // Interface to listen on. Unset = all interfaces; the desktop app uses 127.0.0.1.
  API_HOST: z.string().optional(),
  // When set, the API also serves the exported frontend from this directory
  // (one origin for pages, REST and WebSocket). Used by the desktop app.
  STATIC_DIR: z.string().optional(),
  // Set by the desktop app so its owner can open the built-in accounts without a password.
  // The bot gateway's low-latency listeners. Unset = off; the WebSocket and REST gateways are always on.
  GATEWAY_TCP_PORT: z.coerce.number().int().min(0).max(65535).optional(),
  GATEWAY_TCP_HOST: z.string().default('127.0.0.1'),
  GATEWAY_UNIX_SOCKET: z.string().optional(),
  // Where the matching engine journals each decision before answering it. One file per database.
  ENGINE_JOURNAL: z.string().optional(),
  // HFT, the order book engine in hft/, run beside this server. test = it is sent a copy of every
  // price and order and measures itself, while this server's own engine still decides every fill.
  HFT_MODE: z.enum(['off', 'test']).default('test'),
  // The hft program, and where it keeps its recordings and statistics. The desktop app sets both.
  HFT_BIN: z.string().optional(),
  HFT_DIR: z.string().optional(),
  // HFT's disk budget: a session's recording stops growing at this many megabytes, and this many
  // sessions' recordings are kept, so its folder never holds more than the two multiplied together.
  HFT_RECORD_LIMIT_MB: z.coerce.number().int().min(1).max(100_000).default(250),
  HFT_KEEP_SESSIONS: z.coerce.number().int().min(1).max(100).default(2),
  // The realistic sandbox: each competition whose fill model is hft is matched in an HFT of its own,
  // in a folder under HFT_VENUE_DIR, each with this disk budget (recording cap times sessions kept).
  HFT_VENUE_DIR: z.string().optional(),
  HFT_VENUE_RECORD_LIMIT_MB: z.coerce.number().int().min(1).max(100_000).default(100),
  HFT_VENUE_KEEP_SESSIONS: z.coerce.number().int().min(1).max(100).default(2),
  // Where HFT Strategy, the market-making program in Project 1, keeps its status, reports and tick data.
  HFT_STRATEGY_DIR: z.string().optional(),
  // AT, the trading algorithm (a separate project) that trades here through the bot gateway. Its
  // windows find it by the label its API keys carry; AT_HOME is its own folder, whose reports
  // (runs/ and reports/) are shown beside what it traded here. Empty = not on this machine.
  AT_LABEL: z.string().trim().min(1).default('AT'),
  AT_HOME: z.string().default(''),
  DESKTOP_KEY: z.string().min(32).optional(),
  DESKTOP_ADMIN_ID: z.string().default('ADMIN'),
  DESKTOP_TRADER_ID: z.string().default('TRADER01'),
  MIGRATIONS_DIR: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1).default('postgresql://trader:trader@localhost:5432/trading'),
  // Connections this process may hold. The API and the worker each have their own pool.
  DB_POOL_MAX: z.coerce.number().int().min(2).max(200).default(40),
  // Live WebSocket connections accepted in total, and per signed-in trader.
  WS_MAX_CLIENTS: z.coerce.number().int().min(1).default(5000),
  WS_MAX_PER_USER: z.coerce.number().int().min(1).default(6),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN_HOURS: z.coerce.number().positive().default(12),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  // auto = Alpaca when keys are present, otherwise the built-in simulated feed.
  MARKET_DATA_PROVIDER: z.enum(['auto', 'alpaca', 'simulated']).default('auto'),
  ALPACA_API_KEY: z.string().default(''),
  ALPACA_API_SECRET: z.string().default(''),
  ALPACA_FEED: z.enum(['iex', 'sip', 'delayed_sip']).default('iex'),
  // The built-in practice market: exchange = it trades only during US market hours, like the real
  // thing; always = it never closes, for practice and testing at any hour.
  PRACTICE_MARKET_HOURS: z.enum(['exchange', 'always']).default('exchange'),
  // Only changed in tests: the moment (ISO time) the practice market's calendar takes it to be at start-up.
  PRACTICE_MARKET_CLOCK: z.string().default(''),
  // Only changed in tests, which point these at a local stand-in for Alpaca.
  ALPACA_STREAM_URL: z.string().default('wss://stream.data.alpaca.markets'),
  ALPACA_DATA_URL: z.string().default('https://data.alpaca.markets'),
  DEFAULT_SYMBOLS: z.string().default('AAPL,MSFT,NVDA,TSLA,AMZN,GOOGL,META,AMD,SPY,QQQ'),

  SLIPPAGE_PER_SHARE: z.coerce.number().min(0).default(0.01),
  // Market orders are refused when the newest quote is older than this.
  MAX_QUOTE_AGE_SEC: z.coerce.number().min(0).default(120),
  MAX_ORDER_QUANTITY: z.coerce.number().int().positive().default(100_000),

  // Most traders one competition accepts through its invite code.
  MAX_PARTICIPANTS: z.coerce.number().int().min(1).default(2000),

  LEADERBOARD_INTERVAL_MS: z.coerce.number().int().min(1000).default(10_000),
  LEADERBOARD_SIZE: z.coerce.number().int().min(1).max(100).default(10),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // Config errors must be loud and happen before anything else starts.
  console.error(`Invalid configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`);
  process.exit(1);
}

const env = parsed.data;

if (env.MARKET_DATA_PROVIDER === 'alpaca' && (!env.ALPACA_API_KEY || !env.ALPACA_API_SECRET)) {
  console.error('MARKET_DATA_PROVIDER=alpaca requires ALPACA_API_KEY and ALPACA_API_SECRET.');
  process.exit(1);
}

const hasAlpacaKeys = Boolean(env.ALPACA_API_KEY && env.ALPACA_API_SECRET);

export const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  port: env.API_PORT ?? env.PORT ?? 4000,
  host: env.API_HOST || undefined,
  staticDir: env.STATIC_DIR || undefined,
  gateway: { tcpPort: env.GATEWAY_TCP_PORT || undefined, tcpHost: env.GATEWAY_TCP_HOST, unixSocket: env.GATEWAY_UNIX_SOCKET || undefined },
  engine: {
    journal: env.ENGINE_JOURNAL || path.join(os.tmpdir(), `gomer-engine-${createHash('sha1').update(env.DATABASE_URL).digest('hex').slice(0, 10)}.journal`),
  },
  hft: {
    // The test suite must not start programs of its own accord.
    mode: env.NODE_ENV === 'test' ? ('off' as const) : env.HFT_MODE,
    binary: env.HFT_BIN || path.join(REPO_ROOT, 'hft', 'bin', 'hft'),
    dataDir: env.HFT_DIR || path.join(REPO_ROOT, '.data', 'hft'),
    recordLimitMb: env.HFT_RECORD_LIMIT_MB,
    keepSessions: env.HFT_KEEP_SESSIONS,
    venue: {
      dataDir: env.HFT_VENUE_DIR || path.join(REPO_ROOT, '.data', 'hft-venue'),
      recordLimitMb: env.HFT_VENUE_RECORD_LIMIT_MB,
      keepSessions: env.HFT_VENUE_KEEP_SESSIONS,
    },
    strategyDir: env.HFT_STRATEGY_DIR || path.join(REPO_ROOT, '.data', 'hft-strategy'),
  },
  desktop: { key: env.DESKTOP_KEY, accounts: { admin: env.DESKTOP_ADMIN_ID, trader: env.DESKTOP_TRADER_ID } },
  at: { label: env.AT_LABEL, home: env.AT_HOME },
  migrationsDir: env.MIGRATIONS_DIR || path.join(BACKEND_ROOT, 'db', 'migrations'),
  logLevel: env.LOG_LEVEL,
  databaseUrl: env.DATABASE_URL,
  dbPoolMax: env.DB_POOL_MAX,
  ws: { maxClients: env.WS_MAX_CLIENTS, maxPerUser: env.WS_MAX_PER_USER },
  redisUrl: env.REDIS_URL,
  jwt: {
    secret: env.JWT_SECRET,
    expiresInSeconds: Math.round(env.JWT_EXPIRES_IN_HOURS * 3600),
  },
  corsOrigins: env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
  marketData: {
    provider: (env.MARKET_DATA_PROVIDER === 'auto'
      ? hasAlpacaKeys
        ? 'alpaca'
        : 'simulated'
      : env.MARKET_DATA_PROVIDER) as 'alpaca' | 'simulated',
    alpacaKey: env.ALPACA_API_KEY,
    alpacaSecret: env.ALPACA_API_SECRET,
    alpacaFeed: env.ALPACA_FEED,
    practiceHours: env.PRACTICE_MARKET_HOURS,
    practiceClock: Number.isFinite(Date.parse(env.PRACTICE_MARKET_CLOCK)) ? Date.parse(env.PRACTICE_MARKET_CLOCK) : null,
    alpacaStreamUrl: env.ALPACA_STREAM_URL.replace(/\/+$/, ''),
    alpacaDataUrl: env.ALPACA_DATA_URL.replace(/\/+$/, ''),
    defaultSymbols: csv(env.DEFAULT_SYMBOLS),
  },
  trading: {
    slippagePerShare: env.SLIPPAGE_PER_SHARE,
    maxQuoteAgeMs: env.MAX_QUOTE_AGE_SEC * 1000,
    maxOrderQuantity: env.MAX_ORDER_QUANTITY,
  },
  maxParticipants: env.MAX_PARTICIPANTS,
  leaderboard: {
    intervalMs: env.LEADERBOARD_INTERVAL_MS,
    size: env.LEADERBOARD_SIZE,
  },
} as const;

export type Config = typeof config;

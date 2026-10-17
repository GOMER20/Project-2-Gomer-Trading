import { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

export function createRedis(name: string): Redis {
  const client = new Redis(config.redisUrl, {
    connectionName: name,
    maxRetriesPerRequest: 3,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
  client.on('error', (err) => logger.error({ err: err.message, client: name }, 'Redis error'));
  return client;
}

/** Shared command connection. Pub/sub needs its own connection: see createRedis. */
export const redis = createRedis('gomer');

export const keys = {
  /** Hash: symbol -> JSON quote. Written by the API process, read by the worker. */
  quotes: 'md:quotes',
  /** Sorted set: member = trader id, score = total equity. */
  leaderboard: (competitionId: string) => `lb:${competitionId}`,
  /** Hash: trader id -> display name. */
  leaderboardNames: (competitionId: string) => `lb:${competitionId}:names`,
  /** Hash: startingBalance, updatedAt, participants. */
  leaderboardMeta: (competitionId: string) => `lb:${competitionId}:meta`,
  /** Pub/sub channel carrying a fresh top-N after every worker pass. */
  leaderboardChannel: 'lb:updates',
  /** Stream: every fill in a competition as it happens, capped. Written by the gateway's P&L hook. */
  fills: (competitionId: string) => `fills:${competitionId}`,
  workerLock: 'lock:leaderboard-worker',
} as const;

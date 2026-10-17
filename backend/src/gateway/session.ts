import type { KeyIdentity } from './keys.service.js';
import type { BboUpdate, ChannelName, DepthUpdate, ExecutionReport, TradePrint } from './protocol.js';

/** One market-data event, encoded at most once per wire format however many sessions receive it. */
export interface Published {
  kind: ChannelName;
  symbol: string;
  data: BboUpdate | TradePrint | DepthUpdate;
  json(): string;
  binary(): Buffer;
}

/**
 * One connected trading program. The transports (WebSocket, TCP, Unix socket)
 * each implement the sending half; everything else about a session is the same
 * whichever way it connected.
 */
export interface Session {
  id: bigint;
  identity: KeyIdentity;
  transport: 'websocket' | 'tcp' | 'unix';
  remote: string;
  connectedAt: number;
  /** symbol -> channel bits it is subscribed to */
  subscriptions: Map<string, number>;
  counters: { orders: number; executions: number; marketData: number; dropped: number };
  /** Execution reports are never dropped: a session that cannot take them is disconnected. */
  sendExecution(report: ExecutionReport): void;
  /** Market data is dropped for a session that has fallen behind, so one slow reader never delays the rest. */
  sendMarketData(event: Published): void;
  close(reason: string): void;
}

const sessions = new Set<Session>();
let nextSessionId = BigInt(Date.now()) * 1000n;

export const newSessionId = () => ++nextSessionId;

export const registry = {
  add(session: Session): void {
    sessions.add(session);
  },
  remove(session: Session): void {
    sessions.delete(session);
  },
  all(): Iterable<Session> {
    return sessions;
  },
  /** The sessions an order event for this account must be reported to. */
  forAccount(userId: string, competitionId: string): Session[] {
    const found: Session[] = [];
    for (const session of sessions) if (session.identity.userId === userId && session.identity.competitionId === competitionId) found.push(session);
    return found;
  },
  forKey(keyId: string): Session[] {
    return [...sessions].filter((session) => session.identity.keyId === keyId);
  },
  get size(): number {
    return sessions.size;
  },
};

// --- order throttle ------------------------------------------------------------

/**
 * A token bucket per API key, shared by every connection that key has open and
 * by its REST calls: `ordersPerSecond` new orders a second, with a burst of the
 * same size. This is the pre-trade "order throttle".
 */
const buckets = new Map<string, { tokens: number; at: number }>();

export function takeOrderToken(identity: KeyIdentity, now = Date.now()): boolean {
  const rate = identity.ordersPerSecond;
  const bucket = buckets.get(identity.keyId) ?? { tokens: rate, at: now };
  bucket.tokens = Math.min(rate, bucket.tokens + ((now - bucket.at) / 1000) * rate);
  bucket.at = now;
  buckets.set(identity.keyId, bucket);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// --- logon attempts ------------------------------------------------------------

const MAX_FAILED_LOGONS = 10;
const LOGON_WINDOW_MS = 60_000;
const failures = new Map<string, { count: number; resetAt: number }>();

/** Programs on the exchange's own machine all arrive from the same address; one of them with a wrong key must not lock out the rest. */
const LOCAL = new Set(['unix', '127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** False while a remote address has had too many wrong keys in the last minute. */
export function logonAllowed(address: string, now = Date.now()): boolean {
  if (LOCAL.has(address)) return true;
  const entry = failures.get(address);
  if (!entry) return true;
  if (now >= entry.resetAt) {
    failures.delete(address);
    return true;
  }
  return entry.count < MAX_FAILED_LOGONS;
}

export function logonFailed(address: string, now = Date.now()): void {
  const entry = failures.get(address);
  if (!entry || now >= entry.resetAt) failures.set(address, { count: 1, resetAt: now + LOGON_WINDOW_MS });
  else entry.count += 1;
  if (failures.size > 10_000) for (const [key, value] of failures) if (now >= value.resetAt) failures.delete(key);
}

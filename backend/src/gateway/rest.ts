import { Router, type Request, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { shownDepth } from '../market/depth.js';
import { market } from '../market/marketData.js';
import { authenticate, type KeyIdentity } from './keys.service.js';
import { account, cancelOrder, GatewayReject, newOrder, openOrders, orderStatus, report } from './pipeline.js';
import type { RejectName } from './protocol.js';
import { logonAllowed, logonFailed } from './session.js';

/**
 * The gateway over plain HTTP, for programs that would rather make requests
 * than hold a connection open. Same API keys, same order pipeline, same
 * throttle as the WebSocket and binary gateways.
 *
 *   POST   /api/gateway/v1/orders            NewOrderSingle
 *   DELETE /api/gateway/v1/orders/:ref       OrderCancelRequest (ref = orderId or clOrdId)
 *   GET    /api/gateway/v1/orders/:ref       OrderStatus
 *   GET    /api/gateway/v1/orders            working orders
 *   GET    /api/gateway/v1/account           the sandbox account
 *   GET    /api/gateway/v1/marketdata/:symbol   best bid and offer, last trade, depth
 *   GET    /api/gateway/v1/session           who this key is and where it trades
 *
 * Send the key as `X-API-Key: gtk_...` or `Authorization: Bearer gtk_...`.
 */

const HTTP_STATUS: Record<RejectName, number> = {
  NOT_LOGGED_ON: 401,
  BAD_CREDENTIALS: 401,
  MALFORMED: 400,
  UNKNOWN_SYMBOL: 404,
  THROTTLED: 429,
  RISK: 422,
  UNKNOWN_ORDER: 404,
  TOO_LATE_TO_CANCEL: 409,
  DUPLICATE_CL_ORD_ID: 409,
  BUSY: 503,
  SANDBOX_CLOSED: 422,
  INTERNAL: 500,
};

const identities = new WeakMap<Request, KeyIdentity>();
const identityOf = (req: Request) => identities.get(req)!;

/** Runs a handler and turns a gateway refusal into the matching HTTP error, in the same shape the rest of the API uses. */
const route =
  (handler: (req: Request) => Promise<{ status?: number; body: unknown }>): RequestHandler =>
  async (req, res) => {
    try {
      const { status = 200, body } = await handler(req);
      res.status(status).json(body);
    } catch (err) {
      if (!(err instanceof GatewayReject)) throw err;
      res.status(HTTP_STATUS[err.reason]).json({ error: { code: err.reason, message: err.message } });
    }
  };

const requireKey: RequestHandler = async (req, res, next) => {
  const address = req.ip ?? 'unknown';
  const offered = String(req.headers['x-api-key'] ?? '') || String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!logonAllowed(address)) {
    res.status(429).json({ error: { code: 'BAD_CREDENTIALS', message: 'Too many requests with a bad API key from this address. Wait a minute.' } });
    return;
  }
  const identity = await authenticate(offered);
  if (!identity) {
    logonFailed(address);
    res.status(401).json({ error: { code: 'BAD_CREDENTIALS', message: 'Send a valid API key in the X-API-Key header.' } });
    return;
  }
  identities.set(req, identity);
  next();
};

/** A ceiling on everything a key does over HTTP. New orders are throttled separately, per key, across all transports. */
const requestLimiter = rateLimit({
  windowMs: 1000,
  limit: 500,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => identities.get(req)?.keyId ?? 'anonymous',
  message: { error: { code: 'THROTTLED', message: 'Too many requests. Slow down, or use the WebSocket gateway for streaming.' } },
});

const orderSchema = z.object({
  clOrdId: z.string().max(36).optional(),
  symbol: z.string(),
  side: z.enum(['BUY', 'SELL']),
  type: z.enum(['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT']),
  tif: z.enum(['GTC', 'IOC', 'FOK']).default('GTC'),
  qty: z.number(),
  price: z.number().nullish(),
  stopPrice: z.number().nullish(),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refOf = (req: Request) => {
  const ref = String(req.params.ref ?? '');
  return UUID.test(ref) ? { orderId: ref } : { clOrdId: ref };
};

export const gatewayRouter = Router()
  .use(requireKey, requestLimiter)
  .get(
    '/session',
    route(async (req) => {
      const { traderId, competitionId, competitionName, startingBalance, ordersPerSecond } = identityOf(req);
      return {
        body: {
          traderId,
          competition: { id: competitionId, name: competitionName, startingBalance },
          limits: { ordersPerSecond },
          // False between sessions: market data stands still and market orders are refused until the open.
          market: { open: market.inSession },
          serverTime: Date.now(),
        },
      };
    }),
  )
  .get('/account', route(async (req) => ({ body: { account: await account(identityOf(req)) } })))
  .get('/orders', route(async (req) => ({ body: { orders: await openOrders(identityOf(req)) } })))
  .post(
    '/orders',
    route(async (req) => {
      const parsed = orderSchema.safeParse(req.body);
      if (!parsed.success) throw new GatewayReject('MALFORMED', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
      const { tif, qty, ...order } = parsed.data;
      return { status: 201, body: { order: report(await newOrder(identityOf(req), { ...order, timeInForce: tif, quantity: qty })) } };
    }),
  )
  .get('/orders/:ref', route(async (req) => ({ body: { order: await orderStatus(identityOf(req), refOf(req)) } })))
  .delete('/orders/:ref', route(async (req) => ({ body: { order: report(await cancelOrder(identityOf(req), refOf(req))) } })))
  .get(
    '/marketdata/:symbol',
    route(async (req) => {
      const symbol = String(req.params.symbol ?? '').toUpperCase();
      const quote = await market.retain(symbol);
      if (!quote) throw new GatewayReject('UNKNOWN_SYMBOL', `${symbol} is not a tradable symbol here.`);
      const book = market.getDepth(symbol);
      market.release(symbol);
      const shown = book ? shownDepth(book) : null;
      return {
        body: {
          symbol,
          bbo: { bid: quote.bid, bidSize: quote.bidSize, ask: quote.ask, askSize: quote.askSize, ts: quote.ts },
          last: { price: quote.last, size: quote.lastSize ?? null },
          depth: shown ? { bids: shown.bids.map((l) => [l.price, l.size]), asks: shown.asks.map((l) => [l.price, l.size]) } : null,
        },
      };
    }),
  );

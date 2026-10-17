import { config } from '../config.js';
import { engine, type OrderEvent } from '../engine/matchingEngine.js';
import { logger } from '../lib/logger.js';
import { BinaryGateway } from './binaryGateway.js';
import { feed } from './feed.js';
import { keyEvents } from './keys.service.js';
import { reportsFor } from './pipeline.js';
import { pnlHook } from './pnlHook.js';
import { registry } from './session.js';
import { WsGateway } from './wsGateway.js';

/**
 * The bot gateway: how trading programs reach the exchange.
 *
 *            trading programs
 *      ┌───────────┬───────────┬────────────┐
 *      │ REST      │ WebSocket │ binary TCP │ binary Unix socket
 *      │ /api/gateway/v1       │ /gateway   │
 *      └─────┬─────┴─────┬─────┴──────┬─────┘
 *            │   API key → session    │           keys.service, session
 *            ▼                        ▼
 *      order pipeline: shape → throttle → risk → match        pipeline
 *            │                                    ▲
 *            ▼                                    │ quotes, fills
 *      matching engine ──order events──► execution reports to the owning sessions
 *            │                      └──► P&L hook → Redis leaderboard   pnlHook
 *            ▼
 *      market data hub: bbo / trades / depth pub-sub          feed
 *
 * Everything below the transports is shared, so an order is checked, matched,
 * reported and scored the same way whichever door it came in through, and the
 * same as an order a person places in the terminal.
 */
export interface BotGateway {
  ws: WsGateway;
  endpoints: { websocket: string; rest: string; tcp: string | null; unix: string | null };
  close(): Promise<void>;
}

/** Where the listeners are, for the admin console to show. Filled in once the gateway has started. */
export const gatewayEndpoints: BotGateway['endpoints'] = { websocket: '/gateway', rest: '/api/gateway/v1', tcp: null, unix: null };

export async function startBotGateway(): Promise<BotGateway> {
  const ws = new WsGateway();
  const binary = new BinaryGateway();

  // Every order event, whoever caused it, goes to the sessions of the account it belongs to.
  const onOrder = (event: OrderEvent) => {
    const sessions = registry.forAccount(event.userId, event.competitionId);
    if (sessions.length === 0) return;
    for (const execution of reportsFor(event)) for (const session of sessions) session.sendExecution(execution);
  };
  // A key that is moved, slowed, disabled or deleted loses its connections; the program logs on again into the new arrangement.
  const onKeyChanged = (keyId: string) => {
    for (const session of registry.forKey(keyId)) session.close('API key changed');
  };

  engine.on('order', onOrder);
  keyEvents.on('changed', onKeyChanged);
  feed.start();
  pnlHook.start();

  const bound = await binary.listen(config.gateway).catch((err) => {
    // The standard gateway still works without the low-latency listeners; say so rather than refuse to start.
    logger.error({ err: (err as Error).message }, 'The binary gateway could not start');
    return {} as { tcp?: string; unix?: string };
  });
  gatewayEndpoints.tcp = bound.tcp ?? null;
  gatewayEndpoints.unix = bound.unix ?? null;
  logger.info(`Bot gateway online (WebSocket /gateway, REST /api/gateway/v1${bound.tcp ? `, binary TCP ${bound.tcp}` : ''}${bound.unix ? `, binary Unix socket ${bound.unix}` : ''})`);

  return {
    ws,
    endpoints: gatewayEndpoints,
    async close() {
      engine.off('order', onOrder);
      keyEvents.off('changed', onKeyChanged);
      feed.stop();
      pnlHook.stop();
      await Promise.all([ws.close(), binary.close()]);
    },
  };
}

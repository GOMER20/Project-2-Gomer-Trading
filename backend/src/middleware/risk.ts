import { Decimal } from 'decimal.js';
import type { RequestHandler, Response } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { assertCompetitionOpen } from '../engine/account.js';
import { accountView } from '../engine/ledger.js';
import { engine, type NewOrder } from '../engine/matchingEngine.js';
import { bracketProblem, marketOrderPrice } from '../engine/pricing.js';
import { checkOrderRisk } from '../engine/risk.js';
import { notFound, orderRejected } from '../lib/errors.js';
import { market } from '../market/marketData.js';
import { SYMBOL_PATTERN } from '../types.js';
import { currentUser } from './auth.js';

const isWholeCents = (price: number) => Math.abs(price * 100 - Math.round(price * 100)) < 1e-6;

const priceField = (name: string) => z.number().positive().max(1_000_000).refine(isWholeCents, `${name} must be in whole cents`).nullish();

export const orderSchema = z
  .object({
    competitionId: z.uuid(),
    ticker: z.string().trim().toUpperCase().regex(SYMBOL_PATTERN, 'Invalid ticker symbol'),
    side: z.enum(['BUY', 'SELL']),
    type: z.enum(['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT']),
    quantity: z
      .number()
      .int('Quantity must be a whole number of shares')
      .positive('Quantity must be at least 1')
      .max(config.trading.maxOrderQuantity, `Quantity cannot exceed ${config.trading.maxOrderQuantity.toLocaleString('en-US')} shares`),
    limitPrice: priceField('Limit price'),
    stopPrice: priceField('Stop price'),
    // A bracket: exits placed automatically when this order fills.
    takeProfit: priceField('Take-profit price'),
    stopLoss: priceField('Stop-loss price'),
  })
  .superRefine((order, ctx) => {
    const issue = (path: 'limitPrice' | 'stopPrice', message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    const wantsLimit = order.type === 'LIMIT' || order.type === 'STOP_LIMIT';
    const wantsStop = order.type === 'STOP' || order.type === 'STOP_LIMIT';
    const name = order.type === 'STOP_LIMIT' ? 'stop-limit' : order.type.toLowerCase();

    if (wantsLimit && order.limitPrice == null) issue('limitPrice', `A ${name} order needs a limit price`);
    if (!wantsLimit && order.limitPrice != null) issue('limitPrice', `A ${name} order cannot carry a limit price`);
    if (wantsStop && order.stopPrice == null) issue('stopPrice', `A ${name} order needs a stop price`);
    if (!wantsStop && order.stopPrice != null) issue('stopPrice', `A ${name} order cannot carry a stop price`);

    // Once a stop-limit wakes up it must be able to trade: its limit cannot sit on the wrong side of its stop.
    if (order.type === 'STOP_LIMIT' && order.limitPrice != null && order.stopPrice != null) {
      if (order.side === 'BUY' && order.limitPrice < order.stopPrice) issue('limitPrice', 'For a buy stop-limit the limit price must be at or above the stop price');
      if (order.side === 'SELL' && order.limitPrice > order.stopPrice) issue('limitPrice', 'For a sell stop-limit the limit price must be at or below the stop price');
    }
  });

/** The validated order placed on res.locals by riskCheck for the controller to submit. */
export const approvedOrder = (res: Response): NewOrder => res.locals.order as NewOrder;

/**
 * Pre-trade risk gate. Sits between authentication and the matching engine and
 * refuses any order that:
 *   - is for a competition the trader is not in, or that is not running
 *   - names a symbol with no live quote (market orders also need a fresh one)
 *   - is a stop or stop-limit order whose prices do not make sense together
 *   - carries a bracket whose exits are on the wrong side of the entry, or
 *     that would reduce a position instead of opening or adding to one
 *   - would sell more shares than are held, where shorting is disabled
 *   - needs more buying power than the account has available
 *
 * Passing here is necessary but not sufficient: the engine repeats the
 * balance checks at the instant it books the order, with nothing able to
 * run in between, which is what makes them race-free.
 */
export const riskCheck: RequestHandler = async (req, res, next) => {
  const user = currentUser(req);
  const body = orderSchema.parse(req.body);
  const limitPrice = body.limitPrice ?? null;
  const stopPrice = body.stopPrice ?? null;
  const takeProfit = body.takeProfit ?? null;
  const stopLoss = body.stopLoss ?? null;

  // Read from the engine's own memory: no database on the way to placing an order.
  const live = await engine.accountFor(user.id, body.competitionId);
  if (!live) throw notFound('You do not have a portfolio in this competition.');
  const account = accountView(live);
  const portfolioId = account.portfolio.id;

  // Hold the symbol only for the duration of the check. A rejected order must
  // not leave a permanent upstream subscription behind.
  const quote = await market.retain(body.ticker);
  if (!quote) throw orderRejected(`${body.ticker} is not a tradable symbol on the ${market.providerName} feed.`);
  try {
    assertCompetitionOpen(account.rules);

    // The worst price the order could execute at, which is what buying power is checked against.
    let referencePrice: Decimal;
    if (limitPrice !== null) {
      referencePrice = new Decimal(limitPrice);
    } else if (stopPrice !== null) {
      referencePrice = new Decimal(stopPrice).plus(body.side === 'BUY' ? config.trading.slippagePerShare : 0);
    } else {
      if (!market.tradable(quote)) throw orderRejected(market.whyNotTradable(body.ticker));
      const price = marketOrderPrice(body.side, quote, config.trading.slippagePerShare);
      if (!price) throw orderRejected(`${body.ticker} has no ${body.side === 'BUY' ? 'offer' : 'bid'} to trade against.`);
      referencePrice = price;
    }

    if (takeProfit !== null || stopLoss !== null) {
      const problem = bracketProblem(body.side, (limitPrice ?? stopPrice ?? referencePrice.toNumber()), takeProfit, stopLoss);
      if (problem) throw orderRejected(problem);
      const held = account.positions.get(body.ticker)?.quantity ?? 0;
      if (body.side === 'BUY' ? held < 0 : held > 0) {
        throw orderRejected('A bracket belongs on an order that opens or adds to a position. This order would reduce one; send it without a take-profit or stop-loss.');
      }
    }

    const decision = checkOrderRisk({
      cash: new Decimal(account.portfolio.cash),
      leverage: account.rules.leverage,
      allowShorting: account.rules.allowShorting,
      positions: account.positions,
      markOf: (ticker) => market.getMark(ticker),
      workingOrders: account.workingOrders,
      commissionPerShare: account.rules.commissionPerShare,
      order: { ticker: body.ticker, side: body.side, quantity: body.quantity, price: referencePrice },
    });
    if (!decision.ok) throw orderRejected(decision.reason);

    // Approved: from here on the symbol must keep streaming so the order can
    // be matched and the resulting position marked to market.
    await market.pin(body.ticker);
  } finally {
    market.release(body.ticker);
  }

  const order: NewOrder = {
    userId: user.id,
    portfolioId,
    ticker: body.ticker,
    side: body.side,
    type: body.type,
    quantity: body.quantity,
    limitPrice,
    stopPrice,
    takeProfit,
    stopLoss,
  };
  res.locals.order = order;
  next();
};

import { Decimal } from 'decimal.js';
import type { OrderSide, Quote } from '../types.js';

/**
 * Level 2: the order book behind the best bid and offer.
 *
 * The price feeds this platform can use carry only the top of the book (one
 * bid, one ask, and their sizes). The levels behind it are MODELLED here from
 * that quote: a price every cent away from the touch, with sizes that grow
 * with distance and vary from level to level. They are an estimate of how much
 * a large order would move the price, not the exchange's real book.
 *
 * What makes the model matter is that orders trade against it. An order takes
 * the shares shown at each level in turn, so a large order fills in pieces at
 * worse and worse prices, and what it took stays gone for a few seconds.
 */

export interface Level {
  price: number;
  /** Shares available at this price. */
  size: number;
}

export interface DepthBook {
  symbol: string;
  /** Best first: bids descending, asks ascending. */
  bids: Level[];
  asks: Level[];
  ts: number;
}

/** Levels shown, and the most an order can take in one go. */
export const DEPTH_LEVELS = 10;
const TICK_CENTS = 1;
/** Sizes hold still for this long before the modelled levels are redrawn. */
const RESHUFFLE_MS = 20_000;
/** Liquidity an order has taken comes back with this half-life. */
const REPLENISH_HALF_LIFE_MS = 4_000;

/** A stable pseudo-random number in [0, 1) for a string. The same level gets the same size until the next reshuffle. */
function noise(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10_000) / 10_000;
}

const roundLot = (shares: number) => Math.max(100, Math.round(shares / 100) * 100);

/**
 * Some feeds quote size in round lots, others in shares. A displayed size under
 * 100 is read as lots, since the national best bid and offer exclude odd lots.
 */
const topSize = (size: number) => (size <= 0 ? 0 : size < 100 ? size * 100 : size);

/** One side of the book, before anything has been taken from it. */
function side(symbol: string, which: 'bid' | 'ask', touchPrice: number, touchSize: number, typical: number, now: number): Level[] {
  if (touchPrice <= 0 || touchSize <= 0) return [];
  const touchCents = Math.round(touchPrice * 100);
  const away = which === 'ask' ? TICK_CENTS : -TICK_CENTS;
  const era = Math.floor(now / RESHUFFLE_MS);
  const levels: Level[] = [{ price: touchCents / 100, size: touchSize }];
  for (let i = 1; i < DEPTH_LEVELS; i++) {
    const cents = touchCents + away * i;
    if (cents <= 0) break;
    // Thicker further from the touch, and uneven the way a real book is.
    const variation = 0.5 + 1.1 * noise(`${symbol}|${which}|${cents}|${era}`);
    levels.push({ price: cents / 100, size: roundLot(typical * (0.8 + 0.22 * i) * variation) });
  }
  return levels;
}

/** Removes `taken` shares from the front of a side, as orders that came before would have. */
function deplete(levels: Level[], taken: number): Level[] {
  if (taken <= 0) return levels;
  let left = Math.round(taken);
  return levels.map((level) => {
    const used = Math.min(level.size, left);
    left -= used;
    return { price: level.price, size: level.size - used };
  });
}

/** Builds the book for a quote. `taken` is liquidity recently consumed on each side. */
export function buildBook(quote: Pick<Quote, 'symbol' | 'bid' | 'ask' | 'bidSize' | 'askSize'>, taken: { bids: number; asks: number } = { bids: 0, asks: 0 }, now = Date.now()): DepthBook {
  const bidSize = topSize(quote.bidSize);
  const askSize = topSize(quote.askSize);
  const typical = roundLot((bidSize + askSize) / 2 || 100);
  return {
    symbol: quote.symbol,
    bids: deplete(side(quote.symbol, 'bid', quote.bid, bidSize, typical, now), taken.bids),
    asks: deplete(side(quote.symbol, 'ask', quote.ask, askSize, typical, now), taken.asks),
    ts: now,
  };
}

/** The book as it is shown: levels an order has emptied are gone until they refill. */
export function shownDepth(book: DepthBook): DepthBook {
  return { ...book, bids: book.bids.filter((level) => level.size > 0), asks: book.asks.filter((level) => level.size > 0) };
}

export interface Piece {
  price: Decimal;
  quantity: number;
}

/**
 * What an order that TAKES liquidity gets right now: it trades through the
 * other side of the book level by level, paying `slippage` a share on top,
 * until it is done, the book runs out, or the next level is beyond its limit.
 * The pieces are in the order they trade.
 */
export function takeLiquidity(orderSide: OrderSide, quantity: number, limit: Decimal | null, book: DepthBook, slippage: number): Piece[] {
  const levels = orderSide === 'BUY' ? book.asks : book.bids;
  const pieces: Piece[] = [];
  let left = quantity;
  for (const level of levels) {
    if (left <= 0) break;
    if (limit !== null && (orderSide === 'BUY' ? limit.lt(level.price) : limit.gt(level.price))) break;
    if (level.size <= 0) continue;
    const worse = orderSide === 'BUY' ? new Decimal(level.price).plus(slippage) : new Decimal(level.price).minus(slippage);
    // Slippage never carries a limit order past its own limit.
    const price = limit === null ? worse : orderSide === 'BUY' ? Decimal.min(worse, limit) : Decimal.max(worse, limit);
    if (price.lte(0)) break;
    const shares = Math.min(left, level.size);
    const last = pieces.at(-1);
    if (last && last.price.eq(price)) last.quantity += shares;
    else pieces.push({ price, quantity: shares });
    left -= shares;
  }
  return pieces;
}

/**
 * What a RESTING limit order gets when the market comes to it: as many shares
 * as the other side is offering at its price or better, all at its own price.
 */
export function provideLiquidity(orderSide: OrderSide, quantity: number, limit: Decimal, book: DepthBook): Piece[] {
  const levels = orderSide === 'BUY' ? book.asks : book.bids;
  let offered = 0;
  for (const level of levels) {
    if (orderSide === 'BUY' ? limit.lt(level.price) : limit.gt(level.price)) break;
    offered += level.size;
  }
  const shares = Math.min(quantity, offered);
  return shares > 0 ? [{ price: limit, quantity: shares }] : [];
}

export const sharesIn = (pieces: Piece[]) => pieces.reduce((sum, piece) => sum + piece.quantity, 0);

/** The average price of some pieces, weighted by size. */
export function averagePrice(pieces: Piece[]): Decimal {
  const shares = sharesIn(pieces);
  return shares === 0 ? new Decimal(0) : pieces.reduce((sum, piece) => sum.plus(piece.price.mul(piece.quantity)), new Decimal(0)).div(shares);
}

/**
 * Remembers what orders have taken from each side of each book, fading it out
 * over a few seconds. Without it a large order could be sliced into small ones
 * that each see a full top of book.
 */
export class LiquidityLedger {
  private readonly taken = new Map<string, { bids: number; asks: number; at: number }>();

  /** Shares still missing from each side of a symbol's book. */
  outstanding(symbol: string, now = Date.now()): { bids: number; asks: number } {
    const entry = this.taken.get(symbol);
    if (!entry) return { bids: 0, asks: 0 };
    const remaining = 0.5 ** ((now - entry.at) / REPLENISH_HALF_LIFE_MS);
    const bids = entry.bids * remaining;
    const asks = entry.asks * remaining;
    if (bids < 1 && asks < 1) {
      this.taken.delete(symbol);
      return { bids: 0, asks: 0 };
    }
    return { bids, asks };
  }

  /** Records shares traded: a buy takes from the asks, a sell from the bids. */
  consume(symbol: string, orderSide: OrderSide, shares: number, now = Date.now()): void {
    const current = this.outstanding(symbol, now);
    this.taken.set(symbol, {
      bids: current.bids + (orderSide === 'SELL' ? shares : 0),
      asks: current.asks + (orderSide === 'BUY' ? shares : 0),
      at: now,
    });
  }
}

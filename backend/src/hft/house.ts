import type { Quote } from '../types.js';
import type { HftBook, HftLevel } from './hftClient.js';

/**
 * How Gomer Trading's market is described to HFT.
 *
 * HFT is an order book: it matches orders against other orders and has no
 * prices of its own. The market's side of every trade, "the house", therefore
 * has to be put into the book as orders. For each symbol the server tells HFT
 * what the house should be bidding and offering (a ladder of prices and sizes
 * built from the live quote), and HFT keeps real orders resting to match.
 *
 * Prices are whole cents on the way to HFT.
 */

/** Levels of bids, and of offers, that the house shows in each symbol. */
export const HOUSE_LEVELS = 10;

/** The most prices one HFT book can hold. */
const MAX_BOOK_LEVELS = 262_144;
/** A book for a symbol whose price is not known yet reaches this far, in dollars. */
const DEFAULT_REACH_DOLLARS = 1_000;
/** Orders that can rest in one book at once: the house's ladder and every trader's working orders. */
const BOOK_CAPACITY = 4_096;

export const toCents = (dollars: number): number => Math.round(dollars * 100);

/**
 * The book HFT should run for a symbol last seen at `price` dollars (0 if not
 * known). It takes every price from one cent up to two and a half times that
 * price, and never less than $200: a book's range is fixed when it is made,
 * and a price that left it would have every order refused. Each cent of range
 * costs 32 bytes, which is why it is not simply made enormous.
 */
export function bookFor(symbol: string, price: number): HftBook {
  const reach = price > 0 ? Math.max(price * 2.5, 200) : DEFAULT_REACH_DOLLARS;
  return { symbol, minPrice: 1, numLevels: Math.min(MAX_BOOK_LEVELS, Math.ceil(reach * 100)), maxOrders: BOOK_CAPACITY };
}

/** Whether a price in cents is one the book takes. */
export const inBook = (book: HftBook, cents: number): boolean => cents >= book.minPrice && cents < book.minPrice + book.numLevels;

/**
 * Some feeds quote size in round lots, others in shares. A displayed size under
 * 100 is read as lots, as market/depth.ts reads it; no size at all becomes one lot.
 */
const touchSize = (size: number): number => (size <= 0 ? 100 : size < 100 ? Math.round(size) * 100 : Math.round(size));

/**
 * How many shares the house shows at a price behind the touch: between 200 and
 * 1,500, in round lots. It depends on nothing but the symbol, the side and the
 * price. A level therefore keeps its size while the market moves around it, as
 * resting orders do, and a one-cent move changes one level at each end of the
 * ladder instead of all twenty. That matters because every change is an order
 * placed or cancelled in HFT, and recorded.
 */
export function houseSize(symbol: string, side: 'bid' | 'ask', cents: number): number {
  let hash = 2166136261;
  const key = `${symbol}|${side}|${cents}`;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 100 * (2 + ((hash >>> 0) % 14));
}

export interface HouseQuote {
  /** Best first: highest bid, then lower. */
  bids: HftLevel[];
  /** Best first: lowest offer, then higher. */
  asks: HftLevel[];
}

/**
 * What the house should be bidding and offering for a quote: the quote's own
 * best bid and offer at the sizes it shows, and nine more levels a cent apart
 * behind each. Null if the quote cannot be turned into a market: a side
 * missing, or the bid not below the offer.
 */
export function houseQuote(quote: Pick<Quote, 'symbol' | 'bid' | 'ask' | 'bidSize' | 'askSize'>, book: HftBook): HouseQuote | null {
  const bid = toCents(quote.bid);
  const ask = toCents(quote.ask);
  if (!(quote.bid > 0) || !(quote.ask > 0) || bid >= ask) return null;

  const bids: HftLevel[] = [];
  const asks: HftLevel[] = [];
  for (let level = 0; level < HOUSE_LEVELS; level++) {
    const bidPrice = bid - level;
    if (inBook(book, bidPrice)) bids.push({ price: bidPrice, quantity: level === 0 ? touchSize(quote.bidSize) : houseSize(quote.symbol, 'bid', bidPrice) });
    const askPrice = ask + level;
    if (inBook(book, askPrice)) asks.push({ price: askPrice, quantity: level === 0 ? touchSize(quote.askSize) : houseSize(quote.symbol, 'ask', askPrice) });
  }
  return { bids, asks };
}

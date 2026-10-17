import type { Quote } from '../types.js';

/** Price used to value a position: last trade, or the midpoint when no trade has printed. */
export function markPrice(quote: Pick<Quote, 'bid' | 'ask' | 'last'>): number {
  if (quote.last > 0) return quote.last;
  return quote.bid > 0 && quote.ask > 0 ? (quote.bid + quote.ask) / 2 : 0;
}

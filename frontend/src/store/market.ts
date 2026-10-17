'use client';

import { create } from 'zustand';
import type { Depth, FeedHealth, MarketHours, Quote } from '@/lib/types';

export type FeedStatus = 'offline' | 'connecting' | 'live' | 'reconnecting';

interface MarketState {
  quotes: Record<string, Quote>;
  status: FeedStatus;
  /** 'alpaca' or 'simulated', as reported by the server. */
  provider: string | null;
  /** Whether the server itself is receiving prices from its provider. */
  feed: FeedHealth | null;
  /** Symbols the feed has no data for. */
  unknown: Record<string, true>;
  /** When the US stock market is open; refreshed once a minute. */
  hours: MarketHours | null;
  /** The Level 2 book for the symbol on screen. */
  depth: Depth | null;
  setDepth: (depth: Depth | null) => void;
  setHours: (hours: MarketHours) => void;
  applyQuotes: (batch: Quote[]) => void;
  setStatus: (status: FeedStatus, provider?: string) => void;
  setFeed: (feed: FeedHealth | null) => void;
  markUnknown: (symbol: string) => void;
}

/**
 * Live Level 1 quotes keyed by symbol. Components select a single symbol
 * (`useMarketStore((s) => s.quotes[symbol])`) so a tick re-renders only the
 * rows showing that symbol.
 */
export const useMarketStore = create<MarketState>((set) => ({
  quotes: {},
  status: 'offline',
  provider: null,
  feed: null,
  unknown: {},
  hours: null,
  setHours: (hours) => set({ hours }),
  depth: null,
  setDepth: (depth) => set({ depth }),
  applyQuotes: (batch) =>
    set((state) => {
      const quotes = { ...state.quotes };
      for (const quote of batch) quotes[quote.symbol] = quote;
      return { quotes };
    }),
  setStatus: (status, provider) => set((state) => ({ status, provider: provider ?? state.provider })),
  setFeed: (feed) => set({ feed }),
  markUnknown: (symbol) => set((state) => ({ unknown: { ...state.unknown, [symbol]: true } })),
}));

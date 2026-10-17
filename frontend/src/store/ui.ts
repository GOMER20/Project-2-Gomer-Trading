'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Timeframe } from '@/lib/types';

const DEFAULT_WATCHLIST = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'META', 'AMD', 'SPY', 'QQQ'];

interface UiState {
  competitionId: string | null;
  symbol: string;
  watchlist: string[];
  timeframe: Timeframe;
  /** Chart overlays. */
  indicators: { ema9: boolean; ema20: boolean; vwap: boolean };
  /** Keyboard order entry. Off until the trader arms it. */
  hotkeys: boolean;
  /** What the panel under the watchlist shows. */
  marketPanel: 'depth' | 'tape';
  setMarketPanel: (panel: 'depth' | 'tape') => void;
  setCompetition: (competitionId: string | null) => void;
  setSymbol: (symbol: string) => void;
  addToWatchlist: (symbol: string) => void;
  removeFromWatchlist: (symbol: string) => void;
  setTimeframe: (timeframe: Timeframe) => void;
  toggleIndicator: (name: 'ema9' | 'ema20' | 'vwap') => void;
  setHotkeys: (armed: boolean) => void;
}

/** Workspace preferences, remembered per browser. */
export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      competitionId: null,
      symbol: DEFAULT_WATCHLIST[0]!,
      watchlist: DEFAULT_WATCHLIST,
      timeframe: '1Min',
      indicators: { ema9: false, ema20: true, vwap: true },
      hotkeys: false,
      marketPanel: 'depth',
      setMarketPanel: (marketPanel) => set({ marketPanel }),
      setCompetition: (competitionId) => set({ competitionId }),
      setSymbol: (symbol) => set({ symbol }),
      addToWatchlist: (symbol) =>
        set((state) => (state.watchlist.includes(symbol) ? state : { watchlist: [...state.watchlist, symbol] })),
      removeFromWatchlist: (symbol) => set((state) => ({ watchlist: state.watchlist.filter((s) => s !== symbol) })),
      setTimeframe: (timeframe) => set({ timeframe }),
      toggleIndicator: (name) => set((state) => ({ indicators: { ...state.indicators, [name]: !state.indicators[name] } })),
      setHotkeys: (hotkeys) => set({ hotkeys }),
    }),
    // Settings added later take their defaults when an older saved workspace is loaded.
    { name: 'gomer.workspace', version: 1, merge: (saved, current) => ({ ...current, ...(saved as object) }) },
  ),
);

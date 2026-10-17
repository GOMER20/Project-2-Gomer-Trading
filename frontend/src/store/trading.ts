'use client';

import { create } from 'zustand';
import { api } from '@/lib/api';
import { price, shares, signedUsd } from '@/lib/format';
import type { Competition, CompetitionResults, Execution, Leaderboard, NewOrder, Order, Portfolio } from '@/lib/types';
import { useUiStore } from './ui';

export interface Toast {
  id: number;
  tone: 'up' | 'down' | 'info' | 'warn';
  title: string;
  detail?: string;
}

interface TradingState {
  competitions: Competition[];
  competitionsLoaded: boolean;
  portfolio: Portfolio | null;
  orders: Order[];
  /** Every piece that has traded, newest first. Loaded when the Fills tab asks for it. */
  executions: Execution[];
  leaderboard: Leaderboard | null;
  /** Full standings with every trader's record; names the winner once the competition is final. */
  results: CompetitionResults | null;
  toasts: Toast[];

  loadCompetitions: () => Promise<void>;
  refreshPortfolio: (competitionId: string) => Promise<void>;
  refreshOrders: (competitionId: string) => Promise<void>;
  refreshExecutions: (competitionId: string) => Promise<void>;
  refreshLeaderboard: (competitionId: string) => Promise<void>;
  refreshResults: (competitionId: string) => Promise<void>;
  placeOrder: (order: NewOrder) => Promise<Order>;
  cancelOrder: (orderId: string) => Promise<void>;

  /** An order update pushed by the server (fills of resting orders arrive this way). */
  onOrderEvent: (competitionId: string, order: Order) => void;
  setLeaderboard: (board: Leaderboard) => void;
  toast: (toast: Omit<Toast, 'id'>) => void;
  dismissToast: (id: number) => void;
  /** Clears everything that belongs to one competition. */
  clearAccount: () => void;
  reset: () => void;
}

export const ORDER_TYPE_NAMES = { MARKET: 'Market', LIMIT: 'Limit', STOP: 'Stop', STOP_LIMIT: 'Stop-limit' } as const;

let nextToastId = 1;
const isCurrent = (competitionId: string) => useUiStore.getState().competitionId === competitionId;
/**
 * Puts an order into the list, replacing what was known about it. An order
 * that fills in pieces is reported many times, by push and in replies, and the
 * reports can arrive out of order: one that knows of fewer fills is older.
 */
const upsert = (orders: Order[], order: Order) =>
  orders.some((o) => o.id === order.id) ? orders.map((o) => (o.id === order.id && o.filledQuantity <= order.filledQuantity ? order : o)) : [order, ...orders];

/** A burst of fills asks for one portfolio refresh, not one each. */
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function refreshSoon(competitionId: string, refresh: (competitionId: string) => Promise<void>): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refresh(competitionId).catch(() => undefined);
  }, 250);
}

/** "limit 231.50", "stop 229.00", "stop 229.00 limit 228.50": the prices an order is working at. */
export function workingAt(order: Pick<Order, 'limitPrice' | 'stopPrice' | 'triggeredAt'>): string {
  const parts: string[] = [];
  if (order.stopPrice !== null && !order.triggeredAt) parts.push(`stop ${price(order.stopPrice)}`);
  if (order.limitPrice !== null) parts.push(`limit ${price(order.limitPrice)}`);
  // No prices at all: a market order that the book could not fill in one go.
  return parts.join(' ') || 'at the market';
}

/** For a bracket exit, which of the two it is. Null for any other order. */
export const exitKind = (order: Pick<Order, 'parentId' | 'type'>): 'Target' | 'Stop-loss' | null => (order.parentId === null ? null : order.type === 'LIMIT' ? 'Target' : 'Stop-loss');

function describe(order: Order): Omit<Toast, 'id'> | null {
  const what = `${order.side} ${shares(order.quantity)} ${order.ticker}`;
  const exit = exitKind(order);
  if (order.forcedBy === 'MARGIN_CALL') {
    if (order.filledQuantity === 0) return null;
    return {
      tone: 'down',
      title: `Margin call: ${order.side === 'SELL' ? 'sold' : 'bought back'} ${shares(order.filledQuantity)} ${order.ticker} @ ${price(order.fillPrice)}`,
      detail: 'Your equity fell below the maintenance margin, so the position was closed at the market.',
    };
  }
  switch (order.status) {
    case 'FILLED': {
      const pnl = order.realizedPnl ? ` · realized ${signedUsd(order.realizedPnl)}` : '';
      if (exit) return { tone: order.side === 'BUY' ? 'up' : 'down', title: `${exit} hit: ${what} @ ${price(order.fillPrice)}`, detail: `bracket exit${pnl}` };
      return { tone: order.side === 'BUY' ? 'up' : 'down', title: `Filled: ${what} @ ${price(order.fillPrice)}`, detail: `${ORDER_TYPE_NAMES[order.type].toLowerCase()} order${pnl}` };
    }
    case 'REJECTED':
      return { tone: 'warn', title: `Rejected: ${what}`, detail: order.rejectReason ?? undefined };
    case 'CANCELLED':
      return {
        tone: 'info',
        title: `Cancelled: ${what}, ${workingAt(order)}`,
        detail: [order.filledQuantity > 0 ? `${shares(order.filledQuantity)} had filled @ ${price(order.fillPrice)}` : null, order.rejectReason].filter(Boolean).join(' · ') || undefined,
      };
    case 'OPEN':
      if (order.filledQuantity > 0) {
        return { tone: order.side === 'BUY' ? 'up' : 'down', title: `Part filled: ${order.side} ${shares(order.filledQuantity)} of ${shares(order.quantity)} ${order.ticker} @ ${price(order.fillPrice)}`, detail: 'the rest is working' };
      }
      return order.triggeredAt
        ? { tone: 'info', title: `Stop reached: ${what}`, detail: `now working at ${workingAt(order)}` }
        : exit
          ? null // the entry's own message already says its exits are working
          : { tone: 'info', title: `Working: ${what}, ${workingAt(order)}`, detail: `${ORDER_TYPE_NAMES[order.type].toLowerCase()} order` };
  }
}

export const useTradingStore = create<TradingState>((set, get) => ({
  competitions: [],
  competitionsLoaded: false,
  portfolio: null,
  orders: [],
  executions: [],
  leaderboard: null,
  results: null,
  toasts: [],

  loadCompetitions: async () => {
    const { competitions } = await api<{ competitions: Competition[] }>('/api/competitions');
    set({ competitions, competitionsLoaded: true });

    // Keep the remembered competition if it is still tradable here; otherwise pick the best one.
    const ui = useUiStore.getState();
    const enrolled = competitions.filter((c) => c.enrolled);
    if (!enrolled.some((c) => c.id === ui.competitionId)) {
      const pick = enrolled.find((c) => c.status === 'ACTIVE') ?? enrolled.find((c) => c.status === 'UPCOMING') ?? enrolled[0];
      ui.setCompetition(pick?.id ?? null);
    }
  },

  refreshPortfolio: async (competitionId) => {
    const { portfolio } = await api<{ portfolio: Portfolio }>(`/api/portfolios/${competitionId}`);
    if (isCurrent(competitionId)) set({ portfolio });
  },

  refreshOrders: async (competitionId) => {
    const { orders } = await api<{ orders: Order[] }>(`/api/portfolios/${competitionId}/orders?limit=200`);
    if (isCurrent(competitionId)) set({ orders });
  },

  refreshExecutions: async (competitionId) => {
    const { executions } = await api<{ executions: Execution[] }>(`/api/portfolios/${competitionId}/executions?limit=300`);
    if (isCurrent(competitionId)) set({ executions });
  },

  refreshLeaderboard: async (competitionId) => {
    const leaderboard = await api<Leaderboard>(`/api/competitions/${competitionId}/leaderboard`);
    if (isCurrent(competitionId)) set({ leaderboard });
  },

  refreshResults: async (competitionId) => {
    const results = await api<CompetitionResults>(`/api/competitions/${competitionId}/results`);
    if (isCurrent(competitionId)) set({ results });
  },

  placeOrder: async (order) => {
    const { order: placed } = await api<{ order: Order }>('/api/orders', { method: 'POST', body: order });
    if (isCurrent(order.competitionId)) {
      set((state) => ({ orders: upsert(state.orders, placed) }));
      void get().refreshPortfolio(order.competitionId);
    }
    return placed;
  },

  cancelOrder: async (orderId) => {
    const { order } = await api<{ order: Order }>(`/api/orders/${orderId}`, { method: 'DELETE' });
    set((state) => ({ orders: upsert(state.orders, order) }));
  },

  onOrderEvent: (competitionId, order) => {
    if (!isCurrent(competitionId)) return;
    const previous = get().orders.find((o) => o.id === order.id);
    set((state) => ({ orders: upsert(state.orders, order) }));
    // The REST response and the push can both describe the same transition; announce it once.
    // An order filling in pieces is announced at its first piece and when it is done, not at every piece.
    const firstPiece = (previous?.filledQuantity ?? 0) === 0 && order.filledQuantity > 0;
    const liquidation = order.forcedBy !== null && order.filledQuantity > (previous?.filledQuantity ?? 0);
    if (previous?.status !== order.status || previous?.triggeredAt !== order.triggeredAt || (firstPiece && previous !== undefined) || liquidation) {
      const toast = describe(order);
      if (toast) get().toast(toast);
    }
    refreshSoon(competitionId, get().refreshPortfolio);
  },

  setLeaderboard: (board) => {
    if (isCurrent(board.competitionId)) set({ leaderboard: board });
  },

  toast: (toast) => {
    const id = nextToastId++;
    set((state) => ({ toasts: [...state.toasts.slice(-3), { ...toast, id }] }));
    setTimeout(() => get().dismissToast(id), 6_000);
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  clearAccount: () => set({ portfolio: null, orders: [], executions: [], leaderboard: null, results: null }),

  reset: () => set({ competitions: [], competitionsLoaded: false, portfolio: null, orders: [], executions: [], leaderboard: null, results: null, toasts: [] }),
}));

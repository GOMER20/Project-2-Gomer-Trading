'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** A price to be told about: when the stock rises to it (above) or falls to it (below). */
export interface PriceAlert {
  id: string;
  /** Alerts belong to the trader who set them; one browser can be used by more than one. */
  traderId: string;
  symbol: string;
  direction: 'above' | 'below';
  price: number;
  createdAt: string;
  triggeredAt: string | null;
  /** The price it was reached at. */
  triggeredPrice: number | null;
}

interface AlertState {
  /** A chime when an order fills and when a price alert goes off. */
  sound: boolean;
  /** A system notification for the same, when the app is not in front. */
  popups: boolean;
  priceAlerts: PriceAlert[];
  setSound: (on: boolean) => void;
  setPopups: (on: boolean) => void;
  addPriceAlert: (alert: Omit<PriceAlert, 'id' | 'createdAt' | 'triggeredAt' | 'triggeredPrice'>) => void;
  removePriceAlert: (id: string) => void;
  triggerPriceAlert: (id: string, price: number) => void;
}

/** Alert preferences and price alerts, remembered per browser (and per trader within it). */
export const useAlertStore = create<AlertState>()(
  persist(
    (set) => ({
      sound: true,
      popups: true,
      priceAlerts: [],
      setSound: (sound) => set({ sound }),
      setPopups: (popups) => set({ popups }),
      addPriceAlert: (alert) =>
        set((state) => ({
          priceAlerts: [...state.priceAlerts, { ...alert, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, createdAt: new Date().toISOString(), triggeredAt: null, triggeredPrice: null }],
        })),
      removePriceAlert: (id) => set((state) => ({ priceAlerts: state.priceAlerts.filter((a) => a.id !== id) })),
      triggerPriceAlert: (id, price) =>
        set((state) => ({ priceAlerts: state.priceAlerts.map((a) => (a.id === id && !a.triggeredAt ? { ...a, triggeredAt: new Date().toISOString(), triggeredPrice: price } : a)) })),
    }),
    { name: 'gomer.alerts' },
  ),
);

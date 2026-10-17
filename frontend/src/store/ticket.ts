import { create } from 'zustand';

interface TicketState {
  /** A price clicked somewhere on screen (the Level 2 ladder) for the order ticket to pick up. */
  picked: { price: number; nonce: number } | null;
  pick: (price: number) => void;
}

/** Carries a clicked price to the order ticket. Not remembered between visits. */
export const useTicketStore = create<TicketState>((set) => ({
  picked: null,
  // The nonce makes clicking the same price twice count as two clicks.
  pick: (price) => set((state) => ({ picked: { price, nonce: (state.picked?.nonce ?? 0) + 1 } })),
}));

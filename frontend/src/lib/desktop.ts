import type { User } from './types';

/**
 * API injected by the Gomer desktop app's preload script. Undefined in a
 * normal browser.
 */
export interface DesktopBridge {
  /**
   * Signs in as one of the accounts the app created on first launch. The app
   * performs the login itself, so the password never reaches the page.
   */
  signIn(account: 'trader' | 'admin'): Promise<{ token: string; user: User }>;
  /** Opens the app's Market Data settings, where live price keys are entered. */
  openMarketData(): void;
  /** Whether this Mac is letting other people connect, and the addresses they would use. */
  /** Where other people can reach this Mac. The public internet link, when there is one, comes first. */
  hosting(): Promise<{
    enabled: boolean;
    addresses: string[];
    internet?: { enabled: boolean; state: 'off' | 'starting' | 'waiting' | 'online' | 'failed'; url: string | null; permanent?: boolean };
  }>;
  /** Opens the app's hosting switch. */
  openHosting(): void;
  /** Opens (or brings forward) the AT or HFT window. Missing in app versions from before those windows. */
  openWindow?(name: 'at' | 'hft'): void;
  /** Shows a system notification. Missing in app versions from before alerts. */
  notify?(title: string, body: string): void;
}

declare global {
  interface Window {
    gomerDesktop?: DesktopBridge;
  }
}

export const desktopBridge = (): DesktopBridge | undefined => (typeof window === 'undefined' ? undefined : window.gomerDesktop);

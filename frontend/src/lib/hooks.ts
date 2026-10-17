'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';

const noop = () => () => {};

/**
 * False on the server and during hydration, true afterwards. Anything that
 * reads localStorage-backed stores renders behind this so the first client
 * render matches the server HTML.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

/** Current time, re-rendering the caller every `intervalMs`. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Returns 'flash-up' / 'flash-down' after `value` rises or falls. The key
 * changes on every tick; use it as the element's React key so the CSS
 * animation restarts.
 */
export function useTickFlash(value: number | undefined): { className: string; key: number } {
  const [previous, setPrevious] = useState(value);
  const [flash, setFlash] = useState({ className: '', key: 0 });
  // Deriving state during render: React re-renders immediately, before painting.
  if (value !== previous) {
    setPrevious(value);
    if (value !== undefined && previous !== undefined) {
      setFlash({ className: value > previous ? 'flash-up' : 'flash-down', key: flash.key + 1 });
    }
  }
  return flash;
}

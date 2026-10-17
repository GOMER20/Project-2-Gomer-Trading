'use client';

import { useTradingStore } from '@/store/trading';

const TONE = {
  up: 'border-l-up',
  down: 'border-l-down',
  info: 'border-l-info',
  warn: 'border-l-accent',
} as const;

/** Fill, reject and cancel notifications, bottom right. */
export function Toasts() {
  const toasts = useTradingStore((s) => s.toasts);
  const dismiss = useTradingStore((s) => s.dismissToast);

  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-3 right-3 z-50 flex w-80 max-w-[calc(100vw-1.5rem)] flex-col gap-2">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => dismiss(toast.id)}
          className={`pointer-events-auto rounded-sm border border-l-2 border-line bg-raised px-3 py-2 text-left shadow-lg shadow-black/50 ${TONE[toast.tone]}`}
        >
          <p className="num text-xs font-semibold text-ink">{toast.title}</p>
          {toast.detail ? <p className="mt-0.5 text-[11px] leading-snug text-dim">{toast.detail}</p> : null}
        </button>
      ))}
    </div>
  );
}

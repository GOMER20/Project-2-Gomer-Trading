import type { ReactNode } from 'react';

interface PanelProps {
  title: ReactNode;
  /** Controls shown on the right of the title bar. */
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** A terminal window: title bar plus a body that scrolls on its own. */
export function Panel({ title, actions, className = '', children }: PanelProps) {
  return (
    <section className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-sm border border-line bg-panel ${className}`}>
      <header className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-line bg-raised px-2.5">
        <h2 className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-dim">{title}</h2>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-20 items-center justify-center px-4 text-center text-xs text-faint">{children}</div>;
}

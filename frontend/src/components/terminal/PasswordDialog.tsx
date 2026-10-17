'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage } from '@/lib/api';
import type { User } from '@/lib/types';
import { useAuthStore } from '@/store/auth';

const input = 'h-9 w-full rounded-sm border border-line bg-surface px-2.5 text-sm text-ink placeholder:text-faint focus:border-info focus:outline-none';
const label = 'mb-1 block text-[10px] font-semibold uppercase tracking-wider text-faint';

/** Lets the signed-in trader change their own password. Their other sessions are signed out; this one carries on. */
export function PasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const mismatch = again.length > 0 && next !== again;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (next !== again) return setError('The two new passwords do not match.');
    setBusy(true);
    setError(null);
    try {
      const session = await api<{ token: string; user: User }>('/api/auth/password', { method: 'PUT', body: { currentPassword: current, newPassword: next } });
      useAuthStore.getState().setSession(session.token, session.user);
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Change password"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-sm overflow-hidden rounded-sm border border-line bg-panel shadow-2xl shadow-black"
      >
        <header className="flex items-center justify-between border-b border-line bg-raised px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">Change password</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-sm border border-line px-2 py-0.5 text-xs text-dim hover:text-ink">
            Close
          </button>
        </header>
        {done ? (
          <div className="p-4">
            <p className="text-sm text-up">Your password has been changed.</p>
            <p className="mt-1 text-xs text-dim">Anywhere else you were signed in has been signed out.</p>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3 p-4">
            <div>
              <label htmlFor="password-current" className={label}>
                Current password
              </label>
              <input id="password-current" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required autoFocus className={input} />
            </div>
            <div>
              <label htmlFor="password-next" className={label}>
                New password (at least 8 characters)
              </label>
              <input id="password-next" type="password" value={next} onChange={(e) => setNext(e.target.value)} minLength={8} maxLength={72} autoComplete="new-password" required className={input} />
            </div>
            <div>
              <label htmlFor="password-again" className={label}>
                New password again
              </label>
              <input
                id="password-again"
                type="password"
                value={again}
                onChange={(e) => setAgain(e.target.value)}
                minLength={8}
                maxLength={72}
                autoComplete="new-password"
                required
                className={`${input} ${mismatch ? 'border-down' : ''}`}
              />
            </div>
            {error ? (
              <p role="alert" className="text-xs text-down">
                {error}
              </p>
            ) : null}
            <button type="submit" disabled={busy || mismatch} className="h-9 rounded-sm bg-accent text-sm font-semibold text-surface transition hover:brightness-110 disabled:opacity-50">
              {busy ? 'Changing…' : 'Change password'}
            </button>
            <p className="text-[11px] text-faint">Forgotten it? Ask whoever runs your competition for a temporary password.</p>
          </form>
        )}
      </div>
    </div>
  );
}

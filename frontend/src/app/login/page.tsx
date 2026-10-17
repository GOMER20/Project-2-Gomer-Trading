'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AtBox, HftBox, TestLabHeader, useOwnerToken } from '@/components/labs/TestLab';
import { api, errorMessage } from '@/lib/api';
import { desktopBridge } from '@/lib/desktop';
import { useHydrated } from '@/lib/hooks';
import type { User } from '@/lib/types';
import { useAuthStore } from '@/store/auth';

export default function LoginPage() {
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useAuthStore((s) => s.token);
  const setSession = useAuthStore((s) => s.setSession);
  const [traderId, setTraderId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Where to land after signing in; the admin shortcut goes to the console.
  const destination = useRef('/');
  // Only the desktop app injects the bridge, and only after hydration can we look for it.
  const desktop = hydrated ? desktopBridge() : undefined;
  const ownerToken = useOwnerToken(desktop);

  useEffect(() => {
    if (hydrated && token) router.replace(destination.current);
  }, [hydrated, token, router]);

  async function quickSignIn(account: 'trader' | 'admin') {
    if (!desktop) return;
    setError(null);
    setSubmitting(true);
    try {
      const session = await desktop.signIn(account);
      destination.current = account === 'admin' ? '/admin' : '/';
      setSession(session.token, session.user);
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const session = await api<{ token: string; user: User }>('/api/auth/login', { method: 'POST', body: { traderId, password } });
      setSession(session.token, session.user);
      router.replace('/');
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  }

  const field = 'h-10 w-full rounded-sm border border-line bg-surface px-3 text-sm text-ink placeholder:text-faint focus:border-info focus:outline-none';

  const brand = (
    <div className="flex items-center gap-2.5">
      <span className="flex size-9 items-center justify-center rounded-sm bg-accent text-[15px] font-black tracking-tighter text-surface">GT</span>
      <div>
        <h1 className="text-base font-semibold tracking-wide text-ink">GOMER TRADING</h1>
        <p className="text-xs text-dim">Paper trading terminal</p>
      </div>
    </div>
  );

  const quick = (
    <div className="flex h-full flex-col justify-center rounded-sm border border-line bg-panel p-5">
      <button
        type="button"
        data-quick-login="trader"
        onClick={() => void quickSignIn('trader')}
        disabled={submitting}
        className="h-10 w-full rounded-sm bg-accent text-sm font-semibold text-surface transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Start trading
      </button>
      <p className="mt-2 text-center text-[11px] text-dim">Opens your $100,000 practice account (TRADER01).</p>
      <button
        type="button"
        data-quick-login="admin"
        onClick={() => void quickSignIn('admin')}
        disabled={submitting}
        className="mt-3 h-8 w-full rounded-sm border border-line bg-raised text-xs text-dim transition hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        Open the admin console
      </button>
      <p className="mt-4 border-t border-line pt-3 text-center text-[11px] text-faint">or sign in with a Trader ID</p>
    </div>
  );

  const form = (
    <form onSubmit={submit} className="flex h-full flex-col justify-center rounded-sm border border-line bg-panel p-5">
      <label htmlFor="traderId" className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-dim">
        Trader ID
      </label>
      <input
        id="traderId"
        value={traderId}
        onChange={(e) => setTraderId(e.target.value.toUpperCase())}
        className={`${field} num`}
        placeholder="TRADER01"
        autoComplete="username"
        autoCapitalize="characters"
        spellCheck={false}
        autoFocus={!desktop}
        required
      />

      <label htmlFor="password" className="mb-1.5 mt-4 block text-[11px] font-semibold uppercase tracking-wider text-dim">
        Password
      </label>
      <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} autoComplete="current-password" required />

      {error ? (
        <p role="alert" className="mt-4 rounded-sm border border-down/40 bg-down/10 px-3 py-2 text-xs text-down">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={submitting || !traderId || !password}
        className={`mt-5 h-10 w-full rounded-sm text-sm font-semibold transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 ${
          desktop ? 'border border-line bg-raised text-ink' : 'bg-accent text-surface'
        }`}
      >
        {submitting ? 'Signing in…' : 'Log in'}
      </button>
    </form>
  );

  const footer = (
    <div className="text-center">
      <p className="text-xs text-dim">
        Have an invite code?{' '}
        <Link href="/join" className="text-info hover:underline">
          Join a competition
        </Link>
      </p>
      <p className="mt-2 text-xs text-faint">Simulated trading only. No real money is ever at risk.</p>
    </div>
  );

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface px-4 py-8">
      {desktop ? (
        // Two columns that line up row by row, with the same gaps everywhere: the brand beside the
        // Test Lab's title, the quick sign-in beside AT, the Trader ID box beside HFT, and the
        // footer centred under both.
        <div className="grid w-full max-w-3xl grid-cols-2 gap-x-8 gap-y-3">
          <div className="mb-3">{brand}</div>
          <div className="mb-3">
            <TestLabHeader />
          </div>
          {quick}
          <AtBox token={ownerToken} />
          {form}
          <HftBox token={ownerToken} />
          <div className="col-span-2 mt-3">{footer}</div>
        </div>
      ) : (
        <div className="w-full max-w-sm">
          <div className="mb-6">{brand}</div>
          {form}
          <div className="mt-4">{footer}</div>
        </div>
      )}
    </main>
  );
}

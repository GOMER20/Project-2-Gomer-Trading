'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { desktopBridge } from '@/lib/desktop';
import { useHydrated } from '@/lib/hooks';
import type { User } from '@/lib/types';
import { useAuthStore } from '@/store/auth';

export function Splash({ children }: { children: ReactNode }) {
  return <div className="flex h-dvh items-center justify-center bg-surface px-6 text-center text-sm text-dim">{children}</div>;
}

/** Renders its children only for a signed-in user; everyone else goes to /login. */
export function AuthGate({ children, adminOnly = false, ownerOnly = false }: { children: ReactNode; adminOnly?: boolean; ownerOnly?: boolean }) {
  const hydrated = useHydrated();
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const router = useRouter();

  // The AT and HFT windows belong to the owner, whom the desktop app can sign in itself; anywhere else, sign in first.
  const selfSignIn = ownerOnly && hydrated ? desktopBridge() : undefined;
  useEffect(() => {
    if (!hydrated || token) return;
    if (!selfSignIn) return router.replace('/login');
    selfSignIn
      .signIn('trader')
      .then((session) => useAuthStore.getState().setSession(session.token, session.user))
      .catch(() => router.replace('/login'));
  }, [hydrated, token, router, selfSignIn]);

  // The saved user may come from an older version of the app; take the server's current view of it.
  useEffect(() => {
    if (!hydrated || !token) return;
    void api<{ user: User }>('/api/auth/me')
      .then(({ user: fresh }) => {
        const { token: current, setSession } = useAuthStore.getState();
        if (current === token) setSession(token, fresh);
      })
      .catch(() => undefined);
  }, [hydrated, token]);

  if (!hydrated || !token || !user) return <Splash>Loading terminal…</Splash>;

  if (ownerOnly && !(user.owner ?? user.role === 'ADMIN')) {
    return (
      <Splash>
        <div>
          <p className="text-ink">This window is for the owner of this exchange.</p>
          <Link href="/" className="mt-3 inline-block text-info hover:underline">
            Back to the terminal
          </Link>
        </div>
      </Splash>
    );
  }

  if (adminOnly && user.role !== 'ADMIN') {
    return (
      <Splash>
        <div>
          <p className="text-ink">This area is for competition administrators.</p>
          <Link href="/" className="mt-3 inline-block text-info hover:underline">
            Back to the terminal
          </Link>
        </div>
      </Splash>
    );
  }

  return <>{children}</>;
}

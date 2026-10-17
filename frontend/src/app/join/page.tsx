'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage } from '@/lib/api';
import { dateTime, usd } from '@/lib/format';
import { useHydrated } from '@/lib/hooks';
import type { InvitePreview, User } from '@/lib/types';
import { useAuthStore } from '@/store/auth';
import { useUiStore } from '@/store/ui';

const field = 'h-10 w-full rounded-sm border border-line bg-surface px-3 text-sm text-ink placeholder:text-faint focus:border-info focus:outline-none';
const label = 'mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-dim';
const primary = 'h-10 w-full rounded-sm bg-accent text-sm font-semibold text-surface transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40';

/**
 * Self sign-up. Someone running a competition shares a link or a six-character
 * code; with it, a new trader picks an ID and a password and starts with a
 * fresh balance. A trader who is already signed in just joins.
 */
export default function JoinPage() {
  const router = useRouter();
  const hydrated = useHydrated();
  const session = useAuthStore((s) => s.user);
  const setSession = useAuthStore((s) => s.setSession);

  const [code, setCode] = useState('');
  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [traderId, setTraderId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function lookUp(value: string) {
    const cleaned = value.replace(/[\s-]/g, '').toUpperCase();
    if (cleaned.length < 4) return;
    setBusy(true);
    setError(null);
    try {
      const { competition } = await api<{ competition: InvitePreview }>(`/api/invites/${encodeURIComponent(cleaned)}`);
      setInvite(competition);
    } catch (err) {
      setInvite(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // An invite link carries the code: /join?code=ABC123
  useEffect(() => {
    const fromLink = new URLSearchParams(window.location.search).get('code');
    if (!fromLink) return;
    setCode(fromLink.toUpperCase());
    void lookUp(fromLink);
  }, []);

  async function join(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (session) {
        const joined = await api<{ competition: { id: string } }>(`/api/invites/${encodeURIComponent(code)}/join`, { method: 'POST' });
        useUiStore.getState().setCompetition(joined.competition.id);
      } else {
        const created = await api<{ token: string; user: User; competition: { id: string } }>('/api/auth/join', {
          method: 'POST',
          body: { code, traderId, password, displayName: displayName || undefined },
        });
        useUiStore.getState().setCompetition(created.competition.id);
        setSession(created.token, created.user);
      }
      router.replace('/');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-sm bg-accent text-[15px] font-black tracking-tighter text-surface">GT</span>
          <div>
            <h1 className="text-base font-semibold tracking-wide text-ink">GOMER TRADING</h1>
            <p className="text-xs text-dim">Join a competition</p>
          </div>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void lookUp(code);
          }}
          className="rounded-sm border border-line bg-panel p-5"
        >
          <label htmlFor="code" className={label}>
            Invite code
          </label>
          <div className="flex gap-2">
            <input
              id="code"
              value={code}
              onChange={(e) => {
                setCode(e.target.value.toUpperCase());
                setInvite(null);
              }}
              placeholder="ABC123"
              maxLength={16}
              spellCheck={false}
              autoCapitalize="characters"
              autoFocus
              className={`${field} num tracking-[0.25em]`}
            />
            <button type="submit" disabled={busy || code.trim().length < 4} className="h-10 shrink-0 rounded-sm border border-line bg-raised px-4 text-sm text-ink hover:brightness-125 disabled:opacity-40">
              Check
            </button>
          </div>

          {invite ? (
            <div className="mt-4 rounded-sm border border-up/30 bg-up/10 px-3 py-2.5">
              <p className="text-sm font-semibold text-ink">{invite.name}</p>
              <p className="num mt-1 text-[11px] leading-relaxed text-dim">
                {usd(invite.startingBalance)} to trade with · {invite.participants} trader{invite.participants === 1 ? '' : 's'} so far
                <br />
                {invite.status === 'UPCOMING' ? 'Starts' : 'Started'} {dateTime(invite.startDate)} · ends {dateTime(invite.endDate)}
              </p>
            </div>
          ) : null}
        </form>

        {invite && hydrated ? (
          <form onSubmit={join} className="mt-3 rounded-sm border border-line bg-panel p-5">
            {session ? (
              <p className="mb-4 text-sm text-dim">
                You are signed in as <span className="num font-semibold text-ink">{session.traderId}</span>. Joining gives this account its own {usd(invite.startingBalance)} for this competition.
              </p>
            ) : (
              <>
                <label htmlFor="traderId" className={label}>
                  Choose a Trader ID
                </label>
                <input
                  id="traderId"
                  value={traderId}
                  onChange={(e) => setTraderId(e.target.value.toUpperCase())}
                  placeholder="3 to 24 letters or digits"
                  pattern="[A-Za-z0-9_\-]{3,24}"
                  autoComplete="username"
                  spellCheck={false}
                  required
                  className={`${field} num`}
                />

                <label htmlFor="displayName" className={`${label} mt-4`}>
                  Name on the leaderboard
                </label>
                <input id="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Optional" maxLength={60} className={field} />

                <label htmlFor="password" className={`${label} mt-4`}>
                  Choose a password
                </label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  minLength={8}
                  maxLength={72}
                  autoComplete="new-password"
                  required
                  className={`${field} mb-5`}
                />
              </>
            )}
            <button type="submit" disabled={busy} className={primary}>
              {busy ? 'Joining…' : session ? 'Join this competition' : 'Create my account and join'}
            </button>
          </form>
        ) : null}

        {error ? (
          <p role="alert" className="mt-3 rounded-sm border border-down/40 bg-down/10 px-3 py-2 text-xs text-down">
            {error}
          </p>
        ) : null}

        <p className="mt-4 text-center text-xs text-faint">
          Already have an account?{' '}
          <Link href="/login" className="text-info hover:underline">
            Log in
          </Link>
          {' · '}Simulated trading only.
        </p>
      </div>
    </main>
  );
}

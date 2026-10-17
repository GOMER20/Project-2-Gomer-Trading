'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { HftPanel } from '@/components/admin/HftPanel';
import { HftStrategyPanel } from '@/components/admin/HftStrategyPanel';
import { Panel } from '@/components/ui/Panel';
import { MoneyPresets, StartingMoney } from '@/components/ui/StartingMoney';
import { api, API_URL, errorMessage } from '@/lib/api';
import { desktopBridge } from '@/lib/desktop';
import { dateTime, localMoment, usd } from '@/lib/format';
import type { Competition, MarketHours, User } from '@/lib/types';
import { useAuthStore } from '@/store/auth';

type AdminUser = User & { isActive: boolean; createdAt: string; online?: boolean };
interface Enrollment {
  enrolled: string[];
  alreadyEnrolled: string[];
  notFound: string[];
}
interface Notice {
  ok: boolean;
  text: string;
}

const input = 'h-8 w-full rounded-sm border border-line bg-surface px-2 text-xs text-ink placeholder:text-faint focus:border-info focus:outline-none';
const label = 'mb-1 block text-[10px] font-semibold uppercase tracking-wider text-faint';
const button = 'h-8 rounded-sm bg-accent px-3 text-xs font-semibold text-surface hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40';

/** Value for <input type="datetime-local"> in the browser's own time zone. */
const toLocalInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function summarise(enrollment: Enrollment): string {
  const parts = [`${enrollment.enrolled.length} enrolled`];
  if (enrollment.alreadyEnrolled.length) parts.push(`${enrollment.alreadyEnrolled.length} already in`);
  if (enrollment.notFound.length) parts.push(`not found: ${enrollment.notFound.join(', ')}`);
  return parts.join(' · ');
}

function Message({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return (
    <p role="status" className={`text-[11px] ${notice.ok ? 'text-up' : 'text-down'}`}>
      {notice.text}
    </p>
  );
}

function Field({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className={label}>
        {title}
      </label>
      {children}
    </div>
  );
}

/**
 * Everyone with an account: who has the terminal open, and what to do about a
 * forgotten password or a trader who has to go.
 */
function Accounts({ users, me, onChanged }: { users: AdminUser[]; me: string | undefined; onChanged: () => void }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [issued, setIssued] = useState<{ traderId: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(user: AdminUser, work: () => Promise<void>) {
    setBusy(user.id);
    setNotice(null);
    try {
      await work();
      onChanged();
    } catch (err) {
      setNotice({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  const reset = (user: AdminUser) =>
    act(user, async () => {
      if (!window.confirm(`Give ${user.traderId} a new temporary password? Their current password stops working and they are signed out.`)) return;
      const { temporaryPassword } = await api<{ temporaryPassword: string }>(`/api/users/${user.id}/password`, { method: 'PUT' });
      setCopied(false);
      setIssued({ traderId: user.traderId, password: temporaryPassword });
    });

  const setActive = (user: AdminUser, active: boolean) =>
    act(user, async () => {
      if (!active && !window.confirm(`Deactivate ${user.traderId}? They are signed out at once and cannot log in. Their trades and their place in the standings are kept.`)) return;
      await api(`/api/users/${user.id}/active`, { method: 'PUT', body: { active } });
      setNotice({ ok: true, text: active ? `${user.traderId} can log in again.` : `${user.traderId} has been deactivated and signed out.` });
    });

  const online = users.filter((u) => u.online).length;
  const action = 'text-[11px] text-info hover:underline disabled:opacity-40';

  return (
    <div>
      <p className="border-b border-line/60 px-3 py-1.5 text-[11px] text-dim">
        <span className="mr-1.5 inline-block size-1.5 rounded-full bg-up align-middle" />
        {online} of {users.length} online now
      </p>
      {issued ? (
        <div className="border-b border-line/60 bg-raised px-3 py-2 text-xs">
          <p className="text-dim">
            Temporary password for <span className="num font-semibold text-ink">{issued.traderId}</span>. It is shown only this once; send it to them and ask them to change it after logging in.
          </p>
          <p className="mt-1 flex items-center gap-3">
            <span className="num select-all text-sm font-bold tracking-wider text-accent">{issued.password}</span>
            <button
              type="button"
              className={action}
              onClick={() => {
                void navigator.clipboard.writeText(issued.password).catch(() => undefined);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" className="text-[11px] text-dim hover:text-ink" onClick={() => setIssued(null)}>
              Done
            </button>
          </p>
        </div>
      ) : null}
      {notice ? (
        <p className="border-b border-line/60 px-3 py-1.5">
          <Message notice={notice} />
        </p>
      ) : null}
      <ul className="max-h-72 overflow-y-auto">
        {users.map((user) => (
          <li key={user.id} className={`flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-line/60 px-3 py-1.5 text-xs last:border-b-0 ${user.isActive ? '' : 'opacity-60'}`}>
            <span className="min-w-0 truncate">
              <span className={`mr-2 inline-block size-1.5 rounded-full align-middle ${user.online ? 'bg-up' : 'bg-line'}`} title={user.online ? 'Online now' : 'Not connected'} />
              <span className="num font-semibold text-ink">{user.traderId}</span>
              <span className="ml-2 text-dim">{user.displayName}</span>
            </span>
            <span className="flex shrink-0 items-center gap-3">
              {!user.isActive ? <span className="text-[10px] font-semibold uppercase text-down">Deactivated</span> : null}
              {user.role === 'ADMIN' ? <span className="text-[10px] font-semibold text-accent">ADMIN</span> : null}
              <button type="button" className={action} disabled={busy === user.id} onClick={() => void reset(user)}>
                Reset password
              </button>
              {user.traderId === me ? null : (
                <button type="button" className={`${action} ${user.isActive ? 'text-dim hover:text-down' : ''}`} disabled={busy === user.id} onClick={() => void setActive(user, !user.isActive)}>
                  {user.isActive ? 'Deactivate' : 'Reactivate'}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CreateTrader({ onCreated }: { onCreated: () => void }) {
  const [traderId, setTraderId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const { user } = await api<{ user: User }>('/api/users', { method: 'POST', body: { traderId, password, displayName: displayName || undefined } });
      setNotice({ ok: true, text: `Created ${user.traderId}. Share the password with the trader securely.` });
      setTraderId('');
      setDisplayName('');
      setPassword('');
      onCreated();
    } catch (err) {
      setNotice({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5 p-3">
      <div className="grid grid-cols-2 gap-2">
        <Field id="new-trader-id" title="Trader ID">
          <input id="new-trader-id" value={traderId} onChange={(e) => setTraderId(e.target.value.toUpperCase())} placeholder="TRADER42" pattern="[A-Za-z0-9_\-]{3,24}" required className={`${input} num`} />
        </Field>
        <Field id="new-trader-name" title="Display name">
          <input id="new-trader-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Shown on the leaderboard" maxLength={60} className={input} />
        </Field>
      </div>
      <Field id="new-trader-password" title="Initial password (min 8 characters)">
        <input id="new-trader-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} autoComplete="new-password" required className={input} />
      </Field>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className={button}>
          Create trader
        </button>
        <Message notice={notice} />
      </div>
    </form>
  );
}

function CreateCompetition({ users, hours, onCreated }: { users: AdminUser[]; hours: MarketHours | null; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [start, setStart] = useState(() => toLocalInput(new Date()));
  const [end, setEnd] = useState(() => toLocalInput(new Date(Date.now() + 7 * 86_400_000)));
  const [balance, setBalance] = useState('100000');
  const [leverage, setLeverage] = useState('1');
  const [allowShorting, setAllowShorting] = useState(true);
  const [openToInvites, setOpenToInvites] = useState(true);
  const [commission, setCommission] = useState('0');
  const [marginCall, setMarginCall] = useState('25');
  const [realistic, setRealistic] = useState(false);
  const [orderDelay, setOrderDelay] = useState('2');
  // A fully invested account sits at 100 / leverage percent, so the call level has to be under that.
  const marginCeiling = 100 / (Number(leverage) || 1);
  const marginTooHigh = Number(marginCall) >= marginCeiling;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const traders = users.filter((u) => u.role === 'TRADER' && u.isActive);
  const toggle = (traderId: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(traderId)) next.add(traderId);
      return next;
    });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api<{ competition: Competition; enrollment: Enrollment }>('/api/competitions', {
        method: 'POST',
        body: {
          name,
          startDate: new Date(start).toISOString(),
          endDate: new Date(end).toISOString(),
          startingBalance: Number(balance),
          leverage: Number(leverage),
          commissionPerShare: Number(commission) || 0,
          maintenanceMargin: (Number(marginCall) || 0) / 100,
          fillModel: realistic ? 'hft' : 'standard',
          orderDelayMs: realistic ? Math.round(Number(orderDelay) || 0) : 0,
          allowShorting,
          openToInvites,
          traderIds: [...selected],
        },
      });
      setNotice({ ok: true, text: `Created "${result.competition.name}" · ${summarise(result.enrollment)}` });
      setName('');
      setSelected(new Set());
      onCreated();
    } catch (err) {
      setNotice({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5 p-3">
      <Field id="competition-name" title="Name">
        <input id="competition-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Spring Trading Cup" minLength={3} maxLength={120} required className={input} />
      </Field>
      {hours ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-dim">
          <span>
            Next US market session: <span className="num text-ink">{localMoment(hours.session.opensAt)}</span> to <span className="num text-ink">{localMoment(hours.session.closesAt)}</span> your time
            {hours.session.earlyClose ? ' (early close)' : ''}.
          </span>
          <button
            type="button"
            onClick={() => {
              // A session already under way starts now rather than in the past.
              setStart(toLocalInput(new Date(Math.max(Date.now(), Date.parse(hours.session.opensAt)))));
              setEnd(toLocalInput(new Date(hours.session.closesAt)));
            }}
            className="text-info hover:underline"
          >
            Use these times
          </button>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <Field id="competition-start" title="Starts">
          <input id="competition-start" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} required className={`${input} num`} />
        </Field>
        <Field id="competition-end" title="Ends">
          <input id="competition-end" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} required className={`${input} num`} />
        </Field>
        <Field id="competition-balance" title="Starting money ($), any amount">
          <input id="competition-balance" type="number" min={100} max={1_000_000_000} step="any" value={balance} onChange={(e) => setBalance(e.target.value)} required className={`${input} num`} />
          <div className="mt-1">
            <MoneyPresets value={Number(balance)} onPick={(amount) => setBalance(String(amount))} />
          </div>
        </Field>
        <Field id="competition-leverage" title="Leverage (1 = cash account)">
          <input id="competition-leverage" type="number" min={1} max={10} step={0.5} value={leverage} onChange={(e) => setLeverage(e.target.value)} required className={`${input} num`} />
        </Field>
        <Field id="competition-commission" title="Commission ($ per share, 0 = free)">
          <input id="competition-commission" type="number" min={0} max={1} step={0.001} value={commission} onChange={(e) => setCommission(e.target.value)} className={`${input} num`} />
        </Field>
        <Field id="competition-margin" title="Margin call below (% of positions, 0 = off)">
          <input
            id="competition-margin"
            type="number"
            min={0}
            max={90}
            step={1}
            value={marginCall}
            onChange={(e) => setMarginCall(e.target.value)}
            className={`${input} num ${marginTooHigh ? 'border-down' : ''}`}
          />
        </Field>
      </div>
      <p className={`text-[11px] ${marginTooHigh ? 'text-down' : 'text-faint'}`}>
        {marginTooHigh
          ? `With ${leverage}× leverage a fully invested account is already at ${marginCeiling.toFixed(0)}%, so the margin call level must be lower than that.`
          : 'An account whose equity falls below the margin call level has its orders cancelled and its positions closed at the market. It only ever applies to accounts that borrow or sell short.'}
      </p>
      <label className="flex items-center gap-2 text-xs text-dim">
        <input type="checkbox" checked={allowShorting} onChange={(e) => setAllowShorting(e.target.checked)} className="accent-(--color-accent)" />
        Allow short selling
      </label>
      <label className="flex items-center gap-2 text-xs text-dim">
        <input type="checkbox" checked={realistic} onChange={(e) => setRealistic(e.target.checked)} className="accent-(--color-accent)" />
        Realistic fills: HFT decides them (a sandbox for trading programs)
      </label>
      {realistic ? (
        <div className="grid grid-cols-[1fr_2fr] items-end gap-3">
          <Field id="competition-delay" title="Order delay (ms)">
            <input id="competition-delay" type="number" min={0} max={10_000} step={1} value={orderDelay} onChange={(e) => setOrderDelay(e.target.value)} className={`${input} num`} />
          </Field>
          <p className="pb-1 text-[11px] leading-relaxed text-faint">
            Orders wait in line behind the market&apos;s own at each price, the market&apos;s trades really trade with the queue, and every order and cancel takes this long (and up to half as long again) to reach
            the book. Other competitions are not affected.
          </p>
        </div>
      ) : null}
      <label className="flex items-center gap-2 text-xs text-dim">
        <input type="checkbox" checked={openToInvites} onChange={(e) => setOpenToInvites(e.target.checked)} className="accent-(--color-accent)" />
        Let people sign themselves up with an invite code
      </label>

      <fieldset>
        <legend className={`${label} flex w-full items-center justify-between`}>
          <span>Enrol traders ({selected.size} selected)</span>
          <button type="button" onClick={() => setSelected(new Set(selected.size === traders.length ? [] : traders.map((t) => t.traderId)))} className="normal-case tracking-normal text-info hover:underline">
            {selected.size === traders.length && traders.length > 0 ? 'Clear' : 'Select all'}
          </button>
        </legend>
        <div className="grid max-h-36 grid-cols-2 gap-x-3 gap-y-1 overflow-y-auto rounded-sm border border-line bg-surface p-2 sm:grid-cols-3">
          {traders.length === 0 ? <span className="col-span-full text-xs text-faint">Create some traders first.</span> : null}
          {traders.map((trader) => (
            <label key={trader.id} className="flex items-center gap-1.5 truncate text-xs text-dim" title={trader.displayName}>
              <input type="checkbox" checked={selected.has(trader.traderId)} onChange={() => toggle(trader.traderId)} className="accent-(--color-accent)" />
              <span className="num truncate">{trader.traderId}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className={button}>
          Create competition
        </button>
        <Message notice={notice} />
      </div>
    </form>
  );
}

/** Where other people reach this server: its own address on the web; the Mac's internet link or network address in the desktop app. */
interface Reach {
  /** Base address for invite links, or null when nobody else can connect yet. */
  base: string | null;
  desktop: boolean;
  /** Internet sharing is on but its link has not arrived yet, is waiting for the owner, or could not be set up. */
  internet?: 'starting' | 'waiting' | 'failed';
  /** The address is a permanent one, so links sent out keep working after a restart. */
  permanent?: boolean;
}

function Invite({ competition, reach, onChanged }: { competition: Competition; reach: Reach; onChanged: () => void }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const code = competition.joinCode ?? null;
  const link = code && reach.base ? `${reach.base}/join?code=${code}` : null;

  async function setOpen(open: boolean) {
    try {
      await api(`/api/competitions/${competition.id}/invite`, { method: 'PUT', body: { open } });
      setError(null);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (!code) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-faint">
        Sign-up by invite is closed.
        <button type="button" onClick={() => void setOpen(true)} className="text-info hover:underline">
          Create an invite code
        </button>
        {error ? <span className="text-down">{error}</span> : null}
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-sm border border-line bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-faint">Invite code</span>
        <span className="num text-sm font-bold tracking-[0.25em] text-accent">{code}</span>
        <button type="button" onClick={() => void copy(link ?? code)} className="text-[11px] text-info hover:underline">
          {copied ? 'Copied' : link ? 'Copy invite link' : 'Copy code'}
        </button>
        <button type="button" onClick={() => void setOpen(false)} className="text-[11px] text-dim hover:text-down">
          Close sign-up
        </button>
      </div>
      {link ? (
        <p className="num mt-1 break-all text-[11px] text-dim">
          {link}
          {reach.permanent ? <span className="ml-2 font-sans text-faint">Permanent link</span> : null}
        </p>
      ) : reach.internet === 'waiting' ? (
        <p className="mt-1 text-[11px] text-dim">
          Your permanent address needs one more step in your browser.{' '}
          <button type="button" onClick={() => desktopBridge()?.openHosting()} className="text-info hover:underline">
            Show me
          </button>
        </p>
      ) : reach.internet === 'starting' ? (
        <p className="mt-1 text-[11px] text-dim">Getting your internet link. It appears here in a few seconds.</p>
      ) : reach.desktop ? (
        <p className="mt-1 text-[11px] text-dim">
          {reach.internet === 'failed' ? (
            <>
              The sharing service is not answering yet. The app keeps trying, and the link appears here when it is ready.{' '}
              <button type="button" onClick={() => desktopBridge()?.openHosting()} className="text-info hover:underline">
                Details
              </button>
            </>
          ) : (
            <>
              Other people cannot reach this Mac yet.{' '}
              <button type="button" onClick={() => desktopBridge()?.openHosting()} className="text-info hover:underline">
                Share on the internet
              </button>{' '}
              to get a link you can send them.
            </>
          )}
        </p>
      ) : null}
      <p className="mt-1 text-[11px] text-faint">Anyone with the link or code creates their own Trader ID and starts with a fresh {usd(competition.startingBalance)}.</p>
      {error ? <p className="mt-1 text-[11px] text-down">{error}</p> : null}
    </div>
  );
}

interface Participant {
  portfolioId: string;
  traderId: string;
  displayName: string;
  isBot: boolean;
  startingBalance: number;
  totalEquity: number;
}

/** Every account in a competition, each with its own starting money and the switch to change that one alone. */
function AccountsMoney({ competition }: { competition: Competition }) {
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<Participant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setAccounts((await api<{ participants: Participant[] }>(`/api/competitions/${competition.id}/participants`)).participants);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [competition.id]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  return (
    <div className="mt-2">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="text-[11px] text-dim hover:text-ink">
        {open ? '▾' : '▸'} Money for one account ({competition.participants})
      </button>
      {open ? (
        <ul className="mt-1 rounded-sm border border-line/60">
          {error ? <li className="px-2 py-1.5 text-[11px] text-down">{error}</li> : null}
          {!accounts && !error ? <li className="px-2 py-1.5 text-[11px] text-faint">Loading…</li> : null}
          {accounts?.map((a) => (
            <li key={a.portfolioId} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/40 px-2 py-1.5 last:border-b-0">
              <span className="min-w-40 text-[11px]">
                <span className="num font-semibold text-ink">{a.traderId}</span> <span className="text-dim">{a.displayName}</span>
                {a.isBot ? <span className="ml-1.5 rounded-xs border border-line px-1 text-[9px] uppercase text-faint">program</span> : null}
              </span>
              <StartingMoney
                label="Starts with"
                competitionId={competition.id}
                competitionName={competition.name}
                current={a.startingBalance}
                account={{ portfolioId: a.portfolioId, name: a.traderId }}
                onChanged={() => void load()}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function CompetitionRow({ competition, reach, onChanged }: { competition: Competition; reach: Reach; onChanged: () => void }) {
  const [ids, setIds] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);

  async function enrol(event: FormEvent) {
    event.preventDefault();
    const traderIds = ids.split(/[\s,]+/).filter(Boolean);
    if (!traderIds.length) return;
    try {
      const { enrollment } = await api<{ enrollment: Enrollment }>(`/api/competitions/${competition.id}/participants`, { method: 'POST', body: { traderIds } });
      setNotice({ ok: true, text: summarise(enrollment) });
      setIds('');
      onChanged();
    } catch (err) {
      setNotice({ ok: false, text: errorMessage(err) });
    }
  }

  const tone = competition.status === 'ACTIVE' ? 'bg-up/15 text-up' : competition.status === 'UPCOMING' ? 'bg-info/15 text-info' : 'bg-faint/20 text-dim';

  return (
    <li className="border-b border-line/60 px-3 py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[13px] font-semibold text-ink">{competition.name}</span>
        <span className={`rounded-xs px-1.5 py-px text-[10px] font-semibold ${tone}`}>{competition.status}</span>
        <span className="num text-[11px] text-dim">
          {dateTime(competition.startDate)} → {dateTime(competition.endDate)}
        </span>
      </div>
      <p className="num mt-1 text-[11px] text-faint">
        {usd(competition.startingBalance)} start · {competition.leverage}× leverage · shorting {competition.allowShorting ? 'on' : 'off'} ·{' '}
        {competition.commissionPerShare > 0 ? `$${competition.commissionPerShare} a share commission` : 'no commission'} ·{' '}
        {competition.maintenanceMargin > 0 ? `margin call below ${(competition.maintenanceMargin * 100).toFixed(0)}%` : 'no margin calls'} ·{' '}
        {competition.fillModel === 'hft' ? `realistic fills (HFT, ${competition.orderDelayMs} ms order delay) · ` : ''}
        {competition.participants} trader
        {competition.participants === 1 ? '' : 's'}
      </p>
      {competition.status !== 'ENDED' ? (
        <div className="mt-2">
          <StartingMoney competitionId={competition.id} competitionName={competition.name} current={competition.startingBalance} onChanged={onChanged} />
          {competition.participants > 0 ? <AccountsMoney competition={competition} /> : null}
        </div>
      ) : null}
      {competition.status !== 'ENDED' ? <Invite competition={competition} reach={reach} onChanged={onChanged} /> : null}
      {competition.status !== 'ENDED' ? (
        <form onSubmit={enrol} className="mt-2 flex flex-wrap items-center gap-2">
          <input value={ids} onChange={(e) => setIds(e.target.value.toUpperCase())} placeholder="Add trader IDs, comma separated" aria-label={`Add traders to ${competition.name}`} className={`${input} num max-w-72`} />
          <button type="submit" className="h-8 rounded-sm border border-line bg-raised px-3 text-xs text-dim hover:text-ink">
            Enrol with fresh {usd(competition.startingBalance)}
          </button>
          <Message notice={notice} />
        </form>
      ) : null}
    </li>
  );
}

interface Bot {
  id: string;
  label: string;
  traderId: string;
  isBot: boolean;
  competitionId: string;
  competitionName: string;
  keyPrefix: string;
  ordersPerSecond: number;
  enabled: boolean;
  lastUsedAt: string | null;
  live: { connections: number; transports: string[]; orders: number };
}

interface GatewayEndpoints {
  websocket: string;
  rest: string;
  tcp: string | null;
  unix: string | null;
}

/**
 * Trading programs: who may connect through the bot gateway, and which
 * competition each one trades in. A bot's competition is its sandbox, with its
 * own balance; changing it here is the switch that moves the bot.
 */
function Bots({ competitions, reach }: { competitions: Competition[]; reach: Reach }) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [endpoints, setEndpoints] = useState<GatewayEndpoints | null>(null);
  const [label, setLabel] = useState('');
  const [sandbox, setSandbox] = useState('');
  const [rate, setRate] = useState('50');
  const [issued, setIssued] = useState<{ label: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const open = competitions.filter((c) => c.status !== 'ENDED');
  const chosen = sandbox || open[0]?.id || '';

  const reload = useCallback(async () => {
    try {
      const loaded = await api<{ bots: Bot[]; endpoints: GatewayEndpoints }>('/api/bots');
      setBots(loaded.bots);
      setEndpoints(loaded.endpoints);
    } catch (err) {
      setNotice({ ok: false, text: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 10_000);
    return () => clearInterval(timer);
  }, [reload]);

  async function act(work: () => Promise<void>) {
    setBusy(true);
    setNotice(null);
    try {
      await work();
      await reload();
    } catch (err) {
      setNotice({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const show = (botLabel: string, key: string) => {
    setCopied(false);
    setIssued({ label: botLabel, key });
  };

  const create = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      const made = await api<{ bot: Bot; apiKey: string }>('/api/bots', { method: 'POST', body: { label, competitionId: chosen, ordersPerSecond: Number(rate) || 50 } });
      show(made.bot.label, made.apiKey);
      setLabel('');
    });
  };

  // Where a program on another machine connects: the address people already use to reach this server.
  // In development the interface and the API are on different ports; everywhere else they share one address.
  const base = reach.base ?? (API_URL || (typeof window === 'undefined' ? '' : window.location.origin));
  const action = 'text-[11px] text-info hover:underline disabled:opacity-40';

  return (
    <div>
      <form onSubmit={create} className="flex flex-wrap items-end gap-2 border-b border-line/60 p-3">
        <Field id="bot-label" title="Name of the program">
          <input id="bot-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Momentum bot" minLength={2} maxLength={60} required className={`${input} w-48`} />
        </Field>
        <Field id="bot-sandbox" title="Sandbox (competition it trades in)">
          <select id="bot-sandbox" value={chosen} onChange={(e) => setSandbox(e.target.value)} required className={`${input} w-56`}>
            {open.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({usd(c.startingBalance)})
              </option>
            ))}
          </select>
        </Field>
        <Field id="bot-rate" title="Orders per second">
          <input id="bot-rate" type="number" min={1} max={5000} value={rate} onChange={(e) => setRate(e.target.value)} className={`${input} num w-24`} />
        </Field>
        <button type="submit" disabled={busy || !chosen} className={button}>
          Create bot and API key
        </button>
        <Message notice={notice} />
      </form>

      {issued ? (
        <div className="border-b border-line/60 bg-raised px-3 py-2 text-xs">
          <p className="text-dim">
            API key for <span className="font-semibold text-ink">{issued.label}</span>. It is shown only this once: copy it into the program now. Anyone holding it can trade this bot&apos;s account.
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-3">
            <span className="num select-all break-all text-[12px] font-semibold text-accent">{issued.key}</span>
            <button
              type="button"
              className={action}
              onClick={() => {
                void navigator.clipboard.writeText(issued.key).catch(() => undefined);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" className="text-[11px] text-dim hover:text-ink" onClick={() => setIssued(null)}>
              Done
            </button>
          </p>
        </div>
      ) : null}

      {bots.length === 0 ? (
        <p className="px-3 py-3 text-xs text-faint">No trading programs yet. Create one above to get an API key for it.</p>
      ) : (
        <ul>
          {bots.map((bot) => (
            <li key={bot.id} className={`flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line/60 px-3 py-2 text-xs last:border-b-0 ${bot.enabled ? '' : 'opacity-60'}`}>
              <span className="min-w-40">
                <span className={`mr-2 inline-block size-1.5 rounded-full align-middle ${bot.live.connections > 0 ? 'bg-up' : 'bg-line'}`} />
                <span className="font-semibold text-ink">{bot.label}</span>
                <span className="num ml-2 text-dim">{bot.traderId}</span>
              </span>
              <span className="text-[11px] text-dim">
                {bot.live.connections > 0 ? `connected (${bot.live.transports.join(', ')}), ${bot.live.orders} orders this session` : bot.lastUsedAt ? `last seen ${dateTime(bot.lastUsedAt)}` : 'never connected'}
              </span>
              <label className="flex items-center gap-1.5 text-[11px] text-faint">
                Sandbox
                <select
                  value={bot.competitionId}
                  disabled={busy}
                  onChange={(e) => void act(() => api(`/api/bots/${bot.id}`, { method: 'PUT', body: { competitionId: e.target.value } }).then(() => undefined))}
                  className="h-7 rounded-sm border border-line bg-surface px-1.5 text-[11px] text-ink"
                  title="Moving a bot gives it that competition's own balance and disconnects it; it logs on again into the new sandbox."
                >
                  {!open.some((c) => c.id === bot.competitionId) ? <option value={bot.competitionId}>{bot.competitionName} (ended)</option> : null}
                  {open.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <span className="num text-[11px] text-faint">{bot.ordersPerSecond} orders/s</span>
              <span className="ml-auto flex items-center gap-3">
                {!bot.enabled ? <span className="text-[10px] font-semibold uppercase text-down">Off</span> : null}
                <button type="button" className={action} disabled={busy} onClick={() => void act(() => api(`/api/bots/${bot.id}`, { method: 'PUT', body: { enabled: !bot.enabled } }).then(() => undefined))}>
                  {bot.enabled ? 'Switch off' : 'Switch on'}
                </button>
                <button
                  type="button"
                  className={action}
                  disabled={busy}
                  onClick={() =>
                    window.confirm(`Give ${bot.label} a new API key? The current key stops working at once.`) &&
                    void act(async () => {
                      const rotated = await api<{ bot: Bot; apiKey: string }>(`/api/bots/${bot.id}/rotate`, { method: 'POST' });
                      show(rotated.bot.label, rotated.apiKey);
                    })
                  }
                >
                  New key
                </button>
                <button
                  type="button"
                  className={`${action} text-dim hover:text-down`}
                  disabled={busy}
                  onClick={() => window.confirm(`Delete ${bot.label}? Its key stops working. Its trades stay on the record.`) && void act(() => api(`/api/bots/${bot.id}`, { method: 'DELETE' }).then(() => undefined))}
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {endpoints ? (
        <dl className="num grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-t border-line/60 px-3 py-2 text-[11px] text-dim">
          <dt className="font-sans text-faint">WebSocket (JSON)</dt>
          <dd className="break-all">{base.replace(/^http/, 'ws')}{endpoints.websocket}</dd>
          <dt className="font-sans text-faint">REST</dt>
          <dd className="break-all">{base}{endpoints.rest}</dd>
          <dt className="font-sans text-faint">Binary, TCP</dt>
          <dd>{endpoints.tcp ?? 'off'} <span className="font-sans text-faint">(programs on this machine or network)</span></dd>
          <dt className="font-sans text-faint">Binary, Unix socket</dt>
          <dd className="break-all">{endpoints.unix ?? 'off'} <span className="font-sans text-faint">(programs on this machine; the fastest way in)</span></dd>
        </dl>
      ) : null}
    </div>
  );
}

function AdminConsole() {
  const me = useAuthStore((s) => s.user?.traderId);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hours, setHours] = useState<MarketHours | null>(null);
  const [reach, setReach] = useState<Reach>({ base: null, desktop: false });

  useEffect(() => {
    void api<MarketHours>('/api/market/hours').then(setHours).catch(() => undefined);
    const desktop = desktopBridge();
    if (!desktop) return setReach({ base: window.location.origin, desktop: false });
    // Sharing is switched on and off from the app's menu, and a new link takes a few seconds to arrive, so keep looking.
    const look = () =>
      void desktop
        .hosting()
        .then((hosting) => {
          const base = hosting.enabled ? (hosting.addresses[0] ?? null) : null;
          const state = hosting.internet?.state;
          const internet = !base && (state === 'starting' || state === 'waiting' || state === 'failed') ? state : undefined;
          const permanent = Boolean(base && hosting.internet?.permanent && hosting.internet.url === base);
          setReach((was) => (was.base === base && was.desktop && was.internet === internet && was.permanent === permanent ? was : { base, desktop: true, internet, permanent }));
        })
        .catch(() => undefined);
    look();
    const timer = setInterval(look, 4000);
    return () => clearInterval(timer);
  }, []);

  const reload = useCallback(async () => {
    try {
      const [u, c] = await Promise.all([api<{ users: AdminUser[] }>('/api/users'), api<{ competitions: Competition[] }>('/api/competitions')]);
      setUsers(u.users);
      setCompetitions(c.competitions);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void reload();
    // Keeps "online now" current without anyone pressing refresh.
    const timer = setInterval(() => void reload(), 15_000);
    return () => clearInterval(timer);
  }, [reload]);

  return (
    <div className="min-h-dvh bg-surface">
      <header className="flex h-12 items-center justify-between border-b border-line bg-panel px-4">
        <div className="flex items-center gap-2.5">
          <span className="flex size-6 items-center justify-center rounded-sm bg-accent text-[10px] font-black tracking-tighter text-surface">GT</span>
          <h1 className="text-xs font-bold tracking-[0.18em] text-ink">GOMER TRADING · ADMIN</h1>
        </div>
        <Link href="/" className="text-xs text-info hover:underline">
          ← Trading terminal
        </Link>
      </header>

      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-3 p-3 lg:grid-cols-2">
        {error ? (
          <p role="alert" className="col-span-full rounded-sm border border-down/40 bg-down/10 px-3 py-2 text-xs text-down">
            {error}
          </p>
        ) : null}

        <Panel title="New competition">
          <CreateCompetition users={users} hours={hours} onCreated={reload} />
        </Panel>

        <div className="flex flex-col gap-3">
          <Panel title="New trader">
            <CreateTrader onCreated={reload} />
          </Panel>
          <Panel title={`Accounts (${users.length})`}>
            <Accounts users={users} me={me} onChanged={reload} />
          </Panel>
        </div>

        <Panel title="Trading programs (bots)" className="col-span-full">
          <Bots competitions={competitions} reach={reach} />
        </Panel>

        <Panel title="HFT Strategy · market maker" className="col-span-full">
          <HftStrategyPanel />
        </Panel>

        <Panel title="HFT · order book engine" className="col-span-full">
          <HftPanel />
        </Panel>

        <Panel title={`Competitions (${competitions.length})`} className="col-span-full">
          {competitions.length === 0 ? (
            <p className="px-3 py-4 text-xs text-faint">No competitions yet. Create one above.</p>
          ) : (
            <ul>
              {competitions.map((competition) => (
                <CompetitionRow key={competition.id} competition={competition} reach={reach} onChanged={reload} />
              ))}
            </ul>
          )}
        </Panel>
      </main>
    </div>
  );
}

export default function AdminPage() {
  return (
    <AuthGate adminOnly>
      <AdminConsole />
    </AuthGate>
  );
}

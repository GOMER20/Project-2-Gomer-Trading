'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { EmptyState, Panel } from '@/components/ui/Panel';
import { dateTime, duration, pnlColor, price, shares, signedUsd, usd } from '@/lib/format';
import { percent, successRate, usePoll, type AtAccount, type AtDashboard, type AtReports, type AtStats } from '@/lib/labs';
import { RunningTotalChart } from './LabChart';

/**
 * AT's own window: how the trading algorithm is doing.
 *
 * The top half is what AT did on this exchange (the exchange's own records);
 * the bottom half is what AT measures about itself in its reports. The success
 * rate leads everywhere, as its owner asked.
 */

const th = 'px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wider text-faint';
const td = 'num px-2 py-1 text-[11px] text-ink';

export function WindowHeader({ title, subtitle, right }: { title: string; subtitle: ReactNode; right?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-panel px-3 py-2">
      <span className="flex size-7 items-center justify-center rounded-sm bg-accent text-xs font-bold text-surface">GT</span>
      <div className="min-w-0">
        <h1 className="text-sm font-semibold text-ink">{title}</h1>
        <p className="truncate text-[11px] text-dim">{subtitle}</p>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2 text-[11px] text-dim">{right}</div>
    </header>
  );
}

export function Tile({ title, value, note, tone = 'text-ink', big = false }: { title: string; value: string; note?: string; tone?: string; big?: boolean }) {
  return (
    <div className="min-w-0 rounded-sm border border-line bg-panel px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-faint">{title}</p>
      <p className={`num truncate leading-tight ${big ? 'text-3xl' : 'text-lg'} ${tone}`}>{value}</p>
      {note ? <p className="truncate text-[10px] text-faint">{note}</p> : null}
    </div>
  );
}

const money = (value: number | null | undefined) => (value == null ? '—' : signedUsd(value));
const hold = (seconds: number | null) => (seconds == null ? '—' : seconds < 60 ? `${seconds}s` : duration(seconds * 1000));

function Headline({ account }: { account: AtAccount }) {
  const { summary, thisSession, portfolio } = account;
  return (
    <section className="grid grid-cols-2 gap-1 md:grid-cols-4 xl:grid-cols-8">
      <div className="col-span-2">
        <Tile big title="Success rate" value={summary.trades ? percent(summary.winRate) : '—'} note={summary.trades ? `${summary.wins} of ${summary.trades} trades won here` : 'no finished trades yet'} />
      </div>
      <Tile title="Net result" value={signedUsd(summary.netPnl)} tone={pnlColor(summary.netPnl)} note="all finished trades, after costs" />
      <Tile
        title="Equity"
        value={portfolio ? usd(portfolio.totalEquity) : '—'}
        note={portfolio ? `${portfolio.returnPct >= 0 ? '+' : ''}${portfolio.returnPct.toFixed(2)}% on ${usd(portfolio.startingBalance)}` : undefined}
        tone={portfolio ? pnlColor(portfolio.totalPnl) : 'text-ink'}
      />
      <Tile title={`Session ${thisSession.session}`} value={thisSession.trades ? percent(thisSession.winRate) : '—'} note={thisSession.trades ? `${thisSession.wins} of ${thisSession.trades} · ${signedUsd(thisSession.netPnl)}` : 'no trades this session'} />
      <Tile title="Profit factor" value={summary.profitFactor == null ? '—' : summary.profitFactor.toFixed(2)} note="won ÷ lost, in dollars" />
      <Tile title="Average win / loss" value={`${money(summary.avgWin)} / ${money(summary.avgLoss)}`} />
      <Tile title="Longest losing run" value={`${summary.longestLosingStreak}`} note={`average hold ${hold(summary.avgHoldSeconds)}`} />
    </section>
  );
}

function Sessions({ account }: { account: AtAccount }) {
  if (!account.sessions.length) return <EmptyState>No finished trades yet.</EmptyState>;
  return (
    <table className="w-full">
      <thead className="sticky top-0 bg-panel">
        <tr>
          <th className={th}>Session</th>
          <th className={`${th} text-right`}>Success</th>
          <th className={`${th} text-right`}>Trades</th>
          <th className={`${th} text-right`}>Result</th>
        </tr>
      </thead>
      <tbody>
        {account.sessions.map((row) => (
          <tr key={row.session} className="border-t border-line/50">
            <td className={td}>{row.session}</td>
            <td className={`${td} text-right`}>
              <span className={row.winRate != null && row.winRate < 0.7 ? 'text-accent' : ''}>{percent(row.winRate)}</span>
            </td>
            <td className={`${td} text-right text-dim`}>
              {row.wins}/{row.trades}
            </td>
            <td className={`${td} text-right ${pnlColor(row.pnl)}`}>{signedUsd(row.pnl)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Trades({ account }: { account: AtAccount }) {
  if (!account.trades.length) return <EmptyState>Finished trades appear here: what AT bought or sold, at what price, and how it came out.</EmptyState>;
  return (
    <table className="w-full">
      <thead className="sticky top-0 bg-panel">
        <tr>
          <th className={th}>Closed</th>
          <th className={th}>Symbol</th>
          <th className={th}>Side</th>
          <th className={`${th} text-right`}>Shares</th>
          <th className={`${th} text-right`}>Entry</th>
          <th className={`${th} text-right`}>Exit</th>
          <th className={`${th} text-right`}>Held</th>
          <th className={`${th} text-right`}>Result</th>
        </tr>
      </thead>
      <tbody>
        {account.trades.map((trade, i) => (
          <tr key={`${trade.closedAt}-${trade.ticker}-${i}`} className="border-t border-line/50">
            <td className={`${td} text-dim`}>{dateTime(trade.closedAt)}</td>
            <td className={`${td} font-semibold`}>{trade.ticker}</td>
            <td className={`${td} ${trade.direction === 'LONG' ? 'text-up' : 'text-down'}`}>{trade.direction === 'LONG' ? 'Long' : 'Short'}</td>
            <td className={`${td} text-right`}>{shares(trade.quantity)}</td>
            <td className={`${td} text-right`}>{price(trade.entryPrice)}</td>
            <td className={`${td} text-right`}>{price(trade.exitPrice)}</td>
            <td className={`${td} text-right text-dim`}>{hold(Math.round((Date.parse(trade.closedAt) - Date.parse(trade.openedAt)) / 1000))}</td>
            <td className={`${td} text-right ${pnlColor(trade.pnl)}`}>
              {trade.pnl > 0 ? '✓ ' : trade.pnl < 0 ? '✗ ' : ''}
              {signedUsd(trade.pnl)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OpenNow({ account }: { account: AtAccount }) {
  const positions = account.portfolio?.positions ?? [];
  if (!positions.length && !account.workingOrders.length) return <EmptyState>Nothing open: no positions and no working orders.</EmptyState>;
  return (
    <div>
      {positions.length ? (
        <table className="w-full">
          <thead>
            <tr>
              <th className={th}>Position</th>
              <th className={`${th} text-right`}>Shares</th>
              <th className={`${th} text-right`}>Average</th>
              <th className={`${th} text-right`}>Now</th>
              <th className={`${th} text-right`}>Open P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.ticker} className="border-t border-line/50">
                <td className={`${td} font-semibold`}>{p.ticker}</td>
                <td className={`${td} text-right ${p.quantity > 0 ? 'text-up' : 'text-down'}`}>{shares(p.quantity)}</td>
                <td className={`${td} text-right`}>{price(p.averagePrice)}</td>
                <td className={`${td} text-right`}>{price(p.currentPrice)}</td>
                <td className={`${td} text-right ${pnlColor(p.unrealizedPnl)}`}>{signedUsd(p.unrealizedPnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {account.workingOrders.length ? (
        <table className="w-full">
          <thead>
            <tr>
              <th className={th}>Working order</th>
              <th className={th}>Type</th>
              <th className={`${th} text-right`}>Shares</th>
              <th className={`${th} text-right`}>Price</th>
            </tr>
          </thead>
          <tbody>
            {account.workingOrders.map((o) => (
              <tr key={o.id} className="border-t border-line/50">
                <td className={`${td} font-semibold`}>
                  <span className={o.side === 'BUY' ? 'text-up' : 'text-down'}>{o.side === 'BUY' ? 'Buy' : 'Sell'}</span> {o.ticker}
                </td>
                <td className={`${td} text-dim`}>
                  {o.type.replace('_', ' ').toLowerCase()}
                  {o.parentId ? ' (exit)' : ''}
                </td>
                <td className={`${td} text-right`}>
                  {shares(o.quantity - o.filledQuantity)}
                  {o.filledQuantity ? <span className="text-faint"> of {shares(o.quantity)}</span> : null}
                </td>
                <td className={`${td} text-right`}>{price(o.limitPrice ?? o.stopPrice)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function Fills({ account }: { account: AtAccount }) {
  if (!account.fills.length) return <EmptyState>No fills yet.</EmptyState>;
  return (
    <table className="w-full">
      <thead className="sticky top-0 bg-panel">
        <tr>
          <th className={th}>Time</th>
          <th className={th}>Fill</th>
          <th className={`${th} text-right`}>Shares</th>
          <th className={`${th} text-right`}>Price</th>
          <th className={`${th} text-right`}>Booked</th>
        </tr>
      </thead>
      <tbody>
        {account.fills.map((f, i) => (
          <tr key={`${f.executedAt}-${i}`} className="border-t border-line/50">
            <td className={`${td} text-dim`}>{dateTime(f.executedAt)}</td>
            <td className={td}>
              <span className={f.side === 'BUY' ? 'text-up' : 'text-down'}>{f.side === 'BUY' ? 'Bought' : 'Sold'}</span> {f.ticker}
            </td>
            <td className={`${td} text-right`}>{shares(f.quantity)}</td>
            <td className={`${td} text-right`}>{price(f.price)}</td>
            <td className={`${td} text-right ${pnlColor(f.realizedPnl)}`}>{f.realizedPnl ? signedUsd(f.realizedPnl) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// --- what AT reports about itself ---------------------------------------------

const num = (stats: AtStats | null | undefined, key: keyof AtStats) => {
  const value = stats?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

function Research({ research }: { research: NonNullable<AtReports['research']> }) {
  const holdout = research.holdout;
  const trades = num(holdout, 'trades');
  const wins = trades != null && num(holdout, 'win_rate') != null ? Math.round(trades * num(holdout, 'win_rate')!) : null;
  const steadiness = research.steadiness ?? {};
  return (
    <div className="space-y-2 p-2.5">
      <p className="text-[11px] leading-relaxed text-dim">
        Before trading live, AT&apos;s settings were chosen by walk-forward testing and then checked once on {num(holdout, 'days') ?? 'several'} sessions of practice-market history they had never seen. Those
        results are below. They are a simulation: live results are what the top of this window shows.
      </p>
      <div className="grid grid-cols-2 gap-1 lg:grid-cols-4">
        <Tile title="Success rate (unseen sessions)" value={percent(num(holdout, 'win_rate'))} note={trades != null && wins != null ? `${shares(wins)} of ${shares(trades)} trades` : undefined} />
        <Tile title="Before the loss review" value={percent(research.previousWinRate)} note="first-round settings" />
        <Tile title="Random entries" value={percent(research.randomEntryWinRate)} note="the same exits, entries by chance" />
        <Tile title="Profit factor" value={num(holdout, 'profit_factor')?.toFixed(2) ?? '—'} note={`worst drawdown ${percent(num(holdout, 'max_drawdown'), 2)}`} />
        <Tile title="Average trade" value={num(holdout, 'expectancy_bps') != null ? `${num(holdout, 'expectancy_bps')!.toFixed(1)} bps` : '—'} note={`${money(num(holdout, 'expectancy'))} a trade`} />
        <Tile title="Worst session" value={percent(steadiness.session_min ?? null)} note={`median ${percent(steadiness.session_median ?? null)}`} />
        <Tile title="A bad half-hour" value={percent(steadiness.half_hour_p5 ?? null)} note="1 in 20 half-hours is worse" />
        <Tile title="Half-hours under 70%" value={percent(steadiness.half_hours_below_70 ?? null)} note={research.configuration ? `playbook: ${research.configuration}` : undefined} />
      </div>
    </div>
  );
}

function ReportSessions({ reports }: { reports: AtReports }) {
  const [open, setOpen] = useState<string | null>(reports.sessions[0]?.name ?? null);
  const chosen = reports.sessions.find((s) => s.name === open) ?? null;
  if (!reports.sessions.length) return <EmptyState>AT has not written a session report yet.</EmptyState>;
  return (
    <div className="grid min-h-0 gap-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <table className="w-full self-start">
        <thead>
          <tr>
            <th className={th}>Run</th>
            <th className={`${th} text-right`}>Success</th>
            <th className={`${th} text-right`}>Trades</th>
            <th className={`${th} text-right`}>Result</th>
            <th className={th}>Review</th>
          </tr>
        </thead>
        <tbody>
          {reports.sessions.map((s) => {
            const trades = num(s.stats, 'trades');
            const net = num(s.stats, 'net_pnl');
            return (
              <tr key={s.name} onClick={() => setOpen(s.name)} className={`cursor-pointer border-t border-line/50 hover:bg-hover ${open === s.name ? 'bg-raised' : ''}`}>
                <td className={td}>{s.name.replace('_', ' ')}</td>
                <td className={`${td} text-right`}>{trades ? percent(num(s.stats, 'win_rate')) : '—'}</td>
                <td className={`${td} text-right text-dim`}>{trades ?? '—'}</td>
                <td className={`${td} text-right ${pnlColor(net ?? 0)}`}>{net == null ? '—' : signedUsd(net)}</td>
                <td className={`${td} text-dim`}>{s.review ? (s.review.update_recommended ? 'update the rules' : 'no change needed') : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <pre className="max-h-96 min-w-0 overflow-auto whitespace-pre-wrap rounded-sm border border-line/60 bg-surface p-2.5 font-mono text-[11px] leading-relaxed text-dim">
        {chosen?.report ?? 'No report for this run.'}
      </pre>
    </div>
  );
}

// --- the window -------------------------------------------------------------------

export function AtWindow() {
  const { data, error } = usePoll<AtDashboard>('/api/at', 5_000);
  const [chosen, setChosen] = useState<string | null>(null);
  const account = data?.accounts.find((a) => a.portfolioId === chosen) ?? data?.accounts[0] ?? null;
  // Rebuilt only when a trade finishes, not on every refresh, so the chart keeps its place.
  const curveKey = account ? `${account.portfolioId}:${account.curve.length}:${account.curve.at(-1)?.pnl ?? 0}` : '';
  const points = useMemo(
    () => (account ? [{ time: Date.parse(account.competition.startDate) / 1000, value: 0 }, ...account.curve.map((p) => ({ time: p.time, value: p.pnl }))] : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- curveKey stands for the curve
    [curveKey],
  );
  const describe = useCallback((value: number, time: number) => `${signedUsd(value)} after the trade closed ${dateTime(new Date(time * 1000).toISOString())}`, []);

  const connected = data?.accounts.some((a) => a.connection.connected);
  const agent = data?.reports?.agent.line;

  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <WindowHeader
        title="Algorithmic trading · AT"
        subtitle="AT is the trading algorithm that trades on Gomer Trading through its bot gateway. Everything here updates every few seconds."
        right={
          <>
            <span className="flex items-center gap-1.5 rounded-sm border border-line px-2 py-1">
              <span className={`size-1.5 rounded-full ${connected ? 'bg-up' : 'bg-faint'}`} />
              {connected ? 'Connected and trading' : 'Not connected'}
            </span>
            {agent ? (
              <span className="max-w-md truncate rounded-sm border border-line px-2 py-1" title={`AT's scheduler, ${data?.reports?.agent.at ? dateTime(data.reports.agent.at) : ''}`}>
                Scheduler: {agent}
              </span>
            ) : null}
            {data ? <span className="text-faint">updated {dateTime(data.asOf)}</span> : null}
          </>
        }
      />

      {error && !data ? <p className="p-3 text-xs text-down">{error}</p> : null}
      {!data && !error ? <p className="p-3 text-xs text-faint">Loading…</p> : null}
      {data && !data.found ? (
        <p className="p-3 text-xs text-dim">AT is not set up on this exchange yet. Admit it in the admin console as a trading program labelled “{data.label}”.</p>
      ) : null}

      {account ? (
        <main className="flex flex-col gap-1 p-1">
          {data!.accounts.length > 1 ? (
            <nav className="flex flex-wrap gap-1" aria-label="AT's accounts">
              {data!.accounts.map((a) => (
                <button
                  key={a.portfolioId}
                  type="button"
                  onClick={() => setChosen(a.portfolioId)}
                  aria-pressed={a.portfolioId === account.portfolioId}
                  className={`rounded-sm border px-2.5 py-1 text-[11px] ${a.portfolioId === account.portfolioId ? 'border-accent bg-accent/10 text-accent' : 'border-line text-dim hover:text-ink'}`}
                >
                  {a.competition.name}
                  <span className="ml-1.5 text-faint">
                    {a.keys.length ? (a.connection.connected ? '· trading now' : '· trades here') : '· earlier'} · {successRate(a.summary)}
                  </span>
                </button>
              ))}
            </nav>
          ) : null}

          <Headline account={account} />

          <div className="grid gap-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Panel title="Running result, trade by trade" className="h-80">
              {account.curve.length ? <RunningTotalChart points={points} describe={describe} /> : <EmptyState>The running result appears once AT has finished a trade.</EmptyState>}
            </Panel>
            <Panel title="By session (New York date)" className="h-80">
              <div className="h-full overflow-auto">
                <Sessions account={account} />
              </div>
            </Panel>
          </div>

          <div className="grid gap-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Panel title={`Finished trades (${account.summary.trades})`} className="h-96">
              <div className="h-full overflow-auto">
                <Trades account={account} />
              </div>
            </Panel>
            <div className="flex flex-col gap-1">
              <Panel title="Open now" className="h-48">
                <div className="h-full overflow-auto">
                  <OpenNow account={account} />
                </div>
              </Panel>
              <Panel title="Latest fills" className="h-[188px]">
                <div className="h-full overflow-auto">
                  <Fills account={account} />
                </div>
              </Panel>
            </div>
          </div>

          {data!.reports ? (
            <>
              {data!.reports.research ? (
                <Panel title="What AT measured before going live">
                  <Research research={data!.reports.research} />
                </Panel>
              ) : null}
              <Panel title="AT's own session reports">
                <div className="p-1">
                  <ReportSessions reports={data!.reports} />
                </div>
              </Panel>
            </>
          ) : (
            <p className="px-2 py-1 text-[11px] text-faint">AT&apos;s own reports are not on this computer, so only what it traded here is shown.</p>
          )}
        </main>
      ) : null}
    </div>
  );
}

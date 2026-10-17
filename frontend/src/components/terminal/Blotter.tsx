'use client';

import { useEffect, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { clock, markOf, pnlColor, price, shares, signedPct, signedUsd, usd } from '@/lib/format';
import { useTickFlash } from '@/lib/hooks';
import type { Competition, Execution, Order, Position } from '@/lib/types';
import { useMarketStore } from '@/store/market';
import { useAuthStore } from '@/store/auth';
import { exitKind, ORDER_TYPE_NAMES, useTradingStore } from '@/store/trading';
import { useUiStore } from '@/store/ui';
import { EmptyState } from '../ui/Panel';
import { AlertsPanel, useAlertSymbols } from './Alerts';

type Tab = 'positions' | 'working' | 'history' | 'fills' | 'performance' | 'alerts';

const th = 'whitespace-nowrap px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-faint';
const td = 'num whitespace-nowrap px-2 py-1.5 text-xs';

function PositionRow({ position, canTrade, onClose }: { position: Position; canTrade: boolean; onClose: (position: Position) => void }) {
  // Re-rendered by this symbol's ticks only.
  const quote = useMarketStore((s) => s.quotes[position.ticker]);
  const setSymbol = useUiStore((s) => s.setSymbol);
  const current = markOf(quote) ?? position.currentPrice;
  const flash = useTickFlash(current);

  const unrealized = (current - position.averagePrice) * position.quantity;
  const basis = position.averagePrice * Math.abs(position.quantity);
  const unrealizedPct = basis > 0 ? (unrealized / basis) * 100 : 0;
  const long = position.quantity > 0;

  return (
    <tr onClick={() => setSymbol(position.ticker)} className="cursor-pointer border-b border-line/60 hover:bg-raised">
      <td className={`${td} font-sans font-semibold text-ink`}>{position.ticker}</td>
      <td className={td}>
        <span className={`rounded-xs px-1 py-px font-sans text-[10px] font-semibold ${long ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>{long ? 'LONG' : 'SHORT'}</span>
      </td>
      <td className={`${td} text-right ${long ? 'text-ink' : 'text-down'}`}>{shares(position.quantity)}</td>
      <td className={`${td} text-right text-dim`}>{price(position.averagePrice)}</td>
      <td className={`${td} text-right`}>
        <span key={flash.key} className={`rounded-xs px-1 ${flash.className}`}>
          {price(current)}
        </span>
      </td>
      <td className={`${td} text-right text-dim`}>{usd(current * position.quantity)}</td>
      <td className={`${td} text-right font-semibold ${pnlColor(unrealized)}`}>{signedUsd(unrealized)}</td>
      <td className={`${td} text-right ${pnlColor(unrealized)}`}>{signedPct(unrealizedPct)}</td>
      <td className={`${td} text-right`}>
        <button
          type="button"
          disabled={!canTrade}
          onClick={(e) => {
            e.stopPropagation();
            onClose(position);
          }}
          className="rounded-xs border border-line px-1.5 py-px font-sans text-[10px] text-dim hover:border-down hover:text-down disabled:opacity-40"
        >
          Close
        </button>
      </td>
    </tr>
  );
}

function PositionsTable({ competition }: { competition: Competition | undefined }) {
  const positions = useTradingStore((s) => s.portfolio?.positions);
  const placeOrder = useTradingStore((s) => s.placeOrder);
  const toast = useTradingStore((s) => s.toast);
  const canTrade = competition?.status === 'ACTIVE';

  if (!positions?.length) return <EmptyState>No open positions. Fills from the order ticket show up here.</EmptyState>;

  async function close(position: Position) {
    if (!competition) return;
    try {
      await placeOrder({
        competitionId: competition.id,
        ticker: position.ticker,
        side: position.quantity > 0 ? 'SELL' : 'BUY',
        type: 'MARKET',
        quantity: Math.abs(position.quantity),
      });
    } catch (err) {
      toast({ tone: 'warn', title: `Could not close ${position.ticker}`, detail: errorMessage(err) });
    }
  }

  return (
    <table className="w-full border-collapse">
      <thead className="sticky top-0 z-10 bg-panel">
        <tr>
          <th className={`${th} text-left`}>Symbol</th>
          <th className={`${th} text-left`}>Side</th>
          <th className={`${th} text-right`}>Qty</th>
          <th className={`${th} text-right`}>Avg price</th>
          <th className={`${th} text-right`}>Current</th>
          <th className={`${th} text-right`}>Mkt value</th>
          <th className={`${th} text-right`}>Unrealized P&amp;L</th>
          <th className={`${th} text-right`}>%</th>
          <th className={th} />
        </tr>
      </thead>
      <tbody>
        {positions.map((position) => (
          <PositionRow key={position.ticker} position={position} canTrade={canTrade} onClose={close} />
        ))}
      </tbody>
    </table>
  );
}

const STATUS_STYLE: Record<Order['status'], string> = {
  OPEN: 'bg-info/15 text-info',
  FILLED: 'bg-up/15 text-up',
  CANCELLED: 'bg-faint/20 text-dim',
  REJECTED: 'bg-accent/15 text-accent',
};

function OrdersTable({ orders, empty }: { orders: Order[]; empty: string }) {
  const cancelOrder = useTradingStore((s) => s.cancelOrder);
  const toast = useTradingStore((s) => s.toast);
  const setSymbol = useUiStore((s) => s.setSymbol);

  if (!orders.length) return <EmptyState>{empty}</EmptyState>;
  const charged = orders.some((order) => order.commission > 0);

  async function cancel(order: Order) {
    try {
      await cancelOrder(order.id);
    } catch (err) {
      toast({ tone: 'warn', title: `Could not cancel ${order.ticker} order`, detail: errorMessage(err) });
    }
  }

  return (
    <table className="w-full border-collapse">
      <thead className="sticky top-0 z-10 bg-panel">
        <tr>
          <th className={`${th} text-left`}>Time</th>
          <th className={`${th} text-left`}>Symbol</th>
          <th className={`${th} text-left`}>Side</th>
          <th className={`${th} text-left`}>Type</th>
          <th className={`${th} text-right`} title="Shares filled so far, of the shares ordered">
            Filled / Qty
          </th>
          <th className={`${th} text-right`}>Stop</th>
          <th className={`${th} text-right`}>Limit</th>
          <th className={`${th} text-right`} title="Average price of the shares that have filled">
            Avg fill
          </th>
          <th className={`${th} text-right`}>Realized</th>
          {charged ? <th className={`${th} text-right`}>Comm.</th> : null}
          <th className={`${th} text-left`}>Status</th>
          <th className={th} />
        </tr>
      </thead>
      <tbody>
        {orders.map((order) => (
          <tr key={order.id} onClick={() => setSymbol(order.ticker)} className="cursor-pointer border-b border-line/60 hover:bg-raised">
            <td className={`${td} text-dim`}>{clock(order.filledAt ?? order.createdAt)}</td>
            <td className={`${td} font-sans font-semibold text-ink`}>{order.ticker}</td>
            <td className={`${td} font-sans font-semibold ${order.side === 'BUY' ? 'text-up' : 'text-down'}`}>{order.side}</td>
            <td
              className={`${td} font-sans text-dim`}
              title={
                exitKind(order)
                  ? 'Bracket exit. It only ever reduces the position, and its partner is cancelled when it fills.'
                  : order.takeProfit !== null || order.stopLoss !== null
                    ? `Bracket: target ${price(order.takeProfit)}, stop-loss ${price(order.stopLoss)}`
                    : undefined
              }
            >
              {exitKind(order) ?? ORDER_TYPE_NAMES[order.type]}
              {order.timeInForce !== 'GTC' ? (
                <span className="ml-1 text-[9px] font-semibold uppercase tracking-wider text-info" title={order.timeInForce === 'IOC' ? 'Immediate or cancel: trades what it can at once, the rest is cancelled' : 'Fill or kill: trades in full at once or not at all'}>
                  {order.timeInForce}
                </span>
              ) : null}
              {order.forcedBy === 'MARGIN_CALL' ? (
                <span className="ml-1 text-[9px] font-semibold uppercase tracking-wider text-down" title="Placed by the platform: the account fell below its maintenance margin, so its positions were closed.">
                  Margin call
                </span>
              ) : exitKind(order) ? (
                <span className="ml-1 text-[9px] font-semibold uppercase tracking-wider text-accent">OCO</span>
              ) : order.takeProfit !== null || order.stopLoss !== null ? (
                <span className="ml-1 text-[9px] font-semibold uppercase tracking-wider text-accent">+ exits</span>
              ) : null}
            </td>
            <td className={`${td} text-right`}>
              {order.filledQuantity === order.quantity ? (
                shares(order.quantity)
              ) : (
                <>
                  <span className={order.filledQuantity > 0 ? 'text-ink' : 'text-faint'}>{shares(order.filledQuantity)}</span>
                  <span className="text-faint"> / </span>
                  {shares(order.quantity)}
                </>
              )}
            </td>
            <td className={`${td} text-right ${order.triggeredAt ? 'text-faint line-through' : 'text-dim'}`} title={order.triggeredAt ? 'Stop price reached' : undefined}>
              {price(order.stopPrice)}
            </td>
            <td className={`${td} text-right text-dim`}>{price(order.limitPrice)}</td>
            <td className={`${td} text-right`}>{price(order.fillPrice)}</td>
            <td className={`${td} text-right ${pnlColor(order.realizedPnl ?? 0)}`}>{order.realizedPnl ? signedUsd(order.realizedPnl) : '—'}</td>
            {charged ? <td className={`${td} text-right text-dim`}>{order.commission > 0 ? usd(order.commission) : '—'}</td> : null}
            <td className={td} title={order.rejectReason ?? (order.status === 'OPEN' && order.filledQuantity > 0 ? 'Part of this order has filled; the rest is still working.' : undefined)}>
              <span className={`rounded-xs px-1 py-px font-sans text-[10px] font-semibold ${STATUS_STYLE[order.status]}`}>
                {order.status === 'OPEN' && order.filledQuantity > 0 ? 'PARTIAL' : order.status}
              </span>
            </td>
            <td className={`${td} text-right`}>
              {order.status === 'OPEN' ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void cancel(order);
                  }}
                  className="rounded-xs border border-line px-1.5 py-px font-sans text-[10px] text-dim hover:border-down hover:text-down"
                >
                  Cancel
                </button>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Every piece that has traded, newest first. An order the book could not fill in one go shows as several. */
function FillsTable({ competition }: { competition: Competition | undefined }) {
  const executions = useTradingStore((s) => s.executions);
  const setSymbol = useUiStore((s) => s.setSymbol);
  // Refetched whenever any order has traded more shares.
  const traded = useTradingStore((s) => s.orders.reduce((sum, order) => sum + order.filledQuantity, 0));
  const competitionId = competition?.id;

  useEffect(() => {
    if (competitionId) void useTradingStore.getState().refreshExecutions(competitionId).catch(() => undefined);
  }, [competitionId, traded]);

  if (!executions.length) return <EmptyState>No fills yet. Each piece of each order that trades is listed here.</EmptyState>;
  const charged = executions.some((fill: Execution) => fill.commission > 0);
  return (
    <table className="w-full border-collapse">
      <thead className="sticky top-0 z-10 bg-panel">
        <tr>
          <th className={`${th} text-left`}>Time</th>
          <th className={`${th} text-left`}>Symbol</th>
          <th className={`${th} text-left`}>Side</th>
          <th className={`${th} text-right`}>Shares</th>
          <th className={`${th} text-right`}>Price</th>
          <th className={`${th} text-right`}>Value</th>
          {charged ? <th className={`${th} text-right`}>Comm.</th> : null}
          <th className={`${th} text-right`}>Realized</th>
        </tr>
      </thead>
      <tbody>
        {executions.map((fill) => (
          <tr key={fill.id} onClick={() => setSymbol(fill.ticker)} className="cursor-pointer border-b border-line/60 hover:bg-raised">
            <td className={`${td} text-dim`}>{clock(fill.executedAt)}</td>
            <td className={`${td} font-sans font-semibold text-ink`}>{fill.ticker}</td>
            <td className={`${td} font-sans font-semibold ${fill.side === 'BUY' ? 'text-up' : 'text-down'}`}>{fill.side}</td>
            <td className={`${td} text-right`}>{shares(fill.quantity)}</td>
            <td className={`${td} text-right`}>{price(fill.price)}</td>
            <td className={`${td} text-right text-dim`}>{usd(fill.price * fill.quantity)}</td>
            {charged ? <td className={`${td} text-right text-dim`}>{fill.commission > 0 ? usd(fill.commission) : '—'}</td> : null}
            <td className={`${td} text-right ${pnlColor(fill.realizedPnl)}`}>{fill.realizedPnl ? signedUsd(fill.realizedPnl) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Saves the order history as a spreadsheet-friendly CSV file. */
function exportOrders(orders: Order[]): void {
  const cell = (value: string | number | null) => (value === null ? '' : /[",\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));
  const rows = [
    ['Time', 'Symbol', 'Side', 'Type', 'Quantity', 'Filled', 'Stop', 'Limit', 'Average fill price', 'Status', 'Realized P&L', 'Commission', 'Note', 'Order ID'],
    ...orders.map((o) => [
      o.filledAt ?? o.createdAt,
      o.ticker,
      o.side,
      o.forcedBy === 'MARGIN_CALL' ? 'Market (margin call)' : exitKind(o) ? `${exitKind(o)} (bracket exit)` : ORDER_TYPE_NAMES[o.type],
      o.quantity,
      o.filledQuantity,
      o.stopPrice,
      o.limitPrice,
      o.fillPrice,
      o.status,
      o.realizedPnl,
      o.commission,
      o.rejectReason,
      o.id,
    ]),
  ];
  const url = URL.createObjectURL(new Blob([rows.map((row) => row.map(cell).join(',')).join('\n')], { type: 'text/csv' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: `gomer-trading-orders-${new Date().toISOString().slice(0, 10)}.csv` });
  link.click();
  URL.revokeObjectURL(url);
}

function Figure({ label, value, tone = 'text-ink', hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="rounded-sm border border-line bg-surface px-3 py-2" title={hint}>
      <dt className="text-[10px] font-medium uppercase tracking-wider text-faint">{label}</dt>
      <dd className={`num mt-0.5 text-sm font-semibold ${tone}`}>{value}</dd>
    </div>
  );
}

/** The trader's own record in this competition. */
function Performance({ competition }: { competition: Competition | undefined }) {
  const traderId = useAuthStore((s) => s.user?.traderId);
  const results = useTradingStore((s) => s.results);
  const competitionId = competition?.id;

  useEffect(() => {
    if (!competitionId) return;
    const refresh = () => void useTradingStore.getState().refreshResults(competitionId).catch(() => undefined);
    refresh();
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [competitionId]);

  const mine = results?.standings.find((row) => row.traderId === traderId);
  if (!competition) return <EmptyState>Join a competition to build a track record.</EmptyState>;
  if (!mine) return <EmptyState>Loading your record…</EmptyState>;

  const closed = mine.wins + mine.losses;
  return (
    <dl className="grid grid-cols-2 gap-1.5 p-2 sm:grid-cols-4">
      <Figure label="Rank" value={`${mine.rank} of ${results!.standings.length}`} />
      <Figure label="Return" value={signedPct(mine.returnPct)} tone={pnlColor(mine.pnl)} />
      <Figure label="Total P&L" value={signedUsd(mine.pnl)} tone={pnlColor(mine.pnl)} />
      <Figure label="Realized P&L" value={signedUsd(mine.realizedPnl)} tone={pnlColor(mine.realizedPnl)} />
      <Figure label="Trades" value={String(mine.trades)} hint="Executed orders" />
      <Figure label="Win rate" value={mine.winRate === null ? '—' : `${mine.winRate.toFixed(0)}%`} hint={`${mine.wins} winning and ${mine.losses} losing closing trades`} />
      <Figure label="Profit factor" value={mine.profitFactor === null ? '—' : mine.profitFactor.toFixed(2)} hint="Gross profit divided by gross loss. Above 1 is profitable." />
      <Figure label="Best / worst trade" value={closed ? `${signedUsd(mine.bestTrade ?? 0)} / ${signedUsd(mine.worstTrade ?? 0)}` : '—'} />
      {mine.commissions > 0 ? <Figure label="Commissions paid" value={usd(mine.commissions)} hint="Already taken out of your cash, so your return and total P&L are after commission." /> : null}
    </dl>
  );
}

/** Bottom window: open positions, working orders, order history and the trader's record. */
export function Blotter({ competition }: { competition: Competition | undefined }) {
  const [tab, setTab] = useState<Tab>('positions');
  const positionCount = useTradingStore((s) => s.portfolio?.positions.length ?? 0);
  const orders = useTradingStore((s) => s.orders);
  const working = orders.filter((o) => o.status === 'OPEN');
  const alertCount = useAlertSymbols().length;

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: 'positions', label: 'Positions', count: positionCount },
    { id: 'working', label: 'Open orders', count: working.length },
    { id: 'history', label: 'Order history' },
    { id: 'fills', label: 'Fills' },
    { id: 'performance', label: 'Performance' },
    { id: 'alerts', label: 'Alerts', count: alertCount },
  ];

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-sm border border-line bg-panel">
      <div role="tablist" className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-line bg-raised">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] ${
              tab === t.id ? 'border-accent text-ink' : 'border-transparent text-dim hover:text-ink'
            }`}
          >
            {t.label}
            {t.count ? <span className="num rounded-full bg-hover px-1.5 text-[10px] font-normal text-dim">{t.count}</span> : null}
          </button>
        ))}
        {tab === 'history' && orders.length > 0 ? (
          <button type="button" onClick={() => exportOrders(orders)} className="my-auto ml-auto mr-2 rounded-xs border border-line px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-dim hover:text-ink">
            Export CSV
          </button>
        ) : null}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-auto">
        {tab === 'positions' ? <PositionsTable competition={competition} /> : null}
        {tab === 'working' ? <OrdersTable orders={working} empty="No working orders. Limit and stop orders wait here until they fill." /> : null}
        {tab === 'history' ? <OrdersTable orders={orders} empty="No orders yet in this competition." /> : null}
        {tab === 'fills' ? <FillsTable competition={competition} /> : null}
        {tab === 'performance' ? <Performance competition={competition} /> : null}
        {tab === 'alerts' ? <AlertsPanel /> : null}
      </div>
    </section>
  );
}

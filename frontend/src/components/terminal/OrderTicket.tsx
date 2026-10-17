'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { errorMessage } from '@/lib/api';
import { price, shares, signedUsd, SYMBOL_PATTERN, usd } from '@/lib/format';
import type { Competition, NewOrder, Order, OrderSide, OrderType } from '@/lib/types';
import { useMarketStore } from '@/store/market';
import { ORDER_TYPE_NAMES, useTradingStore, workingAt } from '@/store/trading';
import { useTicketStore } from '@/store/ticket';
import { useUiStore } from '@/store/ui';
import { Panel } from '../ui/Panel';

const QUICK_SIZES = [10, 100, 500, 1000];
const input = 'num h-8 w-full rounded-sm border border-line bg-surface px-2 text-[13px] text-ink placeholder:text-faint focus:border-info focus:outline-none disabled:opacity-50';
const label = 'mb-1 block text-[10px] font-semibold uppercase tracking-wider text-faint';

const HOTKEYS: Array<[keys: string, action: string]> = [
  ['B', 'Buy at market'],
  ['S', 'Sell at market'],
  ['Shift + B', 'Buy limit at the bid'],
  ['Shift + S', 'Sell limit at the ask'],
  ['F', 'Flatten this symbol'],
  ['C', 'Cancel working orders in this symbol'],
  ['Bracket on', 'B and S add your target and stop'],
  ['+ / −', 'Quantity up / down 100'],
];

const HINT: Record<OrderType, string> = {
  MARKET: 'Market orders trade through the book: the ask (or bid) first, then worse prices if the order is bigger than what is offered there.',
  LIMIT: 'Limit orders rest until the market reaches your price.',
  STOP: 'A stop waits for the market to reach the stop price, then goes in as a market order.',
  STOP_LIMIT: 'A stop-limit waits for the stop price, then works as a limit order at the limit price.',
};

interface Feedback {
  tone: 'up' | 'down' | 'info';
  text: string;
}

function describe(order: Order): Feedback {
  const what = `${order.side} ${shares(order.quantity)} ${order.ticker}`;
  if (order.status === 'FILLED') {
    const pnl = order.realizedPnl ? ` · realized ${signedUsd(order.realizedPnl)}` : '';
    const exits = exitsOf(order);
    return { tone: order.side === 'BUY' ? 'up' : 'down', text: `Filled ${what} @ ${price(order.fillPrice)}${pnl}${exits ? ` · exits working: ${exits}` : ''}` };
  }
  const exits = exitsOf(order);
  if (order.filledQuantity > 0) {
    // The book did not hold the whole order: part is done, the rest fills as it refills.
    return {
      tone: order.side === 'BUY' ? 'up' : 'down',
      text: `Filled ${shares(order.filledQuantity)} of ${shares(order.quantity)} ${order.ticker} @ ${price(order.fillPrice)} average · the rest is working ${workingAt(order)}${exits ? ` · exits working: ${exits}` : ''}`,
    };
  }
  return { tone: 'info', text: `Working ${what}, ${workingAt(order)}${exits ? ` · then ${exits}` : ''}` };
}

/** "target 258.40 · stop 256.90" for an order that carries a bracket, otherwise nothing. */
const exitsOf = (order: Pick<Order, 'takeProfit' | 'stopLoss'>) =>
  [order.takeProfit !== null ? `target ${price(order.takeProfit)}` : null, order.stopLoss !== null ? `stop ${price(order.stopLoss)}` : null].filter(Boolean).join(' · ');

const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));
const cents = (value: number) => Math.round(value * 100) / 100;

/** Level 1 strip: best bid and offer with their sizes. Clicking a side loads its price into the ticket. */
function Level1({ symbol, onPick }: { symbol: string; onPick: (price: number) => void }) {
  const quote = useMarketStore((s) => s.quotes[symbol]);
  const spread = quote && quote.bid > 0 && quote.ask > 0 ? quote.ask - quote.bid : null;
  const cell = 'flex flex-1 flex-col rounded-sm border px-2 py-1.5 text-left transition hover:brightness-125 disabled:hover:brightness-100';

  return (
    <div>
      <div className="flex gap-1.5">
        <button type="button" disabled={!quote} onClick={() => quote && onPick(quote.bid)} className={`${cell} border-up/30 bg-up/10`}>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-up/80">Bid</span>
          <span className="num text-base font-semibold leading-tight text-up">{price(quote?.bid)}</span>
          <span className="num text-[10px] text-dim">{quote ? shares(quote.bidSize) : '—'} shares</span>
        </button>
        <button type="button" disabled={!quote} onClick={() => quote && onPick(quote.ask)} className={`${cell} items-end border-down/30 bg-down/10 text-right`}>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-down/80">Ask</span>
          <span className="num text-base font-semibold leading-tight text-down">{price(quote?.ask)}</span>
          <span className="num text-[10px] text-dim">{quote ? shares(quote.askSize) : '—'} shares</span>
        </button>
      </div>
      <div className="num mt-1 flex justify-between text-[10px] text-faint">
        <span>Last {price(quote?.last)}</span>
        <span>Spread {spread === null ? '—' : spread.toFixed(2)}</span>
      </div>
    </div>
  );
}

export function OrderTicket({ competition }: { competition: Competition | undefined }) {
  const symbol = useUiStore((s) => s.symbol);
  const setSymbol = useUiStore((s) => s.setSymbol);
  const hotkeys = useUiStore((s) => s.hotkeys);
  const setHotkeys = useUiStore((s) => s.setHotkeys);
  const portfolio = useTradingStore((s) => s.portfolio);
  const placeOrder = useTradingStore((s) => s.placeOrder);
  // Only the two prices are selected, so the ticket re-renders when they move, not on every size change.
  const bid = useMarketStore((s) => s.quotes[symbol]?.bid ?? 0);
  const ask = useMarketStore((s) => s.quotes[symbol]?.ask ?? 0);
  const unknown = useMarketStore((s) => Boolean(s.unknown[symbol]));
  // The practice market between sessions: nothing trades, but limit and stop orders can be left for the open.
  const marketShut = useMarketStore((s) => s.feed?.state === 'closed');

  const [symbolDraft, setSymbolDraft] = useState(symbol);
  const [quantity, setQuantity] = useState('100');
  const [type, setType] = useState<OrderType>('MARKET');
  const [limitPrice, setLimitPrice] = useState('');
  const [stopPrice, setStopPrice] = useState('');
  // A bracket is given as distances from the entry, so one setting serves buys and shorts alike.
  const [bracket, setBracket] = useState(false);
  const [targetOffset, setTargetOffset] = useState('1.00');
  const [stopOffset, setStopOffset] = useState('0.50');
  const [submitting, setSubmitting] = useState<OrderSide | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [showKeys, setShowKeys] = useState(false);

  // Follow symbol changes made elsewhere (watchlist, positions). Prices never carry across symbols.
  const [seenSymbol, setSeenSymbol] = useState(symbol);
  if (symbol !== seenSymbol) {
    setSeenSymbol(symbol);
    setSymbolDraft(symbol);
    setLimitPrice('');
    setStopPrice('');
    setFeedback(null);
  }

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 8000);
    return () => clearTimeout(timer);
  }, [feedback]);

  const position = portfolio?.positions.find((p) => p.ticker === symbol);
  const wantsLimit = type === 'LIMIT' || type === 'STOP_LIMIT';
  const wantsStop = type === 'STOP' || type === 'STOP_LIMIT';
  const qty = Number(quantity);
  const limit = Number(limitPrice);
  const stop = Number(stopPrice);
  const qtyValid = Number.isInteger(qty) && qty > 0;
  const limitValid = !wantsLimit || (Number.isFinite(limit) && limit > 0);
  const stopValid = !wantsStop || (Number.isFinite(stop) && stop > 0);
  const tradable = competition?.status === 'ACTIVE' && Boolean(portfolio) && !unknown;
  const target = targetOffset.trim() === '' ? 0 : Number(targetOffset);
  const protect = stopOffset.trim() === '' ? 0 : Number(stopOffset);
  const offsetValid = (value: number) => value === 0 || (Number.isFinite(value) && value >= 0.02);
  const bracketValid = !bracket || (offsetValid(target) && offsetValid(protect) && (target > 0 || protect > 0));
  const canSubmit = tradable && qtyValid && limitValid && stopValid && bracketValid && submitting === null && (type !== 'MARKET' || (bid > 0 && ask > 0 && !marketShut));

  /** Where an order on this side is expected to trade, which is what the exits are measured from. */
  const entryPrice = (side: OrderSide) => (wantsLimit && limitValid ? limit : wantsStop && stopValid ? stop : side === 'BUY' ? ask + 0.01 : bid - 0.01);
  /**
   * The exits for an order on this side, or nothing when the bracket is off or the
   * order would reduce the position (an exit protects a position; it does not ride on a close).
   */
  const exitsFor = useCallback(
    (side: OrderSide, entry: number): Pick<NewOrder, 'takeProfit' | 'stopLoss'> => {
      const held = position?.quantity ?? 0;
      if (!bracket || !bracketValid || entry <= 0 || (side === 'BUY' ? held < 0 : held > 0)) return {};
      const away = side === 'BUY' ? 1 : -1;
      const takeProfit = target > 0 ? cents(entry + away * target) : undefined;
      const stopLoss = protect > 0 ? cents(entry - away * protect) : undefined;
      return { ...(takeProfit && takeProfit > 0 ? { takeProfit } : {}), ...(stopLoss && stopLoss > 0 ? { stopLoss } : {}) };
    },
    [bracket, bracketValid, target, protect, position],
  );
  const preview = (side: OrderSide) => {
    const exits = exitsFor(side, entryPrice(side));
    return exits.takeProfit || exits.stopLoss ? `${exits.takeProfit ? price(exits.takeProfit) : '—'} / ${exits.stopLoss ? price(exits.stopLoss) : '—'}` : 'none';
  };

  const estimate = (side: OrderSide) => {
    if (!qtyValid) return 0;
    if (wantsLimit) return limitValid ? qty * limit : 0;
    if (wantsStop) return stopValid ? qty * stop : 0;
    return qty * (side === 'BUY' ? ask : bid);
  };

  function commitSymbol(event?: FormEvent) {
    event?.preventDefault();
    const next = symbolDraft.trim().toUpperCase();
    if (SYMBOL_PATTERN.test(next)) setSymbol(next);
    else setSymbolDraft(symbol);
  }

  /** Loads a clicked price (Level 1 strip or Level 2 ladder) into whichever field the ticket is asking for. */
  const pickPrice = useCallback(
    (picked: number) => {
      if (type === 'STOP') return setStopPrice(picked.toFixed(2));
      // A market ticket becomes a limit ticket at that price.
      if (type === 'MARKET') setType('LIMIT');
      setLimitPrice(picked.toFixed(2));
    },
    [type],
  );
  const pickedFromLadder = useTicketStore((s) => s.picked);
  const [handledPick, setHandledPick] = useState(pickedFromLadder?.nonce ?? 0);
  if (pickedFromLadder && pickedFromLadder.nonce !== handledPick) {
    setHandledPick(pickedFromLadder.nonce);
    pickPrice(pickedFromLadder.price);
  }

  function changeType(next: OrderType) {
    setType(next);
    if ((next === 'LIMIT' || next === 'STOP_LIMIT') && !limitPrice && ask > 0) setLimitPrice(ask.toFixed(2));
  }

  function maxAffordable() {
    if (!portfolio || ask <= 0) return;
    // Small cushion on market orders for slippage and the next tick.
    const reference = wantsLimit && limitValid ? limit : wantsStop && stopValid ? stop : ask * 1.001;
    setQuantity(String(Math.max(0, Math.floor(portfolio.buyingPower / reference))));
  }

  /** Sends an order and reports the outcome in the ticket. Everything that trades goes through here. */
  const send = useCallback(
    async (order: Omit<NewOrder, 'competitionId' | 'ticker'>) => {
      if (!competition || competition.status !== 'ACTIVE') return;
      setSubmitting(order.side);
      setFeedback(null);
      try {
        setFeedback(describe(await placeOrder({ competitionId: competition.id, ticker: symbol, ...order })));
      } catch (err) {
        setFeedback({ tone: 'down', text: errorMessage(err) });
      } finally {
        setSubmitting(null);
      }
    },
    [competition, placeOrder, symbol],
  );

  function submit(side: OrderSide) {
    if (!canSubmit) return;
    void send({
      side,
      type,
      quantity: qty,
      ...(wantsLimit ? { limitPrice: cents(limit) } : {}),
      ...(wantsStop ? { stopPrice: cents(stop) } : {}),
      ...exitsFor(side, entryPrice(side)),
    });
  }

  // Keyboard order entry. Armed explicitly, and never while typing in a field.
  useEffect(() => {
    if (!hotkeys) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      const size = Number.isInteger(qty) && qty > 0 ? qty : 0;
      const ready = tradable && submitting === null;

      if (key === '+' || key === '=') return setQuantity(String(size + 100));
      if (key === '-' || key === '_') return setQuantity(String(Math.max(100, size - 100)));
      if (!ready) return;

      if (key === 'b' || key === 's') {
        if (!size) return;
        const side: OrderSide = key === 'b' ? 'BUY' : 'SELL';
        event.preventDefault();
        if (!event.shiftKey) return void send({ side, type: 'MARKET', quantity: size, ...exitsFor(side, side === 'BUY' ? ask + 0.01 : bid - 0.01) });
        // Shift: join the queue on your own side of the market instead of crossing it.
        const passive = side === 'BUY' ? bid : ask;
        if (passive > 0) void send({ side, type: 'LIMIT', quantity: size, limitPrice: cents(passive), ...exitsFor(side, passive) });
      } else if (key === 'f') {
        if (!position) return setFeedback({ tone: 'info', text: `No ${symbol} position to flatten.` });
        event.preventDefault();
        void send({ side: position.quantity > 0 ? 'SELL' : 'BUY', type: 'MARKET', quantity: Math.abs(position.quantity) });
      } else if (key === 'c') {
        event.preventDefault();
        const { orders, cancelOrder } = useTradingStore.getState();
        const working = orders.filter((o) => o.status === 'OPEN' && o.ticker === symbol);
        setFeedback({ tone: 'info', text: working.length ? `Cancelling ${working.length} working ${symbol} order${working.length === 1 ? '' : 's'}.` : `No working ${symbol} orders.` });
        for (const order of working) void cancelOrder(order.id).catch(() => undefined);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkeys, tradable, submitting, qty, bid, ask, position, symbol, send, exitsFor]);

  const blocked = !competition
    ? 'Select a competition to trade.'
    : competition.status === 'UPCOMING'
      ? 'This competition has not started yet.'
      : competition.status === 'ENDED'
        ? 'This competition has ended. Trading is closed.'
        : unknown
          ? `No market data for ${symbol}.`
          : null;

  return (
    <Panel
      title="Order Ticket"
      actions={
        <>
          <button
            type="button"
            onClick={() => setHotkeys(!hotkeys)}
            aria-pressed={hotkeys}
            title={hotkeys ? 'Keyboard order entry is armed. Click to disarm.' : 'Arm keyboard order entry'}
            className={`rounded-xs border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider ${hotkeys ? 'border-accent bg-accent text-surface' : 'border-line text-dim hover:text-ink'}`}
          >
            Hotkeys {hotkeys ? 'on' : 'off'}
          </button>
          <button
            type="button"
            onClick={() => setShowKeys((open) => !open)}
            aria-expanded={showKeys}
            aria-label="Show keyboard shortcuts"
            className="size-5 rounded-xs border border-line text-[11px] text-dim hover:text-ink"
          >
            ?
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5 p-2.5">
        {showKeys ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-sm border border-line bg-surface p-2 text-[11px]">
            {HOTKEYS.map(([keys, action]) => (
              <div key={keys} className="contents">
                <dt className="num whitespace-nowrap font-semibold text-ink">{keys}</dt>
                <dd className="text-dim">{action}</dd>
              </div>
            ))}
            <dd className="col-span-2 mt-1 text-faint">Hotkeys use the quantity in the ticket and send immediately, with no confirmation. They are ignored while you type in a field.</dd>
          </dl>
        ) : null}

        <form onSubmit={commitSymbol}>
          <label htmlFor="ticket-symbol" className={label}>
            Symbol
          </label>
          <input
            id="ticket-symbol"
            value={symbolDraft}
            onChange={(e) => setSymbolDraft(e.target.value.toUpperCase())}
            onBlur={() => commitSymbol()}
            maxLength={10}
            spellCheck={false}
            className={`${input} font-semibold`}
          />
        </form>

        <Level1
          symbol={symbol}
          onPick={pickPrice}
        />

        <div>
          <div className="mb-1 flex items-center justify-between">
            <label htmlFor="ticket-quantity" className={`${label} mb-0`}>
              Quantity
            </label>
            <div className="flex gap-1">
              {QUICK_SIZES.map((size) => (
                <button key={size} type="button" onClick={() => setQuantity(String(size))} className="num rounded-xs px-1 text-[10px] text-dim hover:bg-hover hover:text-ink">
                  {size}
                </button>
              ))}
              <button type="button" onClick={maxAffordable} className="rounded-xs px-1 text-[10px] font-semibold text-accent hover:bg-hover">
                MAX
              </button>
            </div>
          </div>
          <input
            id="ticket-quantity"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            aria-invalid={!qtyValid}
            className={`${input} ${quantity && !qtyValid ? 'border-down' : ''}`}
          />
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <div>
            <label htmlFor="ticket-type" className={label}>
              Type
            </label>
            <select id="ticket-type" value={type} onChange={(e) => changeType(e.target.value as OrderType)} className={`${input} px-1 font-sans`}>
              {(Object.keys(ORDER_TYPE_NAMES) as OrderType[]).map((value) => (
                <option key={value} value={value}>
                  {ORDER_TYPE_NAMES[value]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="ticket-stop" className={label}>
              Stop
            </label>
            <input
              id="ticket-stop"
              type="number"
              inputMode="decimal"
              min={0.01}
              step={0.01}
              value={wantsStop ? stopPrice : ''}
              onChange={(e) => setStopPrice(e.target.value)}
              disabled={!wantsStop}
              placeholder={wantsStop ? '0.00' : '—'}
              className={`${input} ${wantsStop && stopPrice && !stopValid ? 'border-down' : ''}`}
            />
          </div>
          <div>
            <label htmlFor="ticket-limit" className={label}>
              Limit
            </label>
            <input
              id="ticket-limit"
              type="number"
              inputMode="decimal"
              min={0.01}
              step={0.01}
              value={wantsLimit ? limitPrice : ''}
              onChange={(e) => setLimitPrice(e.target.value)}
              disabled={!wantsLimit}
              placeholder={wantsLimit ? '0.00' : type === 'MARKET' ? 'MKT' : '—'}
              className={`${input} ${wantsLimit && limitPrice && !limitValid ? 'border-down' : ''}`}
            />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <div>
            <span className={label}>Bracket</span>
            <button
              type="button"
              onClick={() => setBracket(!bracket)}
              aria-pressed={bracket}
              title="Attach a profit target and a stop-loss to the order. When one fills, the other is cancelled."
              className={`h-8 w-full rounded-sm border text-[11px] font-semibold uppercase tracking-wider transition ${bracket ? 'border-accent bg-accent text-surface' : 'border-line text-dim hover:text-ink'}`}
            >
              {bracket ? 'On' : 'Off'}
            </button>
          </div>
          <div>
            <label htmlFor="ticket-target" className={label}>
              Target +
            </label>
            <input
              id="ticket-target"
              type="number"
              inputMode="decimal"
              min={0}
              step={0.05}
              value={bracket ? targetOffset : ''}
              onChange={(e) => setTargetOffset(e.target.value)}
              disabled={!bracket}
              placeholder={bracket ? 'none' : '—'}
              title="How far in your favour to take profit, in dollars per share from the entry"
              className={`${input} ${bracket && !offsetValid(target) ? 'border-down' : ''}`}
            />
          </div>
          <div>
            <label htmlFor="ticket-protect" className={label}>
              Stop −
            </label>
            <input
              id="ticket-protect"
              type="number"
              inputMode="decimal"
              min={0}
              step={0.05}
              value={bracket ? stopOffset : ''}
              onChange={(e) => setStopOffset(e.target.value)}
              disabled={!bracket}
              placeholder={bracket ? 'none' : '—'}
              title="How far against you to cut the loss, in dollars per share from the entry"
              className={`${input} ${bracket && !offsetValid(protect) ? 'border-down' : ''}`}
            />
          </div>
        </div>

        <dl className="num grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px]">
          <dt className="font-sans text-faint">Buying power</dt>
          <dd className="text-right text-ink">{portfolio ? usd(portfolio.buyingPower) : '—'}</dd>
          <dt className="font-sans text-faint">Est. buy / sell</dt>
          <dd className="text-right text-dim">
            {usd(estimate('BUY'))} / {usd(estimate('SELL'))}
          </dd>
          {portfolio && portfolio.commissionPerShare > 0 ? (
            <>
              <dt className="font-sans text-faint" title={`$${portfolio.commissionPerShare.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} a share, charged on every share that trades`}>
                Commission
              </dt>
              <dd className="text-right text-dim">{qtyValid ? usd(qty * portfolio.commissionPerShare) : '—'}</dd>
            </>
          ) : null}
          {bracket ? (
            <>
              <dt className="font-sans text-faint">Exits if you buy</dt>
              <dd className="text-right text-dim">{bracketValid ? preview('BUY') : 'check target / stop'}</dd>
              <dt className="font-sans text-faint">Exits if you short</dt>
              <dd className="text-right text-dim">{bracketValid ? preview('SELL') : 'check target / stop'}</dd>
            </>
          ) : null}
          <dt className="font-sans text-faint">Position</dt>
          <dd className={`text-right ${position ? (position.quantity > 0 ? 'text-up' : 'text-down') : 'text-dim'}`}>
            {position ? `${position.quantity > 0 ? '+' : ''}${shares(position.quantity)} @ ${price(position.averagePrice)}` : 'Flat'}
          </dd>
        </dl>

        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={() => submit('BUY')}
            disabled={!canSubmit}
            className="h-10 rounded-sm bg-up text-sm font-bold tracking-wide text-surface transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35"
          >
            {submitting === 'BUY' ? 'Sending…' : 'BUY'}
          </button>
          <button
            type="button"
            onClick={() => submit('SELL')}
            disabled={!canSubmit}
            className="h-10 rounded-sm bg-down text-sm font-bold tracking-wide text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35"
          >
            {submitting === 'SELL' ? 'Sending…' : position && position.quantity > 0 ? 'SELL' : 'SELL / SHORT'}
          </button>
        </div>

        <p
          role="status"
          className={`min-h-8 text-[11px] leading-snug ${
            blocked ? 'text-accent' : feedback ? (feedback.tone === 'up' ? 'text-up' : feedback.tone === 'down' ? 'text-down' : 'text-info') : 'text-faint'
          }`}
        >
          {blocked ??
            feedback?.text ??
            (marketShut
              ? type === 'MARKET'
                ? 'The market is closed, so a market order has nothing to trade against. Switch to a limit or stop order and it will wait for the opening bell.'
                : 'The market is closed. This order will wait and go to work at the opening bell.'
              : null) ??
            (bracket ? 'Bracket on: when the order fills, a profit target and a stop-loss go to work. One cancels the other, and closing the position cancels both.' : HINT[type])}
        </p>
      </div>
    </Panel>
  );
}

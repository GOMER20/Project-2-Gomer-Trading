'use client';

import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { markOf, price, signedPct } from '@/lib/format';
import type { Bar, Quote, Timeframe } from '@/lib/types';
import { useMarketStore } from '@/store/market';
import { useTradingStore } from '@/store/trading';
import { useUiStore } from '@/store/ui';
import { Panel } from '../ui/Panel';

const TIMEFRAMES: Array<{ id: Timeframe; label: string; seconds: number }> = [
  { id: '1Min', label: '1m', seconds: 60 },
  { id: '5Min', label: '5m', seconds: 300 },
  { id: '15Min', label: '15m', seconds: 900 },
  { id: '1Hour', label: '1h', seconds: 3600 },
];

// Mirrors the @theme tokens in globals.css; the chart canvas cannot read CSS variables.
const COLORS = { up: '#22c074', down: '#f2495c', text: '#8492a2', grid: '#141b24', line: '#1d2732', accent: '#f0b429', info: '#58a6ff', ema9: '#c084fc', ema20: '#58a6ff', vwap: '#f0b429' };
const VISIBLE_BARS = 140;

type IndicatorId = 'ema9' | 'ema20' | 'vwap';
const INDICATORS: Array<{ id: IndicatorId; label: string; title: string; color: string }> = [
  { id: 'ema9', label: 'EMA 9', title: 'Exponential moving average of the last 9 candles', color: COLORS.ema9 },
  { id: 'ema20', label: 'EMA 20', title: 'Exponential moving average of the last 20 candles', color: COLORS.ema20 },
  { id: 'vwap', label: 'VWAP', title: "Volume-weighted average price since the start of the day", color: COLORS.vwap },
];

/** Lightweight Charts renders timestamps as UTC; shifting them shows the trader's local time instead. */
const toChartTime = (epochSeconds: number) => (epochSeconds - new Date(epochSeconds * 1000).getTimezoneOffset() * 60) as UTCTimestamp;

const toCandle = (bar: Bar): CandlestickData<UTCTimestamp> => ({ time: toChartTime(bar.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close });
const toVolume = (bar: Bar) => ({ time: toChartTime(bar.time), value: bar.volume, color: bar.close >= bar.open ? `${COLORS.up}55` : `${COLORS.down}55` });

const emaAlpha = (period: number) => 2 / (period + 1);

/** Exponential moving average of the closes, one value per bar. */
function ema(bars: Bar[], period: number): number[] {
  const alpha = emaAlpha(period);
  const out: number[] = [];
  bars.forEach((bar, i) => out.push(i === 0 ? bar.close : alpha * bar.close + (1 - alpha) * out[i - 1]!));
  return out;
}

/** Volume-weighted average price, restarting at each local midnight. */
function vwap(bars: Bar[]): number[] {
  const out: number[] = [];
  let day = '';
  let value = 0;
  let volume = 0;
  for (const bar of bars) {
    const today = new Date(bar.time * 1000).toDateString();
    if (today !== day) {
      day = today;
      value = 0;
      volume = 0;
    }
    value += ((bar.high + bar.low + bar.close) / 3) * bar.volume;
    volume += bar.volume;
    out.push(volume > 0 ? value / volume : bar.close);
  }
  return out;
}

function Header({ symbol }: { symbol: string }) {
  const quote = useMarketStore((s) => s.quotes[symbol]);
  const change = quote?.prevClose ? quote.last - quote.prevClose : null;
  const changePct = change !== null && quote?.prevClose ? (change / quote.prevClose) * 100 : null;
  const tone = change === null ? 'text-dim' : change >= 0 ? 'text-up' : 'text-down';

  return (
    <span className="flex items-baseline gap-2.5 normal-case tracking-normal">
      <span className="text-[13px] font-bold text-ink">{symbol}</span>
      <span className={`num text-[13px] font-semibold ${tone}`}>{price(quote?.last)}</span>
      {change !== null && changePct !== null ? (
        <span className={`num text-[11px] ${tone}`}>
          {change >= 0 ? '+' : ''}
          {change.toFixed(2)} ({signedPct(changePct)})
        </span>
      ) : null}
      <span className="num hidden text-[11px] font-normal text-faint xl:inline">
        B {price(quote?.bid)} × A {price(quote?.ask)}
      </span>
    </span>
  );
}

/** Candlestick chart: history over REST, then the forming candle is driven by the live WebSocket feed. */
export function ChartPanel() {
  const symbol = useUiStore((s) => s.symbol);
  const timeframe = useUiStore((s) => s.timeframe);
  const setTimeframe = useUiStore((s) => s.setTimeframe);
  const indicators = useUiStore((s) => s.indicators);
  const toggleIndicator = useUiStore((s) => s.toggleIndicator);
  const position = useTradingStore((s) => s.portfolio?.positions.find((p) => p.ticker === symbol));
  const orders = useTradingStore((s) => s.orders);

  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null);
  const overlays = useRef<Record<IndicatorId, ISeriesApi<'Line'>> | null>(null);
  const [state, setState] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });

  // Create the chart once.
  useEffect(() => {
    if (!container.current) return;
    const instance = createChart(container.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: COLORS.text, fontSize: 11, attributionLogo: true },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: COLORS.line, scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: { borderColor: COLORS.line, timeVisible: true, secondsVisible: false, rightOffset: 6 },
    });
    candles.current = instance.addSeries(CandlestickSeries, {
      upColor: COLORS.up,
      downColor: COLORS.down,
      borderVisible: false,
      wickUpColor: COLORS.up,
      wickDownColor: COLORS.down,
    });
    volume.current = instance.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false });
    instance.priceScale('volume').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    const line = (color: string) => instance.addSeries(LineSeries, { color, lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    overlays.current = { ema9: line(COLORS.ema9), ema20: line(COLORS.ema20), vwap: line(COLORS.vwap) };
    chart.current = instance;

    return () => {
      instance.remove();
      chart.current = null;
      candles.current = null;
      volume.current = null;
      overlays.current = null;
    };
  }, []);

  // Show or hide overlays without reloading anything.
  useEffect(() => {
    for (const { id } of INDICATORS) overlays.current?.[id].applyOptions({ visible: indicators[id] });
  }, [indicators]);

  // Load history for the symbol/timeframe, then keep the last candle live.
  useEffect(() => {
    const seconds = TIMEFRAMES.find((t) => t.id === timeframe)?.seconds ?? 60;
    const abort = new AbortController();
    let last: CandlestickData<UTCTimestamp> | null = null;
    let resync: ReturnType<typeof setTimeout> | null = null;
    // Each average as of the candle before the forming one, so the forming candle's value can follow the price.
    let before = { ema9: 0, ema20: 0, vwap: 0 };
    let now = { ema9: 0, ema20: 0, vwap: 0 };

    const load = async (initial: boolean) => {
      try {
        const { bars } = await api<{ bars: Bar[] }>(`/api/market/bars/${encodeURIComponent(symbol)}?timeframe=${timeframe}&limit=500`, { signal: abort.signal });
        if (abort.signal.aborted || !candles.current || !volume.current || !overlays.current) return;
        candles.current.setData(bars.map(toCandle));
        volume.current.setData(bars.map(toVolume));

        const series = { ema9: ema(bars, 9), ema20: ema(bars, 20), vwap: vwap(bars) };
        for (const { id } of INDICATORS) overlays.current[id].setData(bars.map((bar, i) => ({ time: toChartTime(bar.time), value: series[id][i]! })));
        const at = (id: IndicatorId, fromEnd: number) => series[id][series[id].length - fromEnd] ?? bars[bars.length - 1]?.close ?? 0;
        now = { ema9: at('ema9', 1), ema20: at('ema20', 1), vwap: at('vwap', 1) };
        before = { ema9: at('ema9', 2), ema20: at('ema20', 2), vwap: at('vwap', 2) };

        const newest = bars[bars.length - 1];
        // Do not step back over a candle the live feed has already advanced.
        if (newest && (!last || toChartTime(newest.time) >= last.time)) last = toCandle(newest);
        if (initial) {
          chart.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - VISIBLE_BARS), to: bars.length + 5 });
          setState({ loading: false, error: bars.length ? null : `No chart history for ${symbol}` });
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        if (initial) setState({ loading: false, error: errorMessage(err) });
      }
    };

    const onQuote = (quote: Quote | undefined) => {
      const mark = markOf(quote);
      if (!quote || !mark || !last || !candles.current || !overlays.current) return;
      const time = toChartTime(Math.floor(quote.ts / 1000 / seconds) * seconds);
      if (time < last.time) return; // stale tick: the series only moves forward
      if (time === last.time) {
        last = { ...last, high: Math.max(last.high, mark), low: Math.min(last.low, mark), close: mark };
      } else {
        last = { time, open: last.close, high: Math.max(last.close, mark), low: Math.min(last.close, mark), close: mark };
        before = now;
        // A candle just closed: pull the server's finished bars (with volume) shortly after.
        if (resync) clearTimeout(resync);
        resync = setTimeout(() => void load(false), 1500);
      }
      candles.current.update(last);
      // The moving averages follow the forming candle; VWAP needs its volume, so it waits for the resync.
      now = {
        ema9: emaAlpha(9) * mark + (1 - emaAlpha(9)) * before.ema9,
        ema20: emaAlpha(20) * mark + (1 - emaAlpha(20)) * before.ema20,
        vwap: now.vwap,
      };
      for (const { id } of INDICATORS) overlays.current[id].update({ time: last.time, value: now[id] });
    };

    setState({ loading: true, error: null });
    candles.current?.setData([]);
    volume.current?.setData([]);
    for (const { id } of INDICATORS) overlays.current?.[id].setData([]);
    void load(true);

    const unsubscribe = useMarketStore.subscribe((current, previous) => {
      if (current.quotes[symbol] !== previous.quotes[symbol]) onQuote(current.quotes[symbol]);
    });

    return () => {
      abort.abort();
      unsubscribe();
      if (resync) clearTimeout(resync);
    };
  }, [symbol, timeframe]);

  // Horizontal lines for the open position's average price and any working orders.
  const working = orders.filter((o) => o.status === 'OPEN' && o.ticker === symbol);
  const linesKey = JSON.stringify([position?.quantity, position?.averagePrice, working.map((o) => [o.id, o.side, o.quantity, o.limitPrice, o.stopPrice, o.triggeredAt, o.parentId])]);
  useEffect(() => {
    const series = candles.current;
    if (!series) return;
    const lines: IPriceLine[] = [];
    if (position) {
      lines.push(
        series.createPriceLine({
          price: position.averagePrice,
          color: COLORS.accent,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `${position.quantity > 0 ? 'LONG' : 'SHORT'} ${Math.abs(position.quantity)}`,
        }),
      );
    }
    for (const order of working) {
      // An untriggered stop is drawn at its stop price; everything else at its limit.
      const waitingForStop = order.stopPrice !== null && !order.triggeredAt;
      const at = waitingForStop ? order.stopPrice : order.limitPrice;
      if (at === null) continue;
      lines.push(
        series.createPriceLine({
          price: at,
          color: order.side === 'BUY' ? COLORS.up : COLORS.down,
          lineWidth: 1,
          lineStyle: waitingForStop ? LineStyle.LargeDashed : LineStyle.Dotted,
          axisLabelVisible: true,
          // A bracket exit is named for what it is there to do.
          title: order.parentId ? `${waitingForStop ? 'STOP-LOSS' : 'TARGET'} ${order.quantity}` : `${order.side} ${order.quantity}${waitingForStop ? ' STOP' : ''}`,
        }),
      );
    }
    return () => {
      // The series is already gone if the chart itself was torn down.
      if (candles.current === series) for (const line of lines) series.removePriceLine(line);
    };
    // linesKey captures everything the lines are drawn from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey, symbol]);

  const toggle = 'num h-5 rounded-xs px-1.5 text-[11px]';
  return (
    <Panel
      title={<Header symbol={symbol} />}
      className="h-full"
      actions={
        <>
          {INDICATORS.map((indicator) => (
            <button
              key={indicator.id}
              type="button"
              title={indicator.title}
              onClick={() => toggleIndicator(indicator.id)}
              aria-pressed={indicators[indicator.id]}
              className={`${toggle} hidden items-center gap-1 md:flex ${indicators[indicator.id] ? 'text-ink' : 'text-faint hover:text-dim'}`}
            >
              <span className="h-0.5 w-2.5 rounded-full" style={{ background: indicators[indicator.id] ? indicator.color : 'currentColor' }} />
              {indicator.label}
            </button>
          ))}
          <span className="mx-1 hidden h-3.5 w-px bg-line md:block" />
          {TIMEFRAMES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTimeframe(t.id)}
              aria-pressed={timeframe === t.id}
              className={`${toggle} ${timeframe === t.id ? 'bg-accent font-semibold text-surface' : 'text-dim hover:bg-hover hover:text-ink'}`}
            >
              {t.label}
            </button>
          ))}
        </>
      }
    >
      <div className="relative h-full min-h-48">
        <div ref={container} className="absolute inset-0" />
        {state.loading || state.error ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-faint">
            {state.error ?? 'Loading chart…'}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

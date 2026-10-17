'use client';

import { BaselineSeries, ColorType, CrosshairMode, LineSeries, LineStyle, createChart, type IChartApi, type UTCTimestamp } from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';

/** The terminal's chart colours (see ChartPanel). */
export const CHART = { up: '#22c074', down: '#f2495c', text: '#8492a2', grid: '#141b24', line: '#1d2732' };
/** Two series on one chart: checked to stay apart for colour-blind readers against the panel colour. */
const SERIES = ['#4a95e8', '#bf8410'] as const;

/** Charts show the viewer's own clock: shift UTC seconds by the local offset at that moment. */
const local = (epochSeconds: number) => (epochSeconds - new Date(epochSeconds * 1000).getTimezoneOffset() * 60) as UTCTimestamp;

/** One value per moment, oldest first: a later value at the same second replaces the earlier one. */
function series(points: Array<{ time: number; value: number }>) {
  const out: Array<{ time: UTCTimestamp; value: number }> = [];
  for (const point of points) {
    const time = local(point.time);
    if (out.length && out[out.length - 1]!.time >= time) out[out.length - 1] = { time: out[out.length - 1]!.time, value: point.value };
    else out.push({ time, value: point.value });
  }
  return out;
}

function baseChart(element: HTMLElement): IChartApi {
  return createChart(element, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: CHART.text, fontSize: 11, attributionLogo: true },
    grid: { vertLines: { visible: false }, horzLines: { color: CHART.grid } },
    crosshair: { mode: CrosshairMode.Magnet },
    rightPriceScale: { borderColor: CHART.line },
    timeScale: { borderColor: CHART.line, timeVisible: true, secondsVisible: false },
  });
}

/**
 * A running total in dollars: green above zero, red below, so whether it is
 * ahead or behind reads at a glance. Hovering shows the value at that point.
 */
export function RunningTotalChart({ points, describe }: { points: Array<{ time: number; value: number }>; describe: (value: number, time: number) => string }) {
  const element = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    if (!element.current) return;
    const chart = baseChart(element.current);
    const line = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: 0 },
      topLineColor: CHART.up,
      topFillColor1: `${CHART.up}40`,
      topFillColor2: `${CHART.up}05`,
      bottomLineColor: CHART.down,
      bottomFillColor1: `${CHART.down}05`,
      bottomFillColor2: `${CHART.down}40`,
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    line.createPriceLine({ price: 0, color: CHART.line, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: false });
    const data = series(points);
    line.setData(data);
    chart.timeScale().fitContent();
    chart.subscribeCrosshairMove((param) => {
      const value = param.seriesData.get(line) as { value?: number } | undefined;
      if (!param.time || value?.value === undefined) return setHover(null);
      const index = data.findIndex((point) => point.time === param.time);
      setHover(describe(value.value, index >= 0 ? points[Math.min(index, points.length - 1)]!.time : Number(param.time)));
    });
    return () => chart.remove();
  }, [points, describe]);

  return (
    <div className="relative h-full min-h-48">
      <div ref={element} className="absolute inset-0" />
      {hover ? <div className="pointer-events-none absolute left-2 top-1 rounded-sm border border-line bg-raised/95 px-2 py-1 text-[11px] text-ink">{hover}</div> : null}
    </div>
  );
}

/**
 * Two measures of the same thing on one scale (for HFT: the typical time per
 * order and the time 99 orders in 100 beat), with a legend that names them.
 */
export function TwoLineChart({
  first,
  second,
  format,
}: {
  first: { name: string; points: Array<{ time: number; value: number }> };
  second: { name: string; points: Array<{ time: number; value: number }> };
  format: (value: number) => string;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    if (!element.current) return;
    const chart = baseChart(element.current);
    const options = { lineWidth: 2 as const, priceFormat: { type: 'custom' as const, formatter: format, minMove: 1 }, pointMarkersVisible: true, pointMarkersRadius: 4 };
    const a = chart.addSeries(LineSeries, { ...options, color: SERIES[0], title: first.name });
    const b = chart.addSeries(LineSeries, { ...options, color: SERIES[1], title: second.name });
    a.setData(series(first.points));
    b.setData(series(second.points));
    chart.timeScale().fitContent();
    chart.subscribeCrosshairMove((param) => {
      const va = param.seriesData.get(a) as { value?: number } | undefined;
      const vb = param.seriesData.get(b) as { value?: number } | undefined;
      if (!param.time || (va?.value === undefined && vb?.value === undefined)) return setHover(null);
      setHover([va?.value !== undefined ? `${first.name}: ${format(va.value)}` : null, vb?.value !== undefined ? `${second.name}: ${format(vb.value)}` : null].filter(Boolean).join(' · '));
    });
    return () => chart.remove();
  }, [first, second, format]);

  return (
    <div className="flex h-full min-h-48 flex-col">
      <div className="flex shrink-0 items-center gap-4 px-2 pt-1 text-[11px] text-dim">
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded-full" style={{ background: SERIES[0] }} />
          {first.name}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded-full" style={{ background: SERIES[1] }} />
          {second.name}
        </span>
        {hover ? <span className="ml-auto text-ink">{hover}</span> : null}
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={element} className="absolute inset-0" />
      </div>
    </div>
  );
}

import { describe, expect, it } from 'vitest';
import { MarketModel, MOODS, seededRandom, type Mood } from '../src/market/model.js';
import { LISTINGS } from '../src/market/universe.js';

const MINUTE = 120;
const HOUR = 60 * MINUTE;

function returnsOf(model: MarketModel, symbols: string[], ticks: number, every = MINUTE): Record<string, number[]> {
  const out: Record<string, number[]> = Object.fromEntries(symbols.map((s) => [s, []]));
  let previous = Object.fromEntries(symbols.map((s) => [s, model.priceOf(s)]));
  for (let t = 1; t <= ticks; t++) {
    model.step();
    if (t % every !== 0) continue;
    for (const s of symbols) {
      out[s]!.push(Math.log(model.priceOf(s) / previous[s]!));
      previous[s] = model.priceOf(s);
    }
  }
  return out;
}

const only = (...symbols: string[]) => LISTINGS.filter((listing) => symbols.includes(listing.symbol));

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
function correlation(a: number[], b: number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  return mean(a.map((x, i) => (x - ma) * (b[i]! - mb))) / (std(a) * std(b));
}

// Several of these simulate many hours of trading.
describe('MarketModel', { timeout: 60_000 }, () => {
  it('is fully reproducible from a seed', () => {
    const a = new MarketModel(LISTINGS, seededRandom(42));
    const b = new MarketModel(LISTINGS, seededRandom(42));
    for (let i = 0; i < 2000; i++) {
      a.step();
      b.step();
    }
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(a.priceOf('AAPL')).toBe(b.priceOf('AAPL'));
  });

  it('opens every listing near its reference price', () => {
    const model = new MarketModel(LISTINGS, seededRandom(1));
    for (const listing of LISTINGS) {
      expect(Math.abs(model.priceOf(listing.symbol) / listing.price - 1)).toBeLessThan(0.06);
    }
  });

  it('continues exactly from a saved state', () => {
    const original = new MarketModel(LISTINGS, seededRandom(7));
    for (let i = 0; i < 500; i++) original.step();
    const saved = JSON.parse(JSON.stringify(original.snapshot()));

    const restored = new MarketModel(LISTINGS, seededRandom(99), saved);
    expect(restored.mood).toBe(original.mood);
    for (const { symbol } of LISTINGS) expect(restored.priceOf(symbol)).toBeCloseTo(original.priceOf(symbol), 10);
  });

  it('gives a newly listed symbol a fresh start when restoring older state', () => {
    const older = new MarketModel(LISTINGS.slice(0, 5), seededRandom(3));
    const restored = new MarketModel(LISTINGS, seededRandom(3), older.snapshot());
    expect(restored.priceOf('SPY')).toBeGreaterThan(400);
  });

  it('stays in a believable range over a long run', () => {
    const model = new MarketModel(LISTINGS, seededRandom(2024));
    for (let i = 0; i < 12 * HOUR; i++) model.step();
    for (const listing of LISTINGS) {
      const ratio = model.priceOf(listing.symbol) / listing.price;
      expect(ratio, listing.symbol).toBeGreaterThan(0.4);
      expect(ratio, listing.symbol).toBeLessThan(2.5);
    }
  });

  it('makes volatile names move more than defensive ones', () => {
    const model = new MarketModel(only('TSLA', 'KO', 'GME', 'SPY'), seededRandom(11));
    const r = returnsOf(model, ['TSLA', 'KO', 'GME', 'SPY'], 30 * HOUR);
    expect(std(r.TSLA!)).toBeGreaterThan(2 * std(r.KO!));
    expect(std(r.GME!)).toBeGreaterThan(std(r.TSLA!));
    expect(std(r.SPY!)).toBeLessThan(std(r.KO!) * 1.2);
  });

  it('moves stocks in the same sector together, and funds with the market', () => {
    const model = new MarketModel(only('NVDA', 'AMD', 'KO', 'SPY', 'QQQ', 'MSFT'), seededRandom(5));
    const r = returnsOf(model, ['NVDA', 'AMD', 'KO', 'SPY', 'QQQ', 'MSFT'], 40 * HOUR, 5 * MINUTE);
    const sameSector = correlation(r.NVDA!, r.AMD!);
    const unrelated = correlation(r.NVDA!, r.KO!);
    expect(sameSector).toBeGreaterThan(unrelated + 0.05);
    expect(correlation(r.SPY!, r.QQQ!)).toBeGreaterThan(0.6);
    expect(correlation(r.MSFT!, r.QQQ!)).toBeGreaterThan(0.25);
  });

  it('clusters volatility: big moves follow big moves', () => {
    const model = new MarketModel(only('AMD'), seededRandom(13));
    const magnitudes = returnsOf(model, ['AMD'], 60 * HOUR).AMD!.map(Math.abs);
    expect(correlation(magnitudes.slice(1), magnitudes.slice(0, -1))).toBeGreaterThan(0.08);
  });

  it('cycles through every mood, and sell-offs fall while rallies rise', () => {
    const model = new MarketModel(only('SPY'), seededRandom(21));
    const seen = new Set<Mood>();
    const spyByMood: Record<string, number[]> = {};
    let previous = model.priceOf('SPY');
    for (let i = 0; i < 80 * HOUR; i++) {
      model.step();
      seen.add(model.mood);
      const price = model.priceOf('SPY');
      (spyByMood[model.mood] ??= []).push(Math.log(price / previous));
      previous = price;
    }
    expect([...seen].sort()).toEqual(Object.keys(MOODS).sort());
    expect(mean(spyByMood.RALLY!)).toBeGreaterThan(0);
    expect(mean(spyByMood.SELLOFF!)).toBeLessThan(0);
    expect(std(spyByMood.TURBULENT!)).toBeGreaterThan(1.5 * std(spyByMood.CALM!));
  });

  it('reports mood changes, gaps and volatility surges as events', () => {
    const model = new MarketModel(only('TSLA', 'GME', 'COIN', 'AMD'), seededRandom(8));
    const kinds = new Set<string>();
    for (let i = 0; i < 20 * HOUR; i++) for (const event of model.step().events) kinds.add(event.kind);
    expect([...kinds].sort()).toEqual(['gap', 'mood', 'surge']);
  });

  it('pushes the price in the direction of an order, by more for bigger orders, then fades', () => {
    // A source that never moves anything: Box-Muller turns (0.25, 0.25) into exactly zero,
    // and 0.25 is far above the per-tick odds of a mood change or a gap.
    const quiet = () => 0.25;
    const base = new MarketModel(LISTINGS, seededRandom(4));
    const start = base.priceOf('AAPL');

    const small = new MarketModel(LISTINGS, quiet, base.snapshot());
    small.applyFlow('AAPL', 100);
    const large = new MarketModel(LISTINGS, quiet, base.snapshot());
    large.applyFlow('AAPL', 5000);
    const sold = new MarketModel(LISTINGS, quiet, base.snapshot());
    sold.applyFlow('AAPL', -5000);

    expect(small.priceOf('AAPL')).toBeGreaterThan(start);
    expect(large.priceOf('AAPL') - start).toBeGreaterThan(5 * (small.priceOf('AAPL') - start));
    expect(large.priceOf('AAPL') / start - 1).toBeCloseTo(0.0004, 4);
    expect(sold.priceOf('AAPL')).toBeLessThan(start);

    const pushed = large.priceOf('AAPL') - start;
    for (let i = 0; i < 5 * MINUTE; i++) large.step();
    expect(Math.abs(large.priceOf('AAPL') - start)).toBeLessThan(0.2 * pushed);
  });

  it('reopens away from the close: every stock gaps, wild names by more, and the open is unsettled', () => {
    const gaps: Record<string, number[]> = { KO: [], GME: [], SPY: [], QQQ: [] };
    for (let seed = 1; seed <= 400; seed++) {
      const model = new MarketModel(LISTINGS, seededRandom(seed));
      const before = Object.fromEntries(Object.keys(gaps).map((s) => [s, model.priceOf(s)]));
      model.reopen();
      for (const s of Object.keys(gaps)) gaps[s]!.push(Math.log(model.priceOf(s) / before[s]!));
      expect(model.varianceOf('AAPL')).toBeGreaterThan(2);
    }
    // An ordinary night moves a large company around a percent and the market about half of that.
    expect(std(gaps.SPY!)).toBeGreaterThan(0.002);
    expect(std(gaps.SPY!)).toBeLessThan(0.01);
    expect(std(gaps.GME!)).toBeGreaterThan(std(gaps.KO!) * 1.5);
    expect(std(gaps.GME!)).toBeLessThan(0.05);
    // Gaps have no direction of their own, and the two index funds gap together.
    expect(Math.abs(mean(gaps.SPY!))).toBeLessThan(0.002);
    expect(correlation(gaps.SPY!, gaps.QQQ!)).toBeGreaterThan(0.6);
  });

  it('gaps further after a long break than after one night', () => {
    const gap = (scale: number) => {
      const moves: number[] = [];
      for (let seed = 1; seed <= 300; seed++) {
        const model = new MarketModel(LISTINGS, seededRandom(seed));
        const before = model.priceOf('AAPL');
        model.reopen(scale);
        moves.push(Math.log(model.priceOf('AAPL') / before));
      }
      return std(moves);
    };
    expect(gap(1.6)).toBeGreaterThan(gap(1) * 1.3);
  });
});

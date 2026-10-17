import { SECTOR_NAMES, type Listing, type Sector } from './universe.js';

/**
 * The market model: the part of Gomer Trading that decides what prices do.
 * Pure and deterministic given its random source, with no clocks, timers or
 * I/O, so it can be tested and its state saved and restored exactly.
 *
 * Each call to step() advances every listing by one tick:
 *
 *   mood       the market as a whole drifts and swings according to its mood
 *              (calm, steady, rally, sell-off, turbulent), which changes over time
 *   sectors    each sector has its own slowly rotating trend on top of that
 *   company    each stock adds moves of its own, whose size clusters: quiet
 *              spells and stormy spells both tend to persist
 *   gaps       occasionally a stock is abruptly re-priced
 *   trading    orders push the price, and the push fades as others respond
 *
 * A stock's price is its fair value times a temporary dislocation. Fair value
 * carries the lasting part of every move; the dislocation carries noise and
 * the pressure of recent orders, and decays back towards zero.
 */

export type Mood = 'CALM' | 'STEADY' | 'RALLY' | 'SELLOFF' | 'TURBULENT';

interface MoodProfile {
  label: string;
  description: string;
  /** Multiplier on every source of volatility. */
  volatility: number;
  /** Market drift per tick. */
  drift: number;
  /** Average length in ticks. */
  duration: number;
  /** Relative odds of each mood coming next. */
  next: Partial<Record<Mood, number>>;
}

/** One tick is half a second, so 120 ticks is a minute. */
const MINUTE = 120;

export const MOODS: Record<Mood, MoodProfile> = {
  CALM: {
    label: 'Calm',
    description: 'Trading has gone quiet. Ranges are narrow across the board.',
    volatility: 0.55,
    drift: 0,
    duration: 14 * MINUTE,
    next: { STEADY: 6, RALLY: 2, SELLOFF: 1 },
  },
  STEADY: {
    label: 'Steady',
    description: 'Two-way trade with ordinary volatility.',
    volatility: 1,
    drift: 0,
    duration: 18 * MINUTE,
    next: { CALM: 3, RALLY: 3, SELLOFF: 2, TURBULENT: 1 },
  },
  RALLY: {
    label: 'Rally',
    description: 'Buyers are in control, with strength across most sectors.',
    volatility: 0.9,
    drift: 0.0000045,
    duration: 10 * MINUTE,
    next: { STEADY: 5, CALM: 2, TURBULENT: 1, SELLOFF: 1 },
  },
  SELLOFF: {
    label: 'Sell-off',
    description: 'Broad selling pressure. Volatility is elevated.',
    volatility: 1.7,
    drift: -0.0000065,
    duration: 7 * MINUTE,
    next: { TURBULENT: 3, STEADY: 3, RALLY: 2 },
  },
  TURBULENT: {
    label: 'Turbulent',
    description: 'Sharp swings in both directions. Size positions with care.',
    volatility: 2.2,
    drift: 0,
    duration: 6 * MINUTE,
    next: { STEADY: 4, SELLOFF: 2, RALLY: 2, CALM: 1 },
  },
};

// --- Calibration (all per tick) ----------------------------------------------
const MARKET_SIGMA = 0.00006;
const SECTOR_SIGMA = 0.00005;
/** Sector trends are slow: they persist for many minutes, then rotate. */
const SECTOR_TREND_PERSISTENCE = 0.9992;
const SECTOR_TREND_SIGMA = 0.00000035;
/** A typical company's own volatility; scaled by the listing's `vol`. */
const COMPANY_SIGMA = 0.00015;
/** Share of a company's own moves that are lasting (the rest is noise that fades). */
const LASTING_SHARE = 0.5;
/** Volatility clustering: variance ratio v' = OMEGA + PERSIST*v + REACT*v*z^2, mean 1. */
const VARIANCE_OMEGA = 0.02;
const VARIANCE_PERSIST = 0.9;
const VARIANCE_REACT = 0.08;
const VARIANCE_RANGE: [number, number] = [0.3, 8];
/** Dislocations lose about half their size in a minute and a half. */
const DISLOCATION_DECAY = 0.004;
/** About one gap per stock every three hours. */
const GAP_PROBABILITY = 1 / (180 * MINUTE);
/** Fair value is pulled towards the reference price so weeks of running cannot drift it to nonsense. */
const ANCHOR_PULL = 0.000002;
/** Price move from an order the size of IMPACT_REFERENCE shares; grows with the square root of size. */
const IMPACT = 0.0004;
const IMPACT_REFERENCE = 5000;
const MIN_PRICE = 0.5;
/** How far prices move between one session's close and the next open: the market, each sector, a typical company. */
const OVERNIGHT_MARKET_SIGMA = 0.004;
const OVERNIGHT_SECTOR_SIGMA = 0.003;
const OVERNIGHT_COMPANY_SIGMA = 0.007;
/** The first minutes after the open are unsettled: variance starts at least this far above normal. */
const OPENING_VARIANCE = 2.4;
/** A volatility surge is reported when the variance ratio crosses this, then re-arms below half of it. */
const SURGE_LEVEL = 3.2;

export interface SymbolState {
  /** Lasting value of the stock. */
  fair: number;
  /** Temporary log dislocation of the price from fair value. */
  dislocation: number;
  /** Current variance relative to normal (1 = normal). */
  variance: number;
  /** Last standardised shock, which drives the next variance. */
  shock: number;
  surging: boolean;
}

export interface ModelState {
  mood: Mood;
  /** Ticks spent in the current mood. */
  moodAge: number;
  sectorTrend: Record<Sector, number>;
  symbols: Record<string, SymbolState>;
}

export type ModelEvent =
  | { kind: 'mood'; mood: Mood; previous: Mood }
  | { kind: 'gap'; symbol: string; change: number }
  | { kind: 'surge'; symbol: string; variance: number };

export interface TickResult {
  events: ModelEvent[];
  /** Per-symbol activity this tick, for volume: roughly 1 in ordinary conditions. */
  activity: Map<string, number>;
  /** Return of each sector factor this tick. */
  sectorReturns: Record<Sector, number>;
}

const SECTORS = Object.keys(SECTOR_NAMES) as Sector[];
const clamp = (value: number, [low, high]: [number, number]) => Math.min(high, Math.max(low, value));

export class MarketModel {
  private readonly listings = new Map<string, Listing>();
  private state: ModelState;

  /**
   * @param random uniform source in [0, 1); inject a seeded one for reproducible runs
   * @param saved  state from a previous run to continue from
   */
  constructor(
    listings: Listing[],
    private readonly random: () => number = Math.random,
    saved?: ModelState | null,
  ) {
    for (const listing of listings) this.listings.set(listing.symbol, listing);
    this.state = {
      mood: saved?.mood && MOODS[saved.mood] ? saved.mood : 'STEADY',
      moodAge: saved?.moodAge ?? 0,
      sectorTrend: Object.fromEntries(SECTORS.map((s) => [s, saved?.sectorTrend?.[s] ?? 0])) as Record<Sector, number>,
      symbols: {},
    };
    for (const listing of listings) {
      const previous = saved?.symbols?.[listing.symbol];
      this.state.symbols[listing.symbol] =
        previous && previous.fair > 0
          ? { ...previous }
          : // A new listing opens within a couple of percent of its reference price.
            { fair: listing.price * Math.exp(0.012 * this.gaussian()), dislocation: 0, variance: 1, shock: 0, surging: false };
    }
  }

  get mood(): Mood {
    return this.state.mood;
  }

  get symbols(): string[] {
    return [...this.listings.keys()];
  }

  priceOf(symbol: string): number {
    const s = this.state.symbols[symbol];
    return s ? Math.max(MIN_PRICE, s.fair * Math.exp(s.dislocation)) : 0;
  }

  /** How stormy a stock is right now relative to normal (1 = normal). */
  varianceOf(symbol: string): number {
    return this.state.symbols[symbol]?.variance ?? 1;
  }

  /** A deep copy that can be stored as JSON and passed back to the constructor. */
  snapshot(): ModelState {
    return JSON.parse(JSON.stringify(this.state)) as ModelState;
  }

  /**
   * Registers an executed order. Buying pushes the price up and selling pushes
   * it down, by an amount that grows with the square root of the size and then
   * fades as the dislocation decays.
   */
  applyFlow(symbol: string, signedQuantity: number): void {
    const s = this.state.symbols[symbol];
    if (!s || signedQuantity === 0) return;
    s.dislocation += Math.sign(signedQuantity) * IMPACT * Math.sqrt(Math.abs(signedQuantity) / IMPACT_REFERENCE);
  }

  /**
   * Re-prices every stock for the news that arrived while the market was shut.
   * The whole market moves a little, each sector has its own surprise and so
   * does each company, which is what makes a stock open away from where it
   * closed. Yesterday's order flow is forgotten, and the first minutes of the
   * new session are busier than usual.
   *
   * @param scale 1 for an ordinary night; a little more after a weekend or a holiday
   */
  reopen(scale = 1): void {
    const { state } = this;
    const market = OVERNIGHT_MARKET_SIGMA * scale * this.gaussian();
    const sectors = {} as Record<Sector, number>;
    for (const sector of SECTORS) sectors[sector] = OVERNIGHT_SECTOR_SIGMA * scale * this.gaussian();

    for (const [symbol, listing] of this.listings) {
      const s = state.symbols[symbol]!;
      let change = listing.beta * market + OVERNIGHT_COMPANY_SIGMA * listing.vol * scale * this.gaussian();
      for (const sector of SECTORS) change += (listing.sectorWeights[sector] ?? 0) * sectors[sector];
      s.fair = Math.max(MIN_PRICE, s.fair * Math.exp(change));
      s.dislocation = 0;
      s.shock = 0;
      s.variance = clamp(Math.max(s.variance, OPENING_VARIANCE), VARIANCE_RANGE);
      s.surging = false;
    }
  }

  /** Advances the whole market by one tick. */
  step(): TickResult {
    const events: ModelEvent[] = [];
    const activity = new Map<string, number>();
    const { state } = this;

    // Mood: each tick has a small chance of ending the current one.
    state.moodAge++;
    if (this.random() < 1 / MOODS[state.mood].duration) {
      const previous = state.mood;
      state.mood = this.pick(MOODS[previous].next);
      state.moodAge = 0;
      events.push({ kind: 'mood', mood: state.mood, previous });
    }
    const mood = MOODS[state.mood];

    const market = mood.drift + MARKET_SIGMA * mood.volatility * this.gaussian();
    const sectorReturns = {} as Record<Sector, number>;
    for (const sector of SECTORS) {
      state.sectorTrend[sector] = SECTOR_TREND_PERSISTENCE * state.sectorTrend[sector] + SECTOR_TREND_SIGMA * this.gaussian();
      sectorReturns[sector] = state.sectorTrend[sector] + SECTOR_SIGMA * mood.volatility * this.gaussian();
    }

    for (const [symbol, listing] of this.listings) {
      const s = state.symbols[symbol]!;

      s.variance = clamp(VARIANCE_OMEGA + VARIANCE_PERSIST * s.variance + VARIANCE_REACT * s.variance * s.shock * s.shock, VARIANCE_RANGE);
      const sigma = COMPANY_SIGMA * listing.vol * mood.volatility * Math.sqrt(s.variance);
      s.shock = this.gaussian();

      let factors = listing.beta * market;
      for (const sector of SECTORS) factors += (listing.sectorWeights[sector] ?? 0) * sectorReturns[sector];

      let lasting = factors + sigma * LASTING_SHARE * s.shock;
      if (!listing.fund && this.random() < GAP_PROBABILITY) {
        const change = (this.random() < 0.5 ? -1 : 1) * (0.008 + 0.014 * this.random()) * Math.sqrt(listing.vol);
        lasting += change;
        s.variance = clamp(s.variance * 2.5, VARIANCE_RANGE); // gaps are followed by unsettled trading
        events.push({ kind: 'gap', symbol, change });
      }

      const before = s.fair * Math.exp(s.dislocation);
      s.fair *= Math.exp(lasting + ANCHOR_PULL * Math.log(listing.price / s.fair));
      s.dislocation = (1 - DISLOCATION_DECAY) * s.dislocation + sigma * (1 - LASTING_SHARE) * this.gaussian();
      const after = s.fair * Math.exp(s.dislocation);

      if (!s.surging && s.variance > SURGE_LEVEL) {
        s.surging = true;
        events.push({ kind: 'surge', symbol, variance: s.variance });
      } else if (s.surging && s.variance < SURGE_LEVEL / 2) {
        s.surging = false;
      }

      // Bigger moves and stormier conditions both mean more shares changing hands.
      const move = Math.abs(Math.log(after / before)) / (COMPANY_SIGMA * Math.max(listing.vol, 0.3));
      activity.set(symbol, mood.volatility * Math.sqrt(s.variance) * (0.6 + 0.4 * move));
    }

    return { events, activity, sectorReturns };
  }

  /** Standard normal via Box-Muller on the injected source. */
  private gaussian(): number {
    let u = 0;
    while (u === 0) u = this.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.random());
  }

  private pick(odds: Partial<Record<Mood, number>>): Mood {
    const entries = Object.entries(odds) as Array<[Mood, number]>;
    let roll = this.random() * entries.reduce((sum, [, weight]) => sum + weight, 0);
    for (const [mood, weight] of entries) {
      roll -= weight;
      if (roll <= 0) return mood;
    }
    return entries[0]![0];
  }
}

/** Small, fast seedable generator (mulberry32) for reproducible simulations. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

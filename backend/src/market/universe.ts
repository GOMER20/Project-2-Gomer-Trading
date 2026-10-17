/**
 * The companies and funds listed on Gomer Trading's own market.
 *
 * The tickers are familiar, but everything about how they trade here (the
 * reference price, how volatile they are, how they move with the market and
 * their sector) belongs to this market. Nothing is read from a real exchange.
 */

export type Sector = 'TECH' | 'SEMIS' | 'CONSUMER' | 'FINANCE' | 'ENERGY' | 'INDUSTRIAL' | 'MEDIA' | 'FINTECH';

export const SECTOR_NAMES: Record<Sector, string> = {
  TECH: 'Technology',
  SEMIS: 'Semiconductors',
  CONSUMER: 'Consumer',
  FINANCE: 'Financials',
  ENERGY: 'Energy',
  INDUSTRIAL: 'Industrials',
  MEDIA: 'Media',
  FINTECH: 'Fintech',
};

export interface Listing {
  symbol: string;
  name: string;
  /** Reference price: where the stock starts, and a very weak long-run anchor. */
  price: number;
  /** Volatility of the stock's own moves, relative to a typical large company. */
  vol: number;
  /** Sensitivity to the market as a whole. */
  beta: number;
  /** A company belongs to one sector; a fund tracks a blend of the market and sectors. */
  sector?: Sector;
  /** Sensitivity to its sector (companies) or exposure to several sectors (funds). */
  sectorWeights: Partial<Record<Sector, number>>;
  /** Funds track the factors closely and have almost no moves of their own. */
  fund: boolean;
}

const company = (symbol: string, name: string, sector: Sector, price: number, vol: number, beta: number): Listing => ({
  symbol,
  name,
  price,
  vol,
  beta,
  sector,
  sectorWeights: { [sector]: 1 },
  fund: false,
});

const fund = (symbol: string, name: string, price: number, beta: number, sectorWeights: Partial<Record<Sector, number>>): Listing => ({
  symbol,
  name,
  price,
  vol: 0.12,
  beta,
  sectorWeights,
  fund: true,
});

export const LISTINGS: Listing[] = [
  company('AAPL', 'Apple Inc.', 'TECH', 228.5, 1.0, 1.05),
  company('MSFT', 'Microsoft Corporation', 'TECH', 431.2, 0.9, 1.0),
  company('GOOGL', 'Alphabet Inc. Class A', 'TECH', 165.3, 1.0, 1.05),
  company('META', 'Meta Platforms, Inc.', 'TECH', 582.7, 1.2, 1.2),
  company('CRM', 'Salesforce, Inc.', 'TECH', 284.3, 1.0, 1.1),
  company('ORCL', 'Oracle Corporation', 'TECH', 171.5, 1.0, 1.0),
  company('PLTR', 'Palantir Technologies Inc.', 'TECH', 41.3, 2.2, 1.6),
  company('NVDA', 'NVIDIA Corporation', 'SEMIS', 134.8, 1.7, 1.6),
  company('AMD', 'Advanced Micro Devices, Inc.', 'SEMIS', 164.1, 1.8, 1.6),
  company('INTC', 'Intel Corporation', 'SEMIS', 22.7, 1.6, 1.2),
  company('AVGO', 'Broadcom Inc.', 'SEMIS', 176.4, 1.4, 1.3),
  company('MU', 'Micron Technology, Inc.', 'SEMIS', 102.7, 1.6, 1.4),
  company('AMZN', 'Amazon.com, Inc.', 'CONSUMER', 187.9, 1.1, 1.15),
  company('TSLA', 'Tesla, Inc.', 'CONSUMER', 251.4, 2.0, 1.7),
  company('WMT', 'Walmart Inc.', 'CONSUMER', 80.4, 0.6, 0.55),
  company('KO', 'The Coca-Cola Company', 'CONSUMER', 70.2, 0.5, 0.5),
  company('SHOP', 'Shopify Inc.', 'CONSUMER', 81.2, 1.6, 1.5),
  company('UBER', 'Uber Technologies, Inc.', 'CONSUMER', 74.8, 1.4, 1.3),
  company('GME', 'GameStop Corp.', 'CONSUMER', 21.9, 2.8, 1.4),
  company('JPM', 'JPMorgan Chase & Co.', 'FINANCE', 211.6, 0.8, 1.0),
  company('BAC', 'Bank of America Corporation', 'FINANCE', 39.8, 0.9, 1.1),
  company('GS', 'The Goldman Sachs Group, Inc.', 'FINANCE', 495.3, 0.9, 1.15),
  company('V', 'Visa Inc.', 'FINANCE', 276.9, 0.7, 0.9),
  company('XOM', 'Exxon Mobil Corporation', 'ENERGY', 121.5, 0.8, 0.75),
  company('BA', 'The Boeing Company', 'INDUSTRIAL', 154.9, 1.3, 1.2),
  company('F', 'Ford Motor Company', 'INDUSTRIAL', 10.7, 1.1, 1.1),
  company('NFLX', 'Netflix, Inc.', 'MEDIA', 712.4, 1.3, 1.15),
  company('DIS', 'The Walt Disney Company', 'MEDIA', 93.6, 0.9, 1.0),
  company('COIN', 'Coinbase Global, Inc.', 'FINTECH', 178.6, 2.5, 1.9),
  company('SOFI', 'SoFi Technologies, Inc.', 'FINTECH', 8.9, 2.2, 1.6),
  fund('SPY', 'SPDR S&P 500 ETF Trust', 573.8, 1.0, { TECH: 0.3, SEMIS: 0.1, CONSUMER: 0.15, FINANCE: 0.15 }),
  fund('QQQ', 'Invesco QQQ Trust', 487.1, 1.15, { TECH: 0.5, SEMIS: 0.25, CONSUMER: 0.1 }),
  fund('IWM', 'iShares Russell 2000 ETF', 220.4, 1.25, { FINANCE: 0.2, INDUSTRIAL: 0.2, CONSUMER: 0.1 }),
  fund('DIA', 'SPDR Dow Jones Industrial Average ETF', 423.6, 0.9, { FINANCE: 0.25, INDUSTRIAL: 0.2, ENERGY: 0.1 }),
];

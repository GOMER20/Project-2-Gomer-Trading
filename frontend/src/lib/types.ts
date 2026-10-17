// Shapes returned by the backend API. Keep in sync with backend/src/types.ts
// and the service DTOs.

export type UserRole = 'ADMIN' | 'TRADER';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
export type OrderSide = 'BUY' | 'SELL';
export type OrderStatus = 'OPEN' | 'FILLED' | 'CANCELLED' | 'REJECTED';
export type CompetitionStatus = 'UPCOMING' | 'ACTIVE' | 'ENDED';
export type Timeframe = '1Min' | '5Min' | '15Min' | '1Hour';

export interface User {
  id: string;
  traderId: string;
  role: UserRole;
  displayName: string;
  /** May see the AT and HFT windows (administrators, and the desktop app's own trader). */
  owner?: boolean;
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  last: number;
  /** Shares in the most recent trade, when known. */
  lastSize?: number;
  prevClose: number | null;
  ts: number;
}

/** Health of the server's upstream price feed. */
export interface FeedHealth {
  /** 'closed' is the practice market between sessions: healthy, but nothing trades until it opens. */
  state: 'connecting' | 'streaming' | 'closed' | 'error';
  /** What is wrong, in plain words, when state is 'error'. */
  detail?: string;
}

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Competition {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  startingBalance: number;
  allowShorting: boolean;
  leverage: number;
  /** Dollars charged per share on every execution. */
  commissionPerShare: number;
  /** Margin call level as a fraction; zero means margin calls are off. */
  maintenanceMargin: number;
  /** standard: fills from the modelled book. hft: the realistic sandbox, where HFT decides them. */
  fillModel: 'standard' | 'hft';
  /** With fill model hft: milliseconds an order or cancel takes to reach the book. */
  orderDelayMs: number;
  status: CompetitionStatus;
  /** True once an ended competition has been settled: positions closed, standings final. */
  final: boolean;
  participants: number;
  enrolled: boolean;
  /** Invite code people can join with. Administrators only; null when sign-up is closed. */
  joinCode?: string | null;
}

/** What an invite code leads to, shown before signing up. */
export interface InvitePreview {
  name: string;
  startDate: string;
  endDate: string;
  startingBalance: number;
  status: CompetitionStatus;
  participants: number;
}

export interface MarketSession {
  /** New York calendar date, YYYY-MM-DD. */
  date: string;
  opensAt: string;
  closesAt: string;
  earlyClose: boolean;
}

/** US stock market hours as absolute times; show them in the viewer's own time zone. */
export interface MarketHours {
  open: boolean;
  /** The session in progress, or the next one. */
  session: MarketSession;
  holiday: string | null;
  upcoming: MarketSession[];
  /** True when this server's prices move at any hour (the practice market set to run around the clock). */
  alwaysOpen?: boolean;
}

export interface Position {
  ticker: string;
  quantity: number;
  side: 'LONG' | 'SHORT';
  averagePrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
}

export interface Portfolio {
  id: string;
  competitionId: string;
  startingBalance: number;
  leverage: number;
  allowShorting: boolean;
  cash: number;
  buyingPower: number;
  totalEquity: number;
  realizedPnl: number;
  /** Commission paid so far. Already out of cash, so equity and total P&L are net of it. */
  commissions: number;
  commissionPerShare: number;
  grossExposure: number;
  /** Equity as a share of gross exposure; null with no positions. Below maintenanceMargin the account is liquidated. */
  marginLevel: number | null;
  maintenanceMargin: number;
  unrealizedPnl: number;
  totalPnl: number;
  returnPct: number;
  positions: Position[];
  asOf: string;
}

export interface Order {
  id: string;
  portfolioId: string;
  ticker: string;
  type: OrderType;
  side: OrderSide;
  status: OrderStatus;
  quantity: number;
  limitPrice: number | null;
  stopPrice: number | null;
  /** When a stop order's stop price was reached, if it has been. */
  triggeredAt: string | null;
  /** Bracket exits requested with this entry order. */
  takeProfit: number | null;
  stopLoss: number | null;
  /** For a bracket exit, the entry order it protects. Exits only ever reduce the position. */
  parentId: string | null;
  /** Shares done so far. An order can fill in pieces; fillPrice is the average of the pieces. */
  filledQuantity: number;
  commission: number;
  /** Why the platform placed this order itself, e.g. 'MARGIN_CALL'. Null for the trader's own orders. */
  forcedBy: string | null;
  /** GTC rests until done or cancelled; IOC and FOK (sent by trading programs) never rest. */
  timeInForce: 'GTC' | 'IOC' | 'FOK';
  clientOrderId: string | null;
  /** The price on the order's side of the market when it arrived. */
  arrivalPrice: number | null;
  fillPrice: number | null;
  realizedPnl: number | null;
  rejectReason: string | null;
  createdAt: string;
  filledAt: string | null;
}

export interface LeaderboardEntry {
  rank: number;
  traderId: string;
  displayName: string;
  equity: number;
  /** What this trader started with (an account can be given more money than the rest). */
  startingBalance?: number;
  pnl: number;
  returnPct: number;
}

export interface Leaderboard {
  competitionId: string;
  startingBalance: number;
  participants: number;
  updatedAt: string | null;
  entries: LeaderboardEntry[];
  me: LeaderboardEntry | null;
}

export interface NewOrder {
  competitionId: string;
  ticker: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
  /** Bracket: exits placed automatically when the order fills. */
  takeProfit?: number;
  stopLoss?: number;
}

/** One trader's standing and record in a competition. */
export interface Standing {
  rank: number;
  traderId: string;
  displayName: string;
  equity: number;
  startingBalance?: number;
  pnl: number;
  returnPct: number;
  realizedPnl: number;
  commissions: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  profitFactor: number | null;
  bestTrade: number | null;
  worstTrade: number | null;
}

export interface CompetitionResults {
  competition: { id: string; name: string; status: CompetitionStatus; startDate: string; endDate: string; startingBalance: number; final: boolean };
  standings: Standing[];
  /** Ranked first once the result is final. More than one means a tie. */
  winners: Standing[];
}

/** One piece of an order that traded. A large order trades in several. */
export interface Execution {
  id: string;
  orderId: string;
  ticker: string;
  side: OrderSide;
  quantity: number;
  price: number;
  commission: number;
  realizedPnl: number;
  executedAt: string;
}

/** A price level in the Level 2 book: [price, shares]. */
export type DepthLevel = [price: number, size: number];

/** The Level 2 book for one symbol, best prices first. Levels behind the best bid and offer are modelled. */
export interface Depth {
  symbol: string;
  bids: DepthLevel[];
  asks: DepthLevel[];
}

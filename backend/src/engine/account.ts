import type { Decimal } from 'decimal.js';
import { orderRejected } from '../lib/errors.js';
import type { PortfolioRow } from '../types.js';
import type { PositionState } from './accounting.js';
import type { WorkingOrder } from './risk.js';

export interface AccountRules {
  startDate: Date;
  endDate: Date;
  allowShorting: boolean;
  leverage: Decimal;
  /** Charged on every share of every execution. */
  commissionPerShare: Decimal;
  /** Equity below this share of gross exposure means a margin call. Zero switches them off. */
  maintenanceMargin: Decimal;
  /** standard: this server's engine fills orders against the modelled book. hft: HFT decides the fills (the realistic sandbox; hft/hftVenue.ts). */
  fillModel: 'standard' | 'hft';
  /** With fill model hft: how long an order or cancel takes to reach the book, in milliseconds (a little more at random). */
  orderDelayMs: number;
}

/**
 * An account as the risk rules and the portfolio screens read it: a snapshot
 * taken from the engine's ledger (ledger.ts), which is where accounts live.
 */
export interface Account {
  portfolio: PortfolioRow;
  rules: AccountRules;
  positions: Map<string, PositionState>;
  /** The account's own resting orders, which reserve buying power and shares. Bracket exits are left out. */
  workingOrders: Array<WorkingOrder & { id: string }>;
}

export function assertCompetitionOpen(rules: AccountRules, now = new Date()): void {
  if (now < rules.startDate) throw orderRejected('This competition has not started yet.');
  if (now > rules.endDate) throw orderRejected('This competition has ended.');
}

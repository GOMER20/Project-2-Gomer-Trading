import { pool } from '../db/pool.js';
import { engine } from '../engine/matchingEngine.js';
import { notFound } from '../lib/errors.js';
import { competitionStatus, type CompetitionRow, type CompetitionStatus } from '../types.js';

export interface Standing {
  /** Competition ranking by return: an equal return shares a rank, and the next rank is skipped. */
  rank: number;
  traderId: string;
  displayName: string;
  equity: number;
  /** What this trader started with: the competition's amount, plus anything given to this account alone. */
  startingBalance: number;
  pnl: number;
  returnPct: number;
  realizedPnl: number;
  /** Commission paid. Already reflected in equity. */
  commissions: number;
  /** Executed orders. */
  trades: number;
  /** Trades that closed part of a position, and how they came out. */
  wins: number;
  losses: number;
  /** Share of closing trades that made money, or null with none yet. */
  winRate: number | null;
  /** Gross profit divided by gross loss, or null when there are no losing trades. */
  profitFactor: number | null;
  bestTrade: number | null;
  worstTrade: number | null;
}

export interface CompetitionResults {
  competition: {
    id: string;
    name: string;
    status: CompetitionStatus;
    startDate: string;
    endDate: string;
    startingBalance: number;
    /** True once the competition has ended and every position has been closed at the final price. */
    final: boolean;
  };
  standings: Standing[];
  /** The trader(s) ranked first, once the result is final. More than one means a tie. */
  winners: Standing[];
}

interface Row {
  trader_id: string;
  display_name: string;
  total_equity: string;
  realized_pnl: string;
  commissions: string;
  funding: string;
  trades: number;
  wins: number;
  losses: number;
  gross_profit: string;
  gross_loss: string;
  best: string | null;
  worst: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Full standings with each trader's record. While the competition runs, equity
 * is the value from the leaderboard worker's latest pass (at most ten seconds
 * old); once it is final, it is the settled result.
 */
export async function getResults(competitionId: string): Promise<CompetitionResults> {
  const found = await pool.query<CompetitionRow>('SELECT * FROM competitions WHERE id = $1', [competitionId]);
  const competition = found.rows[0];
  if (!competition) throw notFound('Competition not found');

  await engine.drained();
  const { rows } = await pool.query<Row>(
    `SELECT u.trader_id, u.display_name, p.total_equity, p.realized_pnl, p.commissions, p.funding,
            COALESCE(s.trades, 0)::int AS trades,
            COALESCE(s.wins, 0)::int AS wins,
            COALESCE(s.losses, 0)::int AS losses,
            COALESCE(s.gross_profit, 0) AS gross_profit,
            COALESCE(s.gross_loss, 0) AS gross_loss,
            s.best, s.worst
       FROM portfolios p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN (
            SELECT portfolio_id,
                   count(*) AS trades,
                   count(*) FILTER (WHERE realized_pnl > 0) AS wins,
                   count(*) FILTER (WHERE realized_pnl < 0) AS losses,
                   sum(realized_pnl) FILTER (WHERE realized_pnl > 0) AS gross_profit,
                   -sum(realized_pnl) FILTER (WHERE realized_pnl < 0) AS gross_loss,
                   max(realized_pnl) FILTER (WHERE realized_pnl <> 0) AS best,
                   min(realized_pnl) FILTER (WHERE realized_pnl <> 0) AS worst
              FROM orders
             WHERE filled_quantity > 0
             GROUP BY portfolio_id
       ) s ON s.portfolio_id = p.id
      WHERE p.competition_id = $1
      -- By return on each account's own starting money: the same order as equity when everyone started equal.
      ORDER BY (p.total_equity - ($2::numeric + p.funding)) / NULLIF($2::numeric + p.funding, 0) DESC, u.trader_id`,
    [competitionId, competition.starting_balance],
  );

  const startingBalance = Number(competition.starting_balance);
  const standings: Standing[] = [];
  rows.forEach((row, index) => {
    const equity = round2(Number(row.total_equity));
    const start = startingBalance + Number(row.funding);
    const returnPct = round2(((equity - start) / start) * 100);
    const previous = standings[index - 1];
    const closed = row.wins + row.losses;
    const grossLoss = Number(row.gross_loss);
    standings.push({
      rank: previous && previous.returnPct === returnPct ? previous.rank : index + 1,
      traderId: row.trader_id,
      displayName: row.display_name,
      equity,
      startingBalance: start,
      pnl: round2(equity - start),
      returnPct,
      realizedPnl: round2(Number(row.realized_pnl)),
      commissions: round2(Number(row.commissions)),
      trades: row.trades,
      wins: row.wins,
      losses: row.losses,
      winRate: closed ? round2((row.wins / closed) * 100) : null,
      profitFactor: grossLoss > 0 ? round2(Number(row.gross_profit) / grossLoss) : null,
      bestTrade: row.best === null ? null : round2(Number(row.best)),
      worstTrade: row.worst === null ? null : round2(Number(row.worst)),
    });
  });

  const final = competition.settled_at !== null;
  return {
    competition: {
      id: competition.id,
      name: competition.name,
      status: competitionStatus(competition),
      startDate: competition.start_date.toISOString(),
      endDate: competition.end_date.toISOString(),
      startingBalance,
      final,
    },
    standings,
    winners: final ? standings.filter((s) => s.rank === 1) : [],
  };
}

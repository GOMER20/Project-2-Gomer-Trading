-- Partial fills, commissions and margin calls.

-- An order can now fill in pieces. filled_quantity counts the shares done so
-- far, fill_price is the average price of those shares, and filled_at is when
-- the latest piece traded. An order is FILLED only once every share is done; a
-- part-filled order stays OPEN (or ends CANCELLED) with filled_quantity > 0.
ALTER TABLE orders
    ADD COLUMN filled_quantity INTEGER        NOT NULL DEFAULT 0,
    ADD COLUMN commission      NUMERIC(18, 4) NOT NULL DEFAULT 0,
    -- Set when the platform itself placed the order, e.g. 'MARGIN_CALL'.
    ADD COLUMN forced_by       TEXT;

UPDATE orders SET filled_quantity = quantity WHERE status = 'FILLED';

ALTER TABLE orders DROP CONSTRAINT orders_fill_matches_status;
ALTER TABLE orders ADD CONSTRAINT orders_fill_progress_valid CHECK (
    filled_quantity >= 0 AND filled_quantity <= quantity AND
    (status = 'FILLED') = (filled_quantity = quantity) AND
    (filled_quantity > 0) = (fill_price IS NOT NULL) AND
    (filled_quantity > 0) = (filled_at IS NOT NULL)
);

-- Every piece of every order: one row each time shares actually trade.
CREATE TABLE executions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id     UUID           NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    portfolio_id UUID           NOT NULL REFERENCES portfolios (id) ON DELETE CASCADE,
    ticker       TEXT           NOT NULL,
    side         order_side     NOT NULL,
    quantity     INTEGER        NOT NULL,
    price        NUMERIC(18, 4) NOT NULL,
    commission   NUMERIC(18, 4) NOT NULL DEFAULT 0,
    realized_pnl NUMERIC(18, 4) NOT NULL DEFAULT 0,
    executed_at  TIMESTAMPTZ    NOT NULL DEFAULT now(),
    CONSTRAINT executions_quantity_valid CHECK (quantity > 0),
    CONSTRAINT executions_price_valid CHECK (price > 0)
);

CREATE INDEX executions_portfolio_idx ON executions (portfolio_id, executed_at DESC);
CREATE INDEX executions_order_idx ON executions (order_id);

-- Orders filled before this migration traded in one piece.
INSERT INTO executions (order_id, portfolio_id, ticker, side, quantity, price, realized_pnl, executed_at)
SELECT id, portfolio_id, ticker, side, quantity, fill_price, COALESCE(realized_pnl, 0), filled_at
  FROM orders
 WHERE status = 'FILLED';

-- Commission is charged per share on every execution and comes out of cash.
ALTER TABLE competitions
    ADD COLUMN commission_per_share NUMERIC(10, 4) NOT NULL DEFAULT 0,
    -- Margin call level: when equity falls below this share of gross exposure,
    -- the account is liquidated. 0 switches margin calls off.
    ADD COLUMN maintenance_margin   NUMERIC(5, 4)  NOT NULL DEFAULT 0.25;

ALTER TABLE competitions ADD CONSTRAINT competitions_costs_valid CHECK (
    commission_per_share >= 0 AND commission_per_share <= 1 AND
    maintenance_margin >= 0 AND maintenance_margin < 1
);

ALTER TABLE portfolios ADD COLUMN commissions NUMERIC(18, 4) NOT NULL DEFAULT 0;

-- Bracket orders and account management.

-- An entry order may carry exit instructions. When it fills, the engine creates
-- the exits as child orders: a take-profit (LIMIT) and/or a stop-loss (STOP) on
-- the other side. Children of one parent are "one cancels the other", and they
-- only ever reduce the position they protect.
ALTER TABLE orders
    ADD COLUMN take_profit NUMERIC(18, 4),
    ADD COLUMN stop_loss   NUMERIC(18, 4),
    ADD COLUMN parent_id   UUID REFERENCES orders (id) ON DELETE CASCADE;

ALTER TABLE orders ADD CONSTRAINT orders_bracket_prices_valid CHECK (
    (take_profit IS NULL OR take_profit > 0) AND
    (stop_loss   IS NULL OR stop_loss   > 0) AND
    -- an exit does not carry exits of its own
    (parent_id IS NULL OR (take_profit IS NULL AND stop_loss IS NULL))
);

CREATE INDEX orders_working_exits_idx ON orders (portfolio_id, ticker) WHERE parent_id IS NOT NULL AND status = 'OPEN';

-- Raised whenever a user's existing sessions must stop working: a password
-- change, a reset by an administrator, or deactivation. Tokens carry the
-- version they were issued under.
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;

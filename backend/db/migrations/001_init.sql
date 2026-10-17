-- 001_init.sql
-- Core schema for the paper trading competition platform.
-- Money is NUMERIC end to end; nothing here is ever stored as a float.

CREATE TYPE user_role    AS ENUM ('ADMIN', 'TRADER');
CREATE TYPE order_type   AS ENUM ('MARKET', 'LIMIT');
CREATE TYPE order_side   AS ENUM ('BUY', 'SELL');
CREATE TYPE order_status AS ENUM ('OPEN', 'FILLED', 'CANCELLED', 'REJECTED');

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trader_id     TEXT        NOT NULL,
    password_hash TEXT        NOT NULL,
    role          user_role   NOT NULL DEFAULT 'TRADER',
    display_name  TEXT        NOT NULL,
    is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT users_trader_id_format CHECK (trader_id ~ '^[A-Z0-9_-]{3,24}$')
);

CREATE UNIQUE INDEX users_trader_id_key ON users (trader_id);

-- ---------------------------------------------------------------------------
-- Competitions
-- ---------------------------------------------------------------------------
CREATE TABLE competitions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name             TEXT           NOT NULL,
    start_date       TIMESTAMPTZ    NOT NULL,
    end_date         TIMESTAMPTZ    NOT NULL,
    starting_balance NUMERIC(18, 2) NOT NULL DEFAULT 100000.00,
    -- Risk rules applied to every portfolio in the competition.
    allow_shorting   BOOLEAN        NOT NULL DEFAULT TRUE,
    leverage         NUMERIC(5, 2)  NOT NULL DEFAULT 1.00,
    created_by       UUID REFERENCES users (id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ    NOT NULL DEFAULT now(),
    CONSTRAINT competitions_dates_valid    CHECK (end_date > start_date),
    CONSTRAINT competitions_balance_valid  CHECK (starting_balance > 0),
    CONSTRAINT competitions_leverage_valid CHECK (leverage >= 1 AND leverage <= 10)
);

CREATE INDEX competitions_window_idx ON competitions (start_date, end_date);

-- ---------------------------------------------------------------------------
-- Portfolios: one per (user, competition). This is the isolated account.
-- cash and realized_pnl are the source of truth and only ever change inside a
-- fill transaction. buying_power and total_equity are derived from live prices;
-- they are refreshed on every fill and by the leaderboard worker.
-- ---------------------------------------------------------------------------
CREATE TABLE portfolios (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID           NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    competition_id UUID           NOT NULL REFERENCES competitions (id) ON DELETE CASCADE,
    cash           NUMERIC(18, 4) NOT NULL,
    buying_power   NUMERIC(18, 4) NOT NULL,
    total_equity   NUMERIC(18, 4) NOT NULL,
    realized_pnl   NUMERIC(18, 4) NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ    NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ    NOT NULL DEFAULT now(),
    CONSTRAINT portfolios_user_competition_key UNIQUE (user_id, competition_id),
    CONSTRAINT portfolios_buying_power_valid   CHECK (buying_power >= 0)
);

CREATE INDEX portfolios_competition_equity_idx ON portfolios (competition_id, total_equity DESC);

-- ---------------------------------------------------------------------------
-- Positions. quantity is signed: positive = long, negative = short.
-- A flat position has no row.
-- ---------------------------------------------------------------------------
CREATE TABLE positions (
    portfolio_id  UUID           NOT NULL REFERENCES portfolios (id) ON DELETE CASCADE,
    ticker        TEXT           NOT NULL,
    quantity      INTEGER        NOT NULL,
    average_price NUMERIC(18, 4) NOT NULL,
    opened_at     TIMESTAMPTZ    NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
    PRIMARY KEY (portfolio_id, ticker),
    CONSTRAINT positions_quantity_nonzero CHECK (quantity <> 0),
    CONSTRAINT positions_avg_price_valid  CHECK (average_price > 0)
);

CREATE INDEX positions_ticker_idx ON positions (ticker);

-- ---------------------------------------------------------------------------
-- Orders. created_at is the order timestamp; filled_at is the execution time.
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    portfolio_id  UUID           NOT NULL REFERENCES portfolios (id) ON DELETE CASCADE,
    ticker        TEXT           NOT NULL,
    type          order_type     NOT NULL,
    side          order_side     NOT NULL,
    status        order_status   NOT NULL DEFAULT 'OPEN',
    quantity      INTEGER        NOT NULL,
    limit_price   NUMERIC(18, 4),
    fill_price    NUMERIC(18, 4),
    realized_pnl  NUMERIC(18, 4),
    reject_reason TEXT,
    created_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
    filled_at     TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
    CONSTRAINT orders_quantity_valid CHECK (quantity > 0),
    CONSTRAINT orders_limit_price_matches_type CHECK (
        (type = 'LIMIT'  AND limit_price IS NOT NULL AND limit_price > 0) OR
        (type = 'MARKET' AND limit_price IS NULL)
    ),
    CONSTRAINT orders_fill_matches_status CHECK (
        (status = 'FILLED' AND fill_price IS NOT NULL AND filled_at IS NOT NULL) OR
        (status <> 'FILLED' AND fill_price IS NULL AND filled_at IS NULL)
    )
);

CREATE INDEX orders_portfolio_created_idx ON orders (portfolio_id, created_at DESC);
-- The matching engine only ever scans working orders.
CREATE INDEX orders_open_ticker_idx ON orders (ticker) WHERE status = 'OPEN';

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_set_updated_at      BEFORE UPDATE ON users      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER portfolios_set_updated_at BEFORE UPDATE ON portfolios FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER positions_set_updated_at  BEFORE UPDATE ON positions  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER orders_set_updated_at     BEFORE UPDATE ON orders     FOR EACH ROW EXECUTE FUNCTION set_updated_at();

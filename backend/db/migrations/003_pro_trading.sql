-- 003_pro_trading.sql
-- Stop / stop-limit orders, final settlement of competitions, and the
-- built-in market's memory.

-- ---------------------------------------------------------------------------
-- Stop orders
--   STOP        waits for the market to reach stop_price, then executes as a market order
--   STOP_LIMIT  waits for stop_price, then works as a limit order at limit_price
-- ---------------------------------------------------------------------------
ALTER TABLE orders
    ADD COLUMN stop_price   NUMERIC(18, 4),
    ADD COLUMN triggered_at TIMESTAMPTZ;

ALTER TABLE orders DROP CONSTRAINT orders_limit_price_matches_type;
ALTER TABLE orders ADD CONSTRAINT orders_prices_match_type CHECK (
    (type = 'MARKET'     AND limit_price IS NULL     AND stop_price IS NULL) OR
    (type = 'LIMIT'      AND limit_price > 0         AND stop_price IS NULL) OR
    (type = 'STOP'       AND limit_price IS NULL     AND stop_price > 0) OR
    (type = 'STOP_LIMIT' AND limit_price > 0         AND stop_price > 0)
);

-- ---------------------------------------------------------------------------
-- Settlement. When a competition ends, every portfolio is marked to market one
-- last time and the result is frozen; settled_at records that this happened.
-- ---------------------------------------------------------------------------
ALTER TABLE competitions ADD COLUMN settled_at TIMESTAMPTZ;

-- Competitions that ended before this migration keep the equity last recorded for them.
UPDATE competitions SET settled_at = now() WHERE end_date < now();

-- ---------------------------------------------------------------------------
-- The built-in market remembers where it was, so prices and charts continue
-- across restarts instead of starting over.
-- ---------------------------------------------------------------------------
CREATE TABLE market_engine (
    id         BOOLEAN PRIMARY KEY DEFAULT TRUE,
    state      JSONB       NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT market_engine_single_row CHECK (id)
);

CREATE TABLE market_bars (
    symbol TEXT           NOT NULL,
    -- Bar open time, epoch seconds.
    time   BIGINT         NOT NULL,
    open   NUMERIC(18, 4) NOT NULL,
    high   NUMERIC(18, 4) NOT NULL,
    low    NUMERIC(18, 4) NOT NULL,
    close  NUMERIC(18, 4) NOT NULL,
    volume BIGINT         NOT NULL,
    PRIMARY KEY (symbol, time)
);

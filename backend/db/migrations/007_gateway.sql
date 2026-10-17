-- The bot gateway: API keys for trading programs, and what their orders need.

-- A trading program signs in with an API key instead of a password. Each key
-- belongs to one account and is pinned to one competition: that competition's
-- portfolio is the program's sandbox, and moving the key moves the program.
CREATE TABLE api_keys (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    competition_id    UUID        NOT NULL REFERENCES competitions (id) ON DELETE CASCADE,
    label             TEXT        NOT NULL,
    -- The public part of the key, used to find it. The secret part is never stored, only its hash.
    key_prefix        TEXT        NOT NULL,
    key_hash          TEXT        NOT NULL,
    -- Order throttle: new orders accepted per second, with a burst of the same size.
    orders_per_second INTEGER     NOT NULL DEFAULT 50,
    enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at      TIMESTAMPTZ,
    CONSTRAINT api_keys_throttle_valid CHECK (orders_per_second BETWEEN 1 AND 5000)
);

CREATE UNIQUE INDEX api_keys_prefix_key ON api_keys (key_prefix);
CREATE INDEX api_keys_user_idx ON api_keys (user_id);

-- Accounts created for a program rather than a person, so screens can say so.
ALTER TABLE users ADD COLUMN is_bot BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE orders
    -- GTC rests until filled or cancelled. IOC trades what it can at once and cancels
    -- the rest. FOK trades in full at once or not at all.
    ADD COLUMN time_in_force   TEXT NOT NULL DEFAULT 'GTC',
    -- The sender's own reference for the order, unique within a portfolio.
    ADD COLUMN client_order_id TEXT,
    -- The price on the order's side of the market when it arrived (the ask for a
    -- buy, the bid for a sell): what its fills are measured against as slippage.
    ADD COLUMN arrival_price   NUMERIC(18, 4);

ALTER TABLE orders ADD CONSTRAINT orders_time_in_force_valid CHECK (time_in_force IN ('GTC', 'IOC', 'FOK'));
CREATE UNIQUE INDEX orders_client_order_id_key ON orders (portfolio_id, client_order_id) WHERE client_order_id IS NOT NULL;

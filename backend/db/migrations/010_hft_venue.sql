-- The realistic sandbox: competitions whose fills HFT decides (backend/src/hft/hftVenue.ts).
-- standard: the server's own engine fills orders against the modelled Level 2 book, as before.
-- hft: orders go to an HFT of the competition's own, where they wait in line behind the market's
-- own orders and the market's trades are real orders that reach them.
ALTER TABLE competitions
    ADD COLUMN fill_model     TEXT    NOT NULL DEFAULT 'standard' CHECK (fill_model IN ('standard', 'hft')),
    -- With fill model hft: how long an order or a cancel takes to reach the book, in milliseconds.
    ADD COLUMN order_delay_ms INTEGER NOT NULL DEFAULT 0 CHECK (order_delay_ms BETWEEN 0 AND 10000);

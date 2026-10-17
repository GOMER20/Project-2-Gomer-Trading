-- A position's average price was kept to four decimals and re-rounded on every
-- fill. Over thousands of small fills (a trading program buying one share at a
-- time) the rounding added up to cents a share, shifting profit between
-- "realized" and "unrealized". Cash and equity were never affected. Ten
-- decimals makes the drift vanish.
ALTER TABLE positions ALTER COLUMN average_price TYPE NUMERIC(28, 10);

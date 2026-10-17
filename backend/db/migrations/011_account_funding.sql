-- Money added to (or taken from) one account on top of its competition's starting
-- money. The account's own starting money is competitions.starting_balance + funding;
-- its profit, loss and return are measured from that.
ALTER TABLE portfolios ADD COLUMN funding NUMERIC(18, 2) NOT NULL DEFAULT 0;

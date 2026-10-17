-- 004_invites.sql
-- A competition can be opened to self sign-up with an invite code. Anyone who
-- has the code can create their own trader account and is enrolled with a
-- fresh starting balance. NULL means the competition is by admin enrolment only.

ALTER TABLE competitions ADD COLUMN join_code TEXT;

CREATE UNIQUE INDEX competitions_join_code_key ON competitions (join_code) WHERE join_code IS NOT NULL;

-- The matching engine answers orders from memory and writes them here just
-- behind. Before it answers, it appends what it is about to write to a journal
-- file. This row ties that file to this database and records how far the
-- database has caught up, so that after a crash the engine replays exactly
-- the entries the database had not yet received: none twice, none missed.
CREATE TABLE engine_journal (
    id          BOOLEAN PRIMARY KEY DEFAULT TRUE,
    -- Identity of this database. A journal file carrying another identity
    -- belongs to another database (or to this one before a restore) and is ignored.
    journal_id  UUID   NOT NULL DEFAULT gen_random_uuid(),
    -- The sequence number of the last journal entry this database holds.
    applied_seq BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT engine_journal_single_row CHECK (id)
);

INSERT INTO engine_journal DEFAULT VALUES;

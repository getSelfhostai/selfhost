-- Rolls back 0012_background_runs.sql. The runs' ledger events stay.
DROP TABLE background_kills;
DROP TABLE background_runs;

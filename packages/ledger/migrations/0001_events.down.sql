-- Rolls back 0001_events.sql. Drops the ledger events with the table: take a backup first.
DROP TABLE events;
DROP FUNCTION events_append_only();

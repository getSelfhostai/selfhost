-- Rolls back 0004_review_items.sql. The review list can be built again from the ledger, which
-- keeps every decision as an event.
DROP TABLE review_progress;
DROP TABLE review_signals;
DROP TABLE review_items;

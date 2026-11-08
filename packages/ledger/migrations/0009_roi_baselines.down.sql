-- Rolls back 0009_roi_baselines.sql. The frozen baselines are dropped: after upgrading again,
-- each is computed from the ledger on its next read.
DROP TABLE roi_baselines;
DROP FUNCTION roi_baselines_frozen();

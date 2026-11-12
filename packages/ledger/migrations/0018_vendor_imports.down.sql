-- Rolls back 0018_vendor_imports.sql. The imported events stay in the ledger; the importers then
-- read their first window again, and its events are already stored, so nothing counts twice.
DROP TABLE vendor_imports;

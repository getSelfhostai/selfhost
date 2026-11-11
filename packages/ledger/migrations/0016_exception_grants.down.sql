-- Rolls back 0016_exception_grants.sql. Laptops keep the grants they fetched until they expire.
DROP TABLE exception_grants;

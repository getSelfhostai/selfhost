-- Rolls back 0010_context_layers.sql. The org and team context layers and every proposal are
-- dropped: after upgrading again, admins push the layers again with selfhost context push.
DROP TABLE context_proposals;
ALTER TABLE teams DROP COLUMN context_updated_at;
ALTER TABLE teams DROP COLUMN context_files;
ALTER TABLE orgs DROP COLUMN context_updated_at;
ALTER TABLE orgs DROP COLUMN context_files;

-- Rolls back 0015_membership_revocation.sql. Revoked people count as members of their teams again
-- until the server that understands revoked_at runs.
ALTER TABLE people DROP COLUMN revoked_at;

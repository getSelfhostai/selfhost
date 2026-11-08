-- Rolls back 0003_team_access.sql. Invite expiry and email, and the team events were written
-- for, are dropped; the events themselves stay. Dropping a column changes no stored row, so the
-- append-only trigger is not involved.
DROP INDEX events_team_ts_idx;
ALTER TABLE events DROP COLUMN team;

ALTER TABLE tokens DROP CONSTRAINT tokens_email_invite_only;
ALTER TABLE tokens DROP CONSTRAINT tokens_invite_expires;
ALTER TABLE tokens DROP COLUMN email;
ALTER TABLE tokens DROP COLUMN expires_at;

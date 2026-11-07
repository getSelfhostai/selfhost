-- Team mode access: invites expire and may name the one person they are for, and events written
-- with a person token carry that token's team so the team's people can read them.

-- When an invite stops working. Invites always have one; person tokens last until revoked.
ALTER TABLE tokens ADD COLUMN expires_at timestamptz;
-- The person an invite is for. Joining with it binds the person id to this email.
ALTER TABLE tokens ADD COLUMN email text;

-- Invites created before expiry existed get the default lifetime, counted from their creation.
UPDATE tokens SET expires_at = created_at + interval '7 days' WHERE kind = 'invite';

ALTER TABLE tokens ADD CONSTRAINT tokens_invite_expires
  CHECK (kind <> 'invite' OR expires_at IS NOT NULL);
ALTER TABLE tokens ADD CONSTRAINT tokens_email_invite_only
  CHECK (email IS NULL OR kind = 'invite');

-- The team of the person token that wrote the event, set on insert and never from the event body.
-- NULL for events written with the admin token, the OTLP receiver or a local ledger. Adding the
-- column changes no stored row, so the append-only trigger is not involved.
ALTER TABLE events ADD COLUMN team text;

CREATE INDEX events_team_ts_idx ON events (team, ts DESC, id DESC);

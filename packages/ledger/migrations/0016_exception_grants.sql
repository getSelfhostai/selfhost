-- One-time exception grants the team server signed: one row per exception a person approved and
-- the requester's laptop fetched. body is the whole selfhost.exception_grant/v2 grant, signature
-- included, so a second fetch returns the same grant. used_at is set when a laptop reports it
-- used the grant; the server then hands it out no more, so a copy cannot be fetched again.
CREATE TABLE exception_grants (
  id uuid PRIMARY KEY,
  team text NOT NULL,
  requested_by text NOT NULL,
  approved_by text NOT NULL,
  key_id text NOT NULL,
  nonce text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  body jsonb NOT NULL,
  used_at timestamptz,
  -- The random laptop id that reported the use, when it sent one.
  used_by text
);

CREATE INDEX exception_grants_expires_idx ON exception_grants (expires_at);

-- Team mode: teams on a shared server, the people who joined them and the tokens they hold.
-- Unlike events these rows change: policies are replaced and tokens are revoked.
CREATE TABLE teams (
  id text PRIMARY KEY,
  name text NOT NULL,
  -- The team's selfhost.toml, as sent to PUT /v1/policy. NULL until one is set.
  policy_text text,
  policy_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- id is what the person's events carry as actor.id, such as a git email.
CREATE TABLE people (
  team_id text NOT NULL REFERENCES teams (id),
  id text NOT NULL,
  name text,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, id)
);

-- Only the sha256 of a token is stored. Invites belong to a team; person and admin tokens to a
-- person in it.
CREATE TABLE tokens (
  hash text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('admin', 'person', 'invite')),
  team_id text NOT NULL REFERENCES teams (id),
  person_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK ((kind = 'invite') = (person_id IS NULL)),
  FOREIGN KEY (team_id, person_id) REFERENCES people (team_id, id)
);

CREATE INDEX tokens_person_idx ON tokens (team_id, person_id);

-- Context layers: the org's and each team's .selfhost/context files (rules, skills, commands,
-- subagents and MCP servers), which every member's laptop pulls on sync and merges with the
-- repository's own and the person's. Each is a JSON array of {path, text, executable} as sent to
-- PUT /v1/orgs/{org}/context and PUT /v1/context. NULL until set.
ALTER TABLE orgs ADD COLUMN context_files jsonb;
ALTER TABLE orgs ADD COLUMN context_updated_at timestamptz;
ALTER TABLE teams ADD COLUMN context_files jsonb;
ALTER TABLE teams ADD COLUMN context_updated_at timestamptz;

-- A person's own context item proposed to a team. The id is also the id of its review item: the
-- item is applied to the team layer once an owner or admin approves that review item.
CREATE TABLE context_proposals (
  id uuid PRIMARY KEY,
  team_id text NOT NULL REFERENCES teams (id),
  person text NOT NULL,
  -- kind:name, such as rule:no-secrets.
  item text NOT NULL,
  -- The item's files, in the same shape as a layer's.
  files jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'applied', 'refused')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by text,
  note text
);

CREATE INDEX context_proposals_team_idx ON context_proposals (team_id, created_at DESC);
CREATE INDEX context_proposals_open_idx ON context_proposals (team_id) WHERE state = 'open';

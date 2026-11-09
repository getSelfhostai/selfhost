-- Background runs: an agent CLI working in a sandbox on the team's runtime. One row per run, the
-- whole selfhost.background_run/v1 record in body, with indexed copies of what lists and rate
-- limits filter on. What happened during the run is in events (run_id = id); this row is its
-- current state, rewritten as the run moves.
CREATE TABLE background_runs (
  id text PRIMARY KEY,
  team text NOT NULL,
  org text,
  repo text NOT NULL,
  state text NOT NULL,
  person text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  body jsonb NOT NULL
);

CREATE INDEX background_runs_team_idx ON background_runs (team, created_at DESC);
CREATE INDEX background_runs_active_idx ON background_runs (state)
  WHERE state NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'stuck');

-- Kill switches per team and org. While one is in force (cleared_at is null) every run in its
-- scope is stopped and new ones are refused. Rows are kept after clearing, as the record of who
-- used the switch and who cleared it.
CREATE TABLE background_kills (
  id uuid PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('team', 'org')),
  target text NOT NULL,
  killed_by text NOT NULL,
  reason text,
  killed_at timestamptz NOT NULL,
  cleared_by text,
  cleared_at timestamptz
);

CREATE UNIQUE INDEX background_kills_active_idx ON background_kills (scope, target)
  WHERE cleared_at IS NULL;

-- Run handoffs: one row per time a person handed an agent run (a session) to a teammate. The
-- whole selfhost.handoff/v1 record is in body, with indexed copies of what lists filter on. The
-- owner change itself is the run.handed_off event in events; this row is what the new owner
-- needs to take the run over. transcript holds the agent's own transcript, already redacted,
-- only when the team's [handoff] share_transcript is on, and is cleared once the run is taken
-- over or handed on again.
CREATE TABLE handoffs (
  id uuid PRIMARY KEY,
  run_id text NOT NULL,
  team text,
  from_person text NOT NULL,
  to_person text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'taken', 'superseded')),
  created_at timestamptz NOT NULL,
  taken_at timestamptz,
  body jsonb NOT NULL,
  transcript text
);

CREATE INDEX handoffs_run_idx ON handoffs (run_id, created_at);
CREATE INDEX handoffs_to_idx ON handoffs (lower(to_person), state, created_at DESC);

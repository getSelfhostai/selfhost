-- Ledger events: one row per selfhost.event/v1 record. The full event is kept in body; the other
-- columns are copies of the fields the API filters and sorts on.
CREATE TABLE events (
  id uuid PRIMARY KEY,
  ts timestamptz NOT NULL,
  source text NOT NULL,
  kind text NOT NULL,
  actor_kind text NOT NULL,
  actor_id text NOT NULL,
  agent text,
  model text,
  session_id text,
  body jsonb NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now()
);

-- Every query reads newest first by (ts, id), which is also the pagination key.
CREATE INDEX events_ts_id_idx ON events (ts DESC, id DESC);
CREATE INDEX events_actor_ts_idx ON events (actor_id, ts DESC, id DESC);
CREATE INDEX events_agent_ts_idx ON events (agent, ts DESC, id DESC);
CREATE INDEX events_model_ts_idx ON events (model, ts DESC, id DESC);
CREATE INDEX events_session_ts_idx ON events (session_id, ts DESC, id DESC);
CREATE INDEX events_kind_ts_idx ON events (kind, ts DESC, id DESC);

-- Append-only. UPDATE, DELETE and TRUNCATE fail unless the session has set
-- selfhost.retention = 'on', which only the retention job does.
CREATE FUNCTION events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('selfhost.retention', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ledger events are append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege',
      HINT = 'Corrections are new events. Only the retention job removes rows.';
END;
$$;

CREATE TRIGGER events_no_update_delete
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_append_only();

CREATE TRIGGER events_no_truncate
  BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION events_append_only();

-- ENABLE ALWAYS keeps the triggers firing when session_replication_role is replica.
ALTER TABLE events ENABLE ALWAYS TRIGGER events_no_update_delete;
ALTER TABLE events ENABLE ALWAYS TRIGGER events_no_truncate;

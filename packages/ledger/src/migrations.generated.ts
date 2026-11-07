// Generated from packages/ledger/migrations. Run `pnpm --filter @selfhost/ledger embed-migrations` after changing them. Do not edit by hand.

export interface Migration {
  version: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: "0001_events",
    sql: "-- Ledger events: one row per selfhost.event/v1 record. The full event is kept in body; the other\n-- columns are copies of the fields the API filters and sorts on.\nCREATE TABLE events (\n  id uuid PRIMARY KEY,\n  ts timestamptz NOT NULL,\n  source text NOT NULL,\n  kind text NOT NULL,\n  actor_kind text NOT NULL,\n  actor_id text NOT NULL,\n  agent text,\n  model text,\n  session_id text,\n  body jsonb NOT NULL,\n  ingested_at timestamptz NOT NULL DEFAULT now()\n);\n\n-- Every query reads newest first by (ts, id), which is also the pagination key.\nCREATE INDEX events_ts_id_idx ON events (ts DESC, id DESC);\nCREATE INDEX events_actor_ts_idx ON events (actor_id, ts DESC, id DESC);\nCREATE INDEX events_agent_ts_idx ON events (agent, ts DESC, id DESC);\nCREATE INDEX events_model_ts_idx ON events (model, ts DESC, id DESC);\nCREATE INDEX events_session_ts_idx ON events (session_id, ts DESC, id DESC);\nCREATE INDEX events_kind_ts_idx ON events (kind, ts DESC, id DESC);\n\n-- Append-only. UPDATE, DELETE and TRUNCATE fail unless the session has set\n-- selfhost.retention = 'on', which only the retention job does.\nCREATE FUNCTION events_append_only() RETURNS trigger\nLANGUAGE plpgsql AS $$\nBEGIN\n  IF coalesce(current_setting('selfhost.retention', true), '') = 'on' THEN\n    IF TG_OP = 'DELETE' THEN\n      RETURN OLD;\n    END IF;\n    RETURN NEW;\n  END IF;\n  RAISE EXCEPTION 'ledger events are append-only: % is not allowed', TG_OP\n    USING ERRCODE = 'insufficient_privilege',\n      HINT = 'Corrections are new events. Only the retention job removes rows.';\nEND;\n$$;\n\nCREATE TRIGGER events_no_update_delete\n  BEFORE UPDATE OR DELETE ON events\n  FOR EACH ROW EXECUTE FUNCTION events_append_only();\n\nCREATE TRIGGER events_no_truncate\n  BEFORE TRUNCATE ON events\n  FOR EACH STATEMENT EXECUTE FUNCTION events_append_only();\n\n-- ENABLE ALWAYS keeps the triggers firing when session_replication_role is replica.\nALTER TABLE events ENABLE ALWAYS TRIGGER events_no_update_delete;\nALTER TABLE events ENABLE ALWAYS TRIGGER events_no_truncate;\n",
  },
];

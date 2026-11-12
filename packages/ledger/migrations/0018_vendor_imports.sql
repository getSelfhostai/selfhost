-- Where each vendor usage importer (Anthropic, OpenAI and Cursor admin APIs) has read up to, and
-- how its last run went. One row per importer. through_day is the last UTC day imported; the next
-- run starts the day after. state is ok, not_available (the key may not read the admin API) or
-- error. detail never holds a key.
CREATE TABLE vendor_imports (
  importer text PRIMARY KEY,
  through_day date,
  state text NOT NULL CHECK (state IN ('ok', 'not_available', 'error')),
  detail text,
  events integer NOT NULL DEFAULT 0,
  last_run_at timestamptz NOT NULL DEFAULT now()
);

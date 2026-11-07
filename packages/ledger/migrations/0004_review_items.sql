-- The review list: one row per thing that needs a person, built from ledger signals. Unlike
-- events these rows change: an item is answered, snoozed, expires or is closed by later activity.
-- Every change of state is also in the ledger, as the decision.recorded event that answered or
-- timed out the item or as the event that closed it, so the history stays append-only.
CREATE TABLE review_items (
  id uuid PRIMARY KEY,
  -- events.team of the signals the item was built from: the team of the person token that wrote
  -- them. NULL on a laptop ledger and for events written with the admin token.
  team text,
  -- Signals with the same key make one item while it is open.
  dedupe_key text NOT NULL,
  kind text NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'answered', 'dismissed', 'expired')),
  blocking boolean NOT NULL,
  risk_score integer NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  session_id text,
  -- Tool an approval waits on, when the signal names it.
  tool text,
  -- Files the signals named, for routing by [review.owners] and for the decision log.
  paths jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- Time of the newest signal. Session activity after it ends a wait.
  signal_at timestamptz NOT NULL,
  deadline timestamptz,
  snoozed_until timestamptz,
  -- Held while one surface records an answer, so two answers cannot both apply.
  claimed_until timestamptz,
  -- Bumped on every write. A write based on an older read changes nothing.
  version integer NOT NULL DEFAULT 0,
  -- The whole selfhost.review_item/v1 item.
  body jsonb NOT NULL
);

CREATE UNIQUE INDEX review_items_open_key_idx
  ON review_items ((coalesce(team, '')), dedupe_key) WHERE state = 'open';
CREATE INDEX review_items_key_idx ON review_items ((coalesce(team, '')), dedupe_key);
CREATE INDEX review_items_rank_idx
  ON review_items (state, blocking DESC, risk_score DESC, created_at, id);
CREATE INDEX review_items_waiting_idx ON review_items (session_id) WHERE state = 'open';
CREATE INDEX review_items_deadline_idx ON review_items (deadline) WHERE state = 'open';

-- Ledger events the review list has read, so a refresh never applies one twice.
CREATE TABLE review_signals (
  event_id uuid PRIMARY KEY,
  item_id uuid,
  read_at timestamptz NOT NULL DEFAULT now()
);

-- How far the review list has read the ledger, by events.ingested_at.
CREATE TABLE review_progress (
  id text PRIMARY KEY,
  ingested_at timestamptz NOT NULL
);

-- Proof receipts of agent pull requests, as the receipt step in CI posts them: one row per CI
-- run, newest last. The brief links the newest receipt for the pull request's head commit. The
-- whole selfhost.receipt/v1 document is kept in body (log tails are masked before they are
-- sent); the screenshots stay in the CI run's artifact.
CREATE TABLE receipts (
  id uuid PRIMARY KEY,
  -- owner/name in lower case, as events carry it.
  repo text NOT NULL CHECK (repo = lower(repo)),
  pull integer NOT NULL,
  head_sha text NOT NULL CHECK (head_sha = lower(head_sha)),
  verdict text NOT NULL,
  -- The pull request comment the receipt was posted as, once it is.
  comment_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  body jsonb NOT NULL
);

CREATE INDEX receipts_pull_idx ON receipts (repo, pull, created_at DESC);

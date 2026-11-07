-- GitHub webhook deliveries already handled, by their X-GitHub-Delivery id, so a delivery that
-- arrives twice changes nothing on the pull request the second time. Only the id, the event name
-- and when it arrived are kept, never the payload. Rows older than the retention window are
-- deleted as new deliveries come in; GitHub redelivers only recent deliveries.
CREATE TABLE github_deliveries (
  id text PRIMARY KEY,
  event text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX github_deliveries_received_at_idx ON github_deliveries (received_at);

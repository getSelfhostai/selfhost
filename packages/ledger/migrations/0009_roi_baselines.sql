-- Frozen baselines of cost per merged pull request. A row is written once, the first time a
-- baseline is read after its period ended, and never updated: imports of older history later on
-- do not move the number a pilot is measured against.
CREATE TABLE roi_baselines (
  -- Team id, or '' for the ledger of a laptop.
  team text NOT NULL,
  -- 'first_week', or the from/to of a period set in [roi], as ISO 8601 UTC.
  period text NOT NULL,
  from_ts timestamptz NOT NULL,
  to_ts timestamptz NOT NULL,
  -- The metric definition the numbers were computed with, such as cost_per_merged_agent_pr/v1.
  definition text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  -- The whole selfhost.roi/v1 report for the period.
  body jsonb NOT NULL,
  PRIMARY KEY (team, period)
);

CREATE FUNCTION roi_baselines_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ROI baselines are frozen: UPDATE is not allowed'
    USING ERRCODE = 'insufficient_privilege',
      HINT = 'Delete the row to compute the baseline again on the next read.';
END;
$$;

CREATE TRIGGER roi_baselines_no_update
  BEFORE UPDATE ON roi_baselines
  FOR EACH ROW EXECUTE FUNCTION roi_baselines_frozen();

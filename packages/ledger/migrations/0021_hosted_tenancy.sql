-- Org isolation for the hosted server (SELFHOST_MODE=hosted), with row-level security. The
-- server sets selfhost.org for the length of each transaction a person token's request makes;
-- each policy then shows and accepts only that org's rows. When selfhost.org is not set, which
-- is every self-hosted install, the admin token and the server's own jobs, every row passes as
-- before. Superusers and roles with BYPASSRLS skip the policies altogether, which is why a
-- hosted server refuses to start as one. So does the tables' owner: a hosted server, which owns
-- them, turns on FORCE ROW LEVEL SECURITY itself when it starts (enforceRowSecurity), so a
-- self-hosted install, its backups and its owner's queries do not change at all.
CREATE FUNCTION selfhost_org() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('selfhost.org', true), '') $$;

-- The teams of the org in scope, for the tables that name a team rather than an org.
CREATE FUNCTION selfhost_org_teams() RETURNS SETOF text
  LANGUAGE sql STABLE
  AS $$ SELECT id FROM teams WHERE org_id = selfhost_org() $$;

-- A seat limit set for one org (people in it, revoked ones not counted). NULL uses the
-- server's default (SELFHOST_HOSTED_FREE_SEATS); a self-hosted install has no limit.
ALTER TABLE orgs ADD COLUMN seats integer CHECK (seats IS NULL OR seats > 0);

-- Each org's own data key for the secrets the server keeps at rest (notification target URLs),
-- wrapped with the server's key (SELFHOST_HOSTED_SECRET_KEY). Only hosted servers write rows.
CREATE TABLE org_keys (
  org_id text PRIMARY KEY REFERENCES orgs (id),
  wrapped_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
CREATE POLICY orgs_org ON orgs
  USING (selfhost_org() IS NULL OR id = selfhost_org());

ALTER TABLE org_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_keys_org ON org_keys
  USING (selfhost_org() IS NULL OR org_id = selfhost_org());

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY teams_org ON teams
  USING (selfhost_org() IS NULL OR org_id = selfhost_org());

ALTER TABLE team_repos ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_repos_org ON team_repos
  USING (selfhost_org() IS NULL OR org_id = selfhost_org());

ALTER TABLE people ENABLE ROW LEVEL SECURITY;
CREATE POLICY people_org ON people
  USING (selfhost_org() IS NULL OR team_id IN (SELECT selfhost_org_teams()));

ALTER TABLE tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY tokens_org ON tokens
  USING (selfhost_org() IS NULL OR team_id IN (SELECT selfhost_org_teams()));

ALTER TABLE context_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY context_proposals_org ON context_proposals
  USING (selfhost_org() IS NULL OR team_id IN (SELECT selfhost_org_teams()));

-- Events with no team (written with the admin token) belong to no org.
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
CREATE POLICY events_org ON events
  USING (selfhost_org() IS NULL OR team IN (SELECT selfhost_org_teams()));

ALTER TABLE review_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY review_items_org ON review_items
  USING (selfhost_org() IS NULL OR team IN (SELECT selfhost_org_teams()));

ALTER TABLE roi_baselines ENABLE ROW LEVEL SECURITY;
CREATE POLICY roi_baselines_org ON roi_baselines
  USING (selfhost_org() IS NULL OR team IN (SELECT selfhost_org_teams()));

ALTER TABLE background_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY background_runs_org ON background_runs
  USING (selfhost_org() IS NULL OR team IN (SELECT selfhost_org_teams()));

ALTER TABLE background_kills ENABLE ROW LEVEL SECURITY;
CREATE POLICY background_kills_org ON background_kills
  USING (selfhost_org() IS NULL
    OR (scope = 'org' AND target = selfhost_org())
    OR (scope = 'team' AND target IN (SELECT selfhost_org_teams())));

ALTER TABLE handoffs ENABLE ROW LEVEL SECURITY;
CREATE POLICY handoffs_org ON handoffs
  USING (selfhost_org() IS NULL OR team IN (SELECT selfhost_org_teams()));

ALTER TABLE exception_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY exception_grants_org ON exception_grants
  USING (selfhost_org() IS NULL OR team IN (SELECT selfhost_org_teams()));

ALTER TABLE notify_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY notify_targets_org ON notify_targets
  USING (selfhost_org() IS NULL OR org = selfhost_org());

ALTER TABLE notify_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY notify_settings_org ON notify_settings
  USING (selfhost_org() IS NULL OR org = selfhost_org());

ALTER TABLE notify_sends ENABLE ROW LEVEL SECURITY;
CREATE POLICY notify_sends_org ON notify_sends
  USING (selfhost_org() IS NULL OR org = selfhost_org());

-- Proof receipts name a repo, not a team: an org sees the receipts of the repos its teams own.
ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY receipts_org ON receipts
  USING (selfhost_org() IS NULL
    OR repo IN (SELECT repo FROM team_repos WHERE org_id = selfhost_org()));

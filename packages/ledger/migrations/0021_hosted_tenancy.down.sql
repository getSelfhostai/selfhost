-- Rolls back 0021_hosted_tenancy.sql: no row-level security, no per-org keys or seat limits.
-- Notification targets a hosted server sealed with an org key stay sealed and stop delivering.
DROP POLICY receipts_org ON receipts;
ALTER TABLE receipts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE receipts DISABLE ROW LEVEL SECURITY;

DROP POLICY notify_sends_org ON notify_sends;
ALTER TABLE notify_sends NO FORCE ROW LEVEL SECURITY;
ALTER TABLE notify_sends DISABLE ROW LEVEL SECURITY;

DROP POLICY notify_settings_org ON notify_settings;
ALTER TABLE notify_settings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE notify_settings DISABLE ROW LEVEL SECURITY;

DROP POLICY notify_targets_org ON notify_targets;
ALTER TABLE notify_targets NO FORCE ROW LEVEL SECURITY;
ALTER TABLE notify_targets DISABLE ROW LEVEL SECURITY;

DROP POLICY exception_grants_org ON exception_grants;
ALTER TABLE exception_grants NO FORCE ROW LEVEL SECURITY;
ALTER TABLE exception_grants DISABLE ROW LEVEL SECURITY;

DROP POLICY handoffs_org ON handoffs;
ALTER TABLE handoffs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE handoffs DISABLE ROW LEVEL SECURITY;

DROP POLICY background_kills_org ON background_kills;
ALTER TABLE background_kills NO FORCE ROW LEVEL SECURITY;
ALTER TABLE background_kills DISABLE ROW LEVEL SECURITY;

DROP POLICY background_runs_org ON background_runs;
ALTER TABLE background_runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE background_runs DISABLE ROW LEVEL SECURITY;

DROP POLICY roi_baselines_org ON roi_baselines;
ALTER TABLE roi_baselines NO FORCE ROW LEVEL SECURITY;
ALTER TABLE roi_baselines DISABLE ROW LEVEL SECURITY;

DROP POLICY review_items_org ON review_items;
ALTER TABLE review_items NO FORCE ROW LEVEL SECURITY;
ALTER TABLE review_items DISABLE ROW LEVEL SECURITY;

DROP POLICY events_org ON events;
ALTER TABLE events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE events DISABLE ROW LEVEL SECURITY;

DROP POLICY context_proposals_org ON context_proposals;
ALTER TABLE context_proposals NO FORCE ROW LEVEL SECURITY;
ALTER TABLE context_proposals DISABLE ROW LEVEL SECURITY;

DROP POLICY tokens_org ON tokens;
ALTER TABLE tokens NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tokens DISABLE ROW LEVEL SECURITY;

DROP POLICY people_org ON people;
ALTER TABLE people NO FORCE ROW LEVEL SECURITY;
ALTER TABLE people DISABLE ROW LEVEL SECURITY;

DROP POLICY team_repos_org ON team_repos;
ALTER TABLE team_repos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE team_repos DISABLE ROW LEVEL SECURITY;

DROP POLICY teams_org ON teams;
ALTER TABLE teams NO FORCE ROW LEVEL SECURITY;
ALTER TABLE teams DISABLE ROW LEVEL SECURITY;

DROP POLICY org_keys_org ON org_keys;
DROP TABLE org_keys;

DROP POLICY orgs_org ON orgs;
ALTER TABLE orgs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE orgs DISABLE ROW LEVEL SECURITY;

ALTER TABLE orgs DROP COLUMN seats;

DROP FUNCTION selfhost_org_teams();
DROP FUNCTION selfhost_org();

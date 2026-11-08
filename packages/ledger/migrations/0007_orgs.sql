-- Org, team and repo hierarchy. One org holds many teams; each team owns repos; a person can
-- be in several teams of an org (one people row per team, each with its own role). Existing
-- teams go into the org "default", so a single-team install changes nothing.
CREATE TABLE orgs (
  id text PRIMARY KEY,
  name text NOT NULL,
  -- The org's selfhost.toml: the floor every team and repo policy builds on. NULL until set.
  policy_text text,
  policy_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO orgs (id, name) VALUES ('default', 'default');

ALTER TABLE teams ADD COLUMN org_id text NOT NULL DEFAULT 'default' REFERENCES orgs (id);

CREATE INDEX teams_org_idx ON teams (org_id);

-- The team that owns each repo, one per org. repo is owner/name in lower case, as events carry
-- it; remote is host/owner/name as given. A repo may add rules of its own on top of its team's.
CREATE TABLE team_repos (
  org_id text NOT NULL REFERENCES orgs (id),
  repo text NOT NULL CHECK (repo = lower(repo)),
  remote text NOT NULL,
  team_id text NOT NULL REFERENCES teams (id),
  policy_text text,
  policy_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, repo)
);

CREATE INDEX team_repos_team_idx ON team_repos (team_id);
CREATE INDEX team_repos_repo_idx ON team_repos (repo);

-- The repo each run worked in, from the first event of the session that named one (a Codex
-- event, a commit or a pull request from selfhost scan). A run belongs to the team that owns
-- its repo, also for its events that carry no repo themselves.
CREATE TABLE run_repos (
  session_id text PRIMARY KEY,
  repo text NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now()
);

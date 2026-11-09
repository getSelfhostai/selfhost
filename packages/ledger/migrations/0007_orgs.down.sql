-- Rolls back 0007_orgs.sql: orgs, repo ownership and the repo of each run. Teams stay.
DROP TABLE run_repos;
DROP TABLE team_repos;
DROP INDEX teams_org_idx;
ALTER TABLE teams DROP COLUMN org_id;
DROP TABLE orgs;

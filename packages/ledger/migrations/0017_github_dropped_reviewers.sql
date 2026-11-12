-- Review requests GitHub accepted but did not keep, by agent pull request: GitHub answers 201 to a
-- request for a team without access to the repository and keeps nothing, so the pull request
-- sync does not ask for them again. Kept here so a restart does not ask again either. One row per
-- pull request (owner/repo#number); users and teams are JSON arrays of logins and team slugs.
CREATE TABLE github_dropped_reviewers (
  pull text PRIMARY KEY,
  users jsonb NOT NULL DEFAULT '[]',
  teams jsonb NOT NULL DEFAULT '[]',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX github_dropped_reviewers_updated_idx ON github_dropped_reviewers (updated_at);

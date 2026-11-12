-- Rolls back 0017_github_dropped_reviewers.sql. The pull request sync then asks once more for the
-- reviewers GitHub did not keep, and remembers them until the next restart.
DROP TABLE github_dropped_reviewers;

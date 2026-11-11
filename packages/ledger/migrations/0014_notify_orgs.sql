-- Notification targets, digest settings and sends belong to a person in one org. Person ids are
-- unique within an org only, so someone who joins another org under the same id must not read,
-- remove or add to the targets of the person in the first org, nor get their digests.
ALTER TABLE notify_targets ADD COLUMN org text NOT NULL DEFAULT 'default';
ALTER TABLE notify_settings ADD COLUMN org text NOT NULL DEFAULT 'default';
ALTER TABLE notify_sends ADD COLUMN org text NOT NULL DEFAULT 'default';

-- Rows from before go to the org of the person's first team, where they were added from.
WITH first AS (
  SELECT DISTINCT ON (lower(p.id)) lower(p.id) AS person, t.org_id
  FROM people p JOIN teams t ON t.id = p.team_id
  ORDER BY lower(p.id), p.created_at, p.team_id
)
UPDATE notify_targets n SET org = first.org_id FROM first WHERE lower(n.person) = first.person;

WITH first AS (
  SELECT DISTINCT ON (lower(p.id)) lower(p.id) AS person, t.org_id
  FROM people p JOIN teams t ON t.id = p.team_id
  ORDER BY lower(p.id), p.created_at, p.team_id
)
UPDATE notify_settings n SET org = first.org_id FROM first WHERE lower(n.person) = first.person;

WITH first AS (
  SELECT DISTINCT ON (lower(p.id)) lower(p.id) AS person, t.org_id
  FROM people p JOIN teams t ON t.id = p.team_id
  ORDER BY lower(p.id), p.created_at, p.team_id
)
UPDATE notify_sends n SET org = first.org_id FROM first WHERE lower(n.person) = first.person;

ALTER TABLE notify_targets DROP CONSTRAINT notify_targets_pkey;
ALTER TABLE notify_targets ADD PRIMARY KEY (org, person, name);
ALTER TABLE notify_settings DROP CONSTRAINT notify_settings_pkey;
ALTER TABLE notify_settings ADD PRIMARY KEY (org, person);

DROP INDEX notify_sends_person_idx;
DROP INDEX notify_sends_subject_idx;
CREATE INDEX notify_sends_person_idx ON notify_sends (org, person, sent_at DESC);
CREATE INDEX notify_sends_subject_idx ON notify_sends (org, person, kind, subject);

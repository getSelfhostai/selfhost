-- Rolls back 0014_notify_orgs.sql. Targets and settings are keyed by person alone again: where
-- the same person id has them in more than one org, only those of the default org (else the
-- first org by name) are kept.
DELETE FROM notify_targets n WHERE EXISTS (
  SELECT 1 FROM notify_targets o
  WHERE o.person = n.person AND o.name = n.name AND o.org <> n.org
    AND (o.org = 'default' OR (n.org <> 'default' AND o.org < n.org))
);
DELETE FROM notify_settings n WHERE EXISTS (
  SELECT 1 FROM notify_settings o
  WHERE o.person = n.person AND o.org <> n.org
    AND (o.org = 'default' OR (n.org <> 'default' AND o.org < n.org))
);

DROP INDEX notify_sends_person_idx;
DROP INDEX notify_sends_subject_idx;
CREATE INDEX notify_sends_person_idx ON notify_sends (person, sent_at DESC);
CREATE INDEX notify_sends_subject_idx ON notify_sends (person, kind, subject);

ALTER TABLE notify_settings DROP CONSTRAINT notify_settings_pkey;
ALTER TABLE notify_settings ADD PRIMARY KEY (person);
ALTER TABLE notify_targets DROP CONSTRAINT notify_targets_pkey;
ALTER TABLE notify_targets ADD PRIMARY KEY (person, name);

ALTER TABLE notify_sends DROP COLUMN org;
ALTER TABLE notify_settings DROP COLUMN org;
ALTER TABLE notify_targets DROP COLUMN org;

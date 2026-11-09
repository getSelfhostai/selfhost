-- Notifications: where each person's alerts and digests go, how often their digest comes, and
-- a record of every send. Delivery goes through Apprise; selfhost only decides what and when.

-- One row per target. url is an Apprise URL, which carries a secret (a bot token, a webhook
-- path, a password): the API never returns it, only its scheme and a masked form. person is the
-- id their events carry, such as a git email; on a laptop it is the person selfhost import uses.
CREATE TABLE notify_targets (
  person text NOT NULL,
  name text NOT NULL,
  url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person, name)
);

-- A person's own digest cadence. No row, or a NULL digest, means the team's [notify] digest.
CREATE TABLE notify_settings (
  person text PRIMARY KEY,
  digest text CHECK (digest IN ('daily', 'weekly', 'off')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every send: to which target (by name, never the URL), what it was and whether it went. subject
-- is the review item, the alert event or the digest window, so nothing is sent twice. Rows older
-- than 90 days are deleted as new sends come in.
CREATE TABLE notify_sends (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  person text NOT NULL,
  target text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('item', 'spend', 'digest', 'spend_digest', 'test')),
  subject text,
  ok boolean NOT NULL,
  error text,
  sent_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notify_sends_person_idx ON notify_sends (person, sent_at DESC);
CREATE INDEX notify_sends_subject_idx ON notify_sends (person, kind, subject);

/** The few calls seedLedger needs; a ledger Database or transaction has them. */
interface Queryable {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
}

const event = (n: number, kind: string) =>
  `('01930c4e-2f1a-7b2c-8d3e-${n.toString(16).padStart(12, "0")}', '2026-11-0${n}T09:30:00Z', 'hook',
    '${kind}', 'person', 'alice@example.com', '{"id":"seed-${n}","kind":"${kind}"}')`;

/**
 * Rows for every ledger table, each written with the columns of the migration that created the
 * table, so they fit the schema of any release that has it. Keys are fixed and every insert skips
 * rows already there, so seeding again after an upgrade only fills tables the upgrade added.
 * A new table needs a line here: the upgrade test fails on a table with no rows.
 */
export const SEEDS: readonly (readonly [table: string, sql: string])[] = [
  [
    "events",
    `INSERT INTO events (id, ts, source, kind, actor_kind, actor_id, body)
     VALUES ${[event(1, "session.started"), event(2, "tool.called"), event(3, "session.ended")].join(", ")}
     ON CONFLICT DO NOTHING`,
  ],
  ["teams", "INSERT INTO teams (id, name) VALUES ('seed', 'Seed') ON CONFLICT DO NOTHING"],
  [
    "people",
    `INSERT INTO people (team_id, id, role) VALUES ('seed', 'alice@example.com', 'owner'),
     ('seed', 'bob@example.com', 'member') ON CONFLICT DO NOTHING`,
  ],
  [
    "tokens",
    `INSERT INTO tokens (hash, kind, team_id, person_id)
     VALUES ('seed-token-hash', 'person', 'seed', 'alice@example.com') ON CONFLICT DO NOTHING`,
  ],
  [
    "review_items",
    `INSERT INTO review_items (id, dedupe_key, kind, state, blocking, risk_score, created_at,
       updated_at, signal_at, body)
     VALUES ('5eed0000-0000-4000-8000-000000000001', 'seed', 'approval', 'open', true, 40,
       '2026-11-01T09:30:00Z', '2026-11-01T09:30:00Z', '2026-11-01T09:30:00Z', '{}')
     ON CONFLICT DO NOTHING`,
  ],
  [
    "review_signals",
    `INSERT INTO review_signals (event_id, item_id)
     VALUES ('01930c4e-2f1a-7b2c-8d3e-000000000001', '5eed0000-0000-4000-8000-000000000001')
     ON CONFLICT DO NOTHING`,
  ],
  [
    "review_progress",
    "INSERT INTO review_progress (id, ingested_at) VALUES ('ledger', '2026-11-03T09:30:00Z') ON CONFLICT DO NOTHING",
  ],
  [
    "github_deliveries",
    "INSERT INTO github_deliveries (id, event) VALUES ('seed-delivery', 'pull_request') ON CONFLICT DO NOTHING",
  ],
  ["orgs", "INSERT INTO orgs (id, name) VALUES ('acme', 'Acme') ON CONFLICT DO NOTHING"],
  [
    "team_repos",
    `INSERT INTO team_repos (org_id, repo, remote, team_id)
     VALUES ('default', 'acme/web', 'github.com/acme/web', 'seed') ON CONFLICT DO NOTHING`,
  ],
  [
    "run_repos",
    "INSERT INTO run_repos (session_id, repo) VALUES ('seed-session', 'acme/web') ON CONFLICT DO NOTHING",
  ],
  [
    "receipts",
    `INSERT INTO receipts (id, repo, pull, head_sha, verdict, body)
     VALUES ('5eed0000-0000-4000-8000-000000000002', 'acme/web', 7, 'abc123', 'pass', '{}')
     ON CONFLICT DO NOTHING`,
  ],
  [
    "roi_baselines",
    `INSERT INTO roi_baselines (team, period, from_ts, to_ts, definition, body)
     VALUES ('seed', 'first_week', '2026-10-01T00:00:00Z', '2026-10-08T00:00:00Z',
       'cost_per_merged_agent_pr/v1', '{}') ON CONFLICT DO NOTHING`,
  ],
  [
    "context_proposals",
    `INSERT INTO context_proposals (id, team_id, person, item, files, state)
     VALUES ('5eed0000-0000-4000-8000-000000000003', 'seed', 'dev@example.com', 'rule:seed',
       '[]', 'open') ON CONFLICT DO NOTHING`,
  ],
  [
    "notify_targets",
    `INSERT INTO notify_targets (person, name, url)
     VALUES ('alice@example.com', 'phone', 'ntfys://seed-topic') ON CONFLICT DO NOTHING`,
  ],
  [
    "notify_settings",
    "INSERT INTO notify_settings (person, digest) VALUES ('alice@example.com', 'weekly') ON CONFLICT DO NOTHING",
  ],
  [
    "notify_sends",
    `INSERT INTO notify_sends (person, target, kind, subject, ok)
     SELECT 'alice@example.com', 'phone', 'test', 'seed', true
     WHERE NOT EXISTS (SELECT 1 FROM notify_sends WHERE subject = 'seed')`,
  ],
  [
    "background_runs",
    `INSERT INTO background_runs (id, team, repo, state, created_at, updated_at, body)
     VALUES ('seed-run', 'seed', 'acme/web', 'succeeded', '2026-11-09T09:30:00Z',
       '2026-11-09T09:40:00Z', '{}') ON CONFLICT DO NOTHING`,
  ],
  [
    "background_kills",
    `INSERT INTO background_kills (id, scope, target, killed_by, killed_at, cleared_by, cleared_at)
     VALUES ('5eed0000-0000-4000-8000-000000000013', 'team', 'seed', 'alice@example.com',
       '2026-11-09T09:30:00Z', 'alice@example.com', '2026-11-09T09:35:00Z') ON CONFLICT DO NOTHING`,
  ],
  [
    "handoffs",
    `INSERT INTO handoffs (id, run_id, team, from_person, to_person, state, created_at, body)
     VALUES ('5eed0000-0000-4000-8000-000000000014', 'seed-session', 'seed', 'alice@example.com',
       'bob@example.com', 'pending', '2026-11-11T09:30:00Z', '{}') ON CONFLICT DO NOTHING`,
  ],
];

/** Seeds every table of SEEDS the database has; tables a release does not have are skipped. */
export async function seedLedger(db: Queryable): Promise<void> {
  for (const [table, sql] of SEEDS) {
    const [found] = await db.query<{ found: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS found",
      [table],
    );
    if (found?.found) await db.exec(sql);
  }
}

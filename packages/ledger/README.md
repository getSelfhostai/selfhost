# @selfhost/ledger

The append-only store for `selfhost.event/v1` events, on Postgres 16 (self-hosted and hosted) or
embedded PGlite (laptop install), with the same SQL on both. It also maps each ingest source to
the event schema.

```ts
import { openLedger } from "@selfhost/ledger";

const ledger = await openLedger({ url: process.env.DATABASE_URL });
const { accepted, duplicates } = await ledger.append(events);
const { events, nextCursor } = await ledger.query({ person: "alice@example.com", limit: 50 });
await ledger.close();
```

## Storage

- `url` starting with `postgres://` or `postgresql://` uses that server. Without a `url`, the
  embedded PGlite database lives in `dataDir`, else `SELFHOST_DATA_DIR`, else `~/.selfhost/data`.
  `dataDir: "memory://"` keeps everything in memory, for tests. Any other `url` is an error.
- One `events` table: the full event as `jsonb` in `body`, plus indexed copies of `ts`, `source`,
  `kind`, `actor_id`, `agent` (vendor), `model` and `session_id`. Team mode adds `teams`,
  `people` and `tokens` (see Teams below).
- Migrations are the SQL files in `migrations/`, applied in order on open under an advisory lock and
  recorded in `schema_migrations`. `src/migrations.generated.ts` embeds them so bundles and
  compiled binaries need no files on disk; after changing a migration run
  `pnpm --filter @selfhost/ledger embed-migrations` (a test fails if you forget).

## Append

`append(events)` validates every event with `validateEvent` from `@selfhost/schema` before writing
anything. If any event is invalid, nothing is written and it throws `LedgerValidationError` with
`errors: { index, path, message }[]`, one per bad field. Valid events are redacted (below) and
written in one transaction. Ids are idempotency keys: an id that is already stored (compared case-insensitively)
is reported under `duplicates` and the stored event is not changed. Batches of any size are
accepted; the HTTP API caps requests at 1000.

## Redaction

`append` is the one write path every source goes through (the HTTP API, OTLP, hook mappers, the
local log importer), so it is where redaction happens: nothing reaches the database before
`redactEvent` from `@selfhost/schema` has run on it.

- Prompt and response text (`data.prompt`, `data.messages`, `data.response`,
  `data.completion`) is dropped unless prompt logging is on, whatever the writer sent.
- Secret-shaped values (provider API keys, GitHub, GitLab, Slack, npm, Stripe, AWS and Google
  keys, selfhost tokens, JWTs, private keys, `NAME=value` credentials, auth headers, credentials
  in URLs), email addresses and every `[[redaction]]` pattern are masked in
  `tool.input_summary`, `target.value`, `decision.reason` and every string under `data`. Built-in
  matches become `[redacted]`, a `[[redaction]]` match `[redacted:<name>]`. `actor` and
  `decision.by` are kept: they say who did it.
- Each dropped or masked field path is added to `redacted`.

Settings come from the team the event goes to (see Orgs below), else the event's `team`: a team
with a policy gets the `[ledger] log_prompts` and `[[redaction]]` of the policy in use, its
stored `selfhost.toml` on top of its org's, so the org's redaction patterns apply to every team. Every other event gets the `redaction` option
of `openLedger` (`{ logPrompts, patterns }`), which defaults to no prompt text and the built-in
patterns only.

## Retention

`retentionSweep(ledger, days, now?)` deletes events whose `ts` is more than `days` days before
`now`. Events of a team with a stored `selfhost.toml` use its `ledger.retention_days` instead. It
returns `{ deleted, before, teams }`. The server runs it daily; `selfhost ledger prune` runs it on
a local ledger.

## Query

`query(filter)` filters by `person` (actor id), `agent` (vendor), `model`, `session`, `kind`, `from`
(inclusive) and `to` (exclusive). Results are newest first by `(ts, id)`, which is also the keyset
for `cursor`. `limit` defaults to 100, max 1000. A bad filter throws `LedgerQueryError` naming the
field.

## Append-only

The API has no update or delete. A trigger on `events` (`ENABLE ALWAYS`, so it also fires under
`session_replication_role = replica`) rejects UPDATE, DELETE and TRUNCATE unless the session has
set `selfhost.retention = 'on'`. Only `retentionSweep` does that, with `SET LOCAL` inside its own
transaction, so the guard ends with that transaction. Corrections are new events that point at
the old one.

## Decisions

The human decision log lives in the same `events` table: one `decision.recorded` event per human
answer, next to the `policy.evaluated` rule verdicts. `src/decisions/` holds the one write path
and the one read path every surface uses, so a decision made in GitHub, the CLI, a chat button
or the console reads the same everywhere.

```ts
import { recordDecision, renderDecisions } from "@selfhost/ledger";

const { event, duplicate } = await recordDecision(ledger, {
  verdict: "deny",
  by: "alice@example.com",
  reason: "Keep the old index until the backfill finishes",
  question: "Drop the users_email index?",
  run_id: "run-42",
  paths: ["db/migrations/0007_drop_index.sql"],
  surface: "cli",
});
const page = await ledger.decisions.search({ path: "db/migrations", topic: "index" });
console.log(renderDecisions(page));
```

- `recordDecision(writer, input)` takes a `CreateDecisionRequest` (the `POST /v1/decisions`
  body, from `@selfhost/schema`), validates it, builds the event and writes it with
  `ledger.append`, so retention and redaction in the write path apply; the event it returns is
  read back as stored. It needs who (`by`) and what the decision answers (`item_id`, `run_id`,
  `rule_id` or `pr_url`). One file becomes the event's `target`, several go in `data.paths`; the
  question goes in `data.question` and the surface in `data.surface`. Invalid input throws
  `DecisionInputError` and writes nothing.
- The actor is the person in `by`. With the option `system: true` it is a system actor instead,
  for the one decision no person makes: the review list denying an approval at its timeout
  (`by: "selfhost"`, `surface: "timeout"`).
- Idempotency: with `key` (the surface's own id for the action, such as a GitHub review id) and
  `ts`, the event id is derived from the surface, key and time, so a redelivery stores nothing
  new and returns the stored decision with `duplicate: true`. Without a key every call records a
  decision.
- Corrections: decisions are never edited. `replaces_event_id` records a correction or overturn
  as a new event linked to the decision or rule verdict it changes; item, run, rule, question,
  paths and links it leaves out are carried over, so searches find both.
- `ledger.decisions.search(query)` takes a `DecisionQuery` and returns both kinds newest first
  with keyset pages. `path` matches on whole path segments: the file itself, files under a
  folder, folders that hold the file, and an absolute path in a rule verdict that ends with it.
  `topic` needs every word, case ignored, in the question or reason. `replacedBy` on the page
  lists, for each decision on it, the later decisions that replaced it. The HTTP API, the CLI
  and the MCP tool `search_decisions` all call it.
- `renderDecisions(page)` is the plain text all three print: each decision's id, time, verdict
  and who, then question, reason, rule, item, run, files and links, one block each.
- `chatDecision(press)` is the seam for the Slack and Telegram apps, which are not built yet:
  given a verified button press mapped to a person, it returns the decision with a one-line
  reason and the press id as key. The GitHub mapper is `githubDecision` in
  [`@selfhost/attribution`](../attribution/README.md#decisions-from-github).

## Teams

`ledger.teams` stores team mode's rows for the server (see
[`apps/server`](../../apps/server/README.md#teams)) in the same database, from migration
`0002_teams.sql`: `teams` (with the team's `selfhost.toml` text), `people` (id such as a git
email, role `owner`, `admin` or `member`) and `tokens` (only the sha256 of each invite, person
or admin token, with `revoked_at`). Unlike `events`, these rows change: a policy is replaced and
a token is revoked. Tokens are generated here and returned once.

`0003_team_access.sql` gives every invite an `expires_at` (7 days by default, set per invite) and
an optional `email`: an invite for an email joins only that person, under that email. It also
adds `events.team`, indexed with `(ts, id)`: `append(events, { team })` sets it for a batch
written with a person token, from the token's team and never from the event body, and
`query({ team })` reads one team's events. The column is added without touching stored rows, so
events written before it have no team.

`0006_roles.sql` records who last changed a person's role and when (`role_changed_by`,
`role_changed_at`) and adds a trigger that refuses an update leaving a team with people and no
owner. `teams.setRole` checks the same under a lock on the team row, so two owners demoting
each other at once leave one. `teams.listPeople`, `getPerson`, `renameTeam`, `getInvite` and
`addPerson` (someone already in another team of the org, under the id and name they have there)
serve the role and people routes of the server.

## Orgs

`ledger.orgs` holds the org, team and repo hierarchy, from `0007_orgs.sql`:

- `orgs`: id, name and the org's `selfhost.toml`, the floor of every team and repo policy in it.
  The migration creates the org `default` and puts every existing team in it (`teams.org_id`),
  so a single-team install changes nothing.
- `team_repos`: the team that owns each repo, one per org, keyed by `owner/name` in lower case
  (what events carry as `repo`), with the remote as `host/owner/name` and optional rules of the
  repo's own. Repos are keyed by `owner/name`, so two hosts with the same path are one repo.
- `run_repos`: the repo each run (agent session) worked in, from the first event of the session
  that named one, written on every append.

A person is identified by their id across the org: one `people` row per team they are in, each
with its own role, and their tokens act in every team of the org they are in. So a team-wide
invite only adds ids new to the org; a person already in the org joins another team with an
invite for their email or `teams.addPerson`.

`append(events, { team })` stores each event with the team that owns its run: the team owning
the event's `repo`, else the team owning the repo its session named earlier (`run_repos`), else
the writer's team, considering only teams of the writer's org. With a writer team the event's
`team` field is set to the same. Without one (the admin token) a repo counts when exactly one
org maps it, and the body is kept. `orgs.teamCosts(org, teams, from, to)` reads `cost.recorded`
events by the same rule at read time, so a Claude Code run whose cost events carried no repo
moves to the repo's team once a later event of the session (a commit from `selfhost scan`)
names the repo. `orgs.effectivePolicy(team, repo?)` composes the org floor, the team's file and
the repo's (`composePolicy` in [`@selfhost/schema`](../schema/README.md#org-team-and-repo-policy)).

## Review list

`0004_review_items.sql` adds `review_items`, `review_signals` and `review_progress` for the
review list ([`packages/review`](../review/README.md)), in the same database. Like teams, items
change; every change of state is also a ledger event or decision. `databaseOf(ledger)` gives
that package the database behind a ledger.

## GitHub deliveries

`ledger.deliveries` keeps the `X-GitHub-Delivery` ids of GitHub App webhooks the server has
handled, from migration `0005_github_deliveries.sql`: the id, the event name and when it
arrived, never the payload. `claim(id, { event })` records an id and returns false when it was
already there, so a delivery that arrives twice is handled once (two racing claims get one
true); `release(id)` forgets it after a failed sync so GitHub's redelivery runs again. Each claim
deletes ids older than `DELIVERY_RETENTION_DAYS` (7); GitHub redelivers only the last 3 days.

## Sources

Every event records its `source`, so a session one source misses still shows up from another,
labelled with where it came from. Mappers return events ready for `append`; ids are derived from
the source record, so mapping the same record twice gives the same id.

| Function                                              | Input                                                                      | `source`     |
| ----------------------------------------------------- | -------------------------------------------------------------------------- | ------------ |
| `mapClaudeCodeHook`, `mapCodexHook`, `mapCodexNotify` | Hook payloads (`fixtures/hooks/`)                                          | `hook`       |
| `mapOtelLogs`                                         | OTLP JSON logs from Claude Code and Codex (`fixtures/sources/otel/`)       | `otel`       |
| `mapGatewayLog`                                       | LiteLLM request logs (`fixtures/sources/gateway/`)                         | `gateway`    |
| `mapVendorAudit`                                      | Anthropic Compliance API style activity (`fixtures/sources/vendor-audit/`) | `vendor_api` |

Every `cost.recorded` event carries `data.request_type` (see
[`packages/spend`](../spend/README.md#request-types)). `mapOtelLogs` takes one OTLP export or an
array of them (one per line of the collector's file output) and reads Claude Code's
`query_source`, finds retries from `api_error` and Codex `attempt` across the whole input, and
reads Codex tokens from `codex.sse_event` (`response.completed`), since `codex.api_request` has
none.

Gateway events carry the virtual key's alias in `data.key_alias` (never the key or its hash),
which the spend spike alarm uses to tell keys apart and to offer disabling one.

Hook payloads carry no time and no user: pass `ts` and `person` in the context. Claude Code
notifications become `approval.requested` only when the agent waits on a person:
`notification_type` `permission_prompt`, `idle_prompt` or `elicitation_dialog`, kept in
`data.notification_type`; the review list reads the last two as questions. Prompt text is
dropped unless `logPrompts` is on (`ledger.log_prompts` in `selfhost.toml`); its length is kept and
`redacted` lists `data.prompt`. `append` drops it again unless the ledger's own settings keep
prompts. Token counts without a reported cost use `ctx.price`, else `usd`
is 0 and `data.unpriced` is true.

## Tests

`pnpm --filter @selfhost/ledger test` runs everything on in-memory PGlite. With `DATABASE_URL` set
(CI provides Postgres 16), the ledger and append-only suites also run against that server, each
in a schema of its own that is dropped afterwards.

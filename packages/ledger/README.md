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
`errors: { index, path, message }[]`, one per bad field. Valid events are written in one
transaction. Ids are idempotency keys: an id that is already stored (compared case-insensitively)
is reported under `duplicates` and the stored event is not changed. Batches of any size are
accepted; the HTTP API caps requests at 1000.

## Query

`query(filter)` filters by `person` (actor id), `agent` (vendor), `model`, `session`, `kind`, `from`
(inclusive) and `to` (exclusive). Results are newest first by `(ts, id)`, which is also the keyset
for `cursor`. `limit` defaults to 100, max 1000. A bad filter throws `LedgerQueryError` naming the
field.

## Append-only

The API has no update or delete. A trigger on `events` (`ENABLE ALWAYS`, so it also fires under
`session_replication_role = replica`) rejects UPDATE, DELETE and TRUNCATE unless the session has
set `selfhost.retention = 'on'`. Only the retention job does that, with `SET LOCAL` inside its own
transaction. Corrections are new events that point at the old one.

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

Hook payloads carry no time and no user: pass `ts` and `person` in the context. Prompt text is
dropped unless `logPrompts` is on (`ledger.log_prompts` in `selfhost.toml`); its length is kept and
`redacted` lists `data.prompt`. Token counts without a reported cost use `ctx.price`, else `usd`
is 0 and `data.unpriced` is true.

## Tests

`pnpm --filter @selfhost/ledger test` runs everything on in-memory PGlite. With `DATABASE_URL` set
(CI provides Postgres 16), the ledger and append-only suites also run against that server, each
in a schema of its own that is dropped afterwards.

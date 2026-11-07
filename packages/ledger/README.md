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

Settings come from the event's `team`: a team with a stored `selfhost.toml` (`ledger.teams`) gets
its own `[ledger] log_prompts` and `[[redaction]]`. Every other event gets the `redaction` option
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
`redacted` lists `data.prompt`. `append` drops it again unless the ledger's own settings keep
prompts. Token counts without a reported cost use `ctx.price`, else `usd`
is 0 and `data.unpriced` is true.

## Tests

`pnpm --filter @selfhost/ledger test` runs everything on in-memory PGlite. With `DATABASE_URL` set
(CI provides Postgres 16), the ledger and append-only suites also run against that server, each
in a schema of its own that is dropped afterwards.

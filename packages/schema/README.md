# @selfhost/schema

The contracts every selfhost module reads and writes. The TypeBox source in `src/` is the single
source of truth: TypeBox schemas are JSON Schema, TypeScript types derive from them with
`Static<>`, and `pnpm --filter @selfhost/schema export` writes the JSON Schema, OpenAPI and MCP
files below. A test fails when those files drift from the source.

| Contract            | Version tag               | Source                               | Generated                                                                                           |
| ------------------- | ------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Ledger event        | `selfhost.event/v1`       | `src/event.ts`                       | `json/event.schema.json`                                                                            |
| `selfhost.toml`     | `version = 1`             | `src/config.ts`                      | `json/config.schema.json`                                                                           |
| Review item         | `selfhost.review_item/v1` | `src/review-item.ts`                 | `json/review-item.schema.json`                                                                      |
| Agent hook payloads | per vendor                | `src/hooks/`                         | `json/claude-code-hook.schema.json`, `json/codex-hook.schema.json`, `json/codex-notify.schema.json` |
| HTTP API            | `/v1`                     | `src/api.ts`, `scripts/artifacts.ts` | `openapi.yaml`                                                                                      |
| MCP tools           | `selfhost.mcp_tools/v1`   | `src/mcp.ts`                         | `mcp-tools.json`                                                                                    |

## Ledger event

One append-only record per run, prompt, tool call, approval, decision, cost, commit or PR, from
any agent. Required: `id` (UUIDv7, also the idempotency key), `schema`, `ts`, `source`, `kind`,
`actor`. Some kinds require more: `tool.called` and `tool.result` need `tool`,
`decision.recorded` and `policy.evaluated` need `decision`, `cost.recorded` needs `cost`.
Corrections are new events that point at the old one with `decision.replaces_event_id`.
Unknown fields are rejected; source-specific extras go in `data`. `cost.recorded` events put the
request type in `data.request_type`, one of `REQUEST_TYPES` (`src/request-type.ts`): `main`,
`subagent`, `compaction`, `title`, `status_line`, `background`, `retry`, `unknown`.

```ts
import { validateEvent, validateEventBatch } from "@selfhost/schema";

const result = validateEventBatch(body.events); // atomic: every error, with index and field
```

## selfhost.toml

`parseConfig(text)` parses TOML, applies defaults, validates, and returns either the resolved
config or errors with `field` and, when it can be found, `line`. `formatConfigError` prints
them as `selfhost.toml:7: rules[0].mode: Expected one of: observe, enforce, off`. Beyond the
schema it checks rule id uniqueness, regex syntax and that team overrides name real rules.
`[mcp]` and `[models]` hold allow lists (names or globs) with a mode; a call outside a
non-empty list is a block verdict under the built-in rule ids `mcp.allow` and `models.allow`,
which team overrides can name and which a rule may not reuse while that list is in use.
Decisions from a policy file carry `policy_commit` and `policy_hash` so each one can be traced
to the exact file.

```toml
version = 1

[[rules]]
id = "no-force-push"
match = { tool = "Bash", command = "git\\s+push\\s+.*--force" }
action = "block"
message = "Force pushes are blocked. Open a PR instead."
# mode defaults to "observe", agents to ["all"], irreversible to false

[mcp]
allow = ["github", "acme-*"]   # MCP servers, from mcp__<server>__<tool>

[models]
allow = ["claude-opus-*", "gpt-5*"]

[teams.platform.rules.no-force-push]
mode = "enforce"
```

## Redaction

`redactEvent(event, settings)` (`src/redact.ts`) returns the event as it may be stored: prompt
and response text under `data` dropped unless `settings.logPrompts`, and `maskSecrets` run on
`tool.input_summary`, `target.value`, `decision.reason` and every string under `data`, with each
path it touched added to `redacted`. `maskSecrets(text, patterns)` masks provider keys, tokens,
private keys, credential assignments, auth headers, credentials in URLs and emails as
`[redacted]`, then each `[[redaction]]` match as `[redacted:<name>]`. `redactionSettings(config)`
reads `[ledger] log_prompts` and `[[redaction]]` from a resolved `selfhost.toml`; the ledger
applies it on every write.

## Alerts and plans

`[alerts]` and `[plans]` tune the spend spike alarm and the plan limit forecast
([`packages/spend`](../spend/README.md#limit-forecast)). Both are optional; the defaults are
shown.

```toml
[alerts]
spike_factor = 10           # band is at least this multiple of the usual spend at that time of day
spike_floor_usd = 5         # spend under this in 15 minutes never alarms
spike_baseline_days = 14
forecast_warn_hours = 24
# runbook_url = "https://wiki.example.com/key-rotation"

[plans]                     # API-equivalent USD per window, overriding the built-in table per tier
as_of = "2026-11-05"
[plans.claude.max_5x]
session_usd = 60
weekly_usd = 450
[plans.overflow]            # suggested when a plan limit is about to run out
key = "team-overflow"       # gateway key alias
monthly_cap_usd = 500
```

## Review item

One entry in the review list: `kind`, `state`, `blocking`, `risk` (score 0 to 100 with reasons),
`owners`, links back to the ledger in `source_event_ids`, and the human `answer`, which is
required once `state` is `answered`.

## Hook payloads

What agents send to selfhost hooks, validated per `hook_event_name` with
`validateClaudeCodeHook`, `validateCodexHook` and `validateCodexNotify`. These schemas are
deliberately permissive: unknown fields and unknown event names are accepted, enumerated values
such as `permission_mode` are plain strings, and only the fields ingest needs are required.
Vendors ship new fields often and ingest must not break when they do.

- Claude Code: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse,
  Notification, Stop, SubagentStop, PreCompact, from the
  [hooks reference](https://code.claude.com/docs/en/hooks).
- Codex hooks (`hooks.json` or `[hooks]` in `config.toml`): SessionStart, SessionEnd,
  UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PostModelRequest, Stop,
  SubagentStart, SubagentStop, PreCompact, PostCompact, Interrupt, from the schemas Codex
  generates in `codex-rs/hooks/schema/generated`.
- Codex `notify`: the `agent-turn-complete` JSON passed as the last argument.

Open questions on Codex, to settle with real fixtures (M0.3):

- Codex hooks are new. The generated schemas mark `model`, `turn_id` and `permission_mode`
  required, but older builds may omit them, so they are optional here.
- `PostModelRequest` (token usage per model request) exists in the Codex source; it is unclear
  which released versions send it.
- `tool_input` is not always an object (shell calls have been seen as plain strings), so it is
  untyped for Codex.
- Whether `notify` keeps `thread-id` and `cwd` on all versions, and whether `notify` stays once
  hooks are stable (Codex marks it legacy).

## API and MCP

`openapi.yaml` (OpenAPI 3.1, bearer auth) covers `GET /v1/health`, `POST /v1/events` (atomic
batches of up to 1000), `GET /v1/events`, `GET /v1/review-items`,
`POST /v1/review-items/{id}/decision`, `GET` and `PUT /v1/policy`, and the team endpoints
`POST /v1/teams`, `POST /v1/join` (no bearer token: the invite code is the credential) and
`GET /v1/me`, whose bodies are in `src/team.ts`. It references the JSON Schema files for events,
review items and the config. `mcp-tools.json` lists `get_policy`, `get_budget`,
`list_review_items`, `search_events`, `search_decisions` and `record_decision` with
self-contained input and output schemas.

## Versioning

- Additive changes stay in v1: a new optional field, a new enum value, a new event kind, a new
  endpoint or tool.
- Anything that can reject data written under v1 is breaking: removing or renaming a field,
  making a field required, narrowing a type or pattern, removing an enum value. A breaking
  change needs a v2 schema (`selfhost.event/v2`, `version = 2`, `/v2`) and a migration from v1.
- `compat/v1/` holds frozen copies of v1 fixtures. They must validate forever; never edit or
  delete them. New fixtures go in `fixtures/<contract>/valid` and `invalid`, and each invalid
  fixture names the field it must fail on in `invalid/expected.json`.

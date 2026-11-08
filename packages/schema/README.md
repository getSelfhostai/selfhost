# @selfhost/schema

The contracts every selfhost module reads and writes. The TypeBox source in `src/` is the single
source of truth: TypeBox schemas are JSON Schema, TypeScript types derive from them with
`Static<>`, and `pnpm --filter @selfhost/schema export` writes the JSON Schema, OpenAPI and MCP
files below. A test fails when those files drift from the source.

| Contract            | Version tag               | Source                               | Generated                                                                                           |
| ------------------- | ------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Ledger event        | `selfhost.event/v1`       | `src/event.ts`                       | `json/event.schema.json`, `event-versions.json`                                                     |
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

## Event schema versions

`src/event-versions.ts` lists every event schema version, oldest first, with its release day
(`EVENT_SCHEMA_VERSIONS`); the last is the one every writer here produces. A version stays
accepted at ingest while it is current and for 12 months after the version that replaced it was
released, so every version released in the last 12 months is accepted. Older accepted events are
upgraded to the current version (each version has an `upgrade` to the next) before they are
validated and stored, so readers only see the current shape. `ledger.append`, which every ingest
path goes through (`POST /v1/events`, the OTLP receiver, webhooks, the CLI), rejects an unknown
or expired version with an error on `schema` that says when support ended and which version to
write. `GET /v1/health` lists the
accepted versions in `event_schemas`, and `event-versions.json` publishes the list as data.

```ts
import { eventSchemaSupport, ingestEvent } from "@selfhost/schema";

eventSchemaSupport("selfhost.event/v1"); // { status: "current", released: "2026-11-07" }
ingestEvent(body); // upgrade, then validateEvent; validateEvent alone takes the current version
```

Writers declare what they write: `EVENT_SCHEMAS` in `@selfhost/importers` and `@selfhost/sdk`,
`SOURCE_EVENT_SCHEMAS` in `@selfhost/ledger`. Their tests fail once a declared version is past its
window. To add a version, append it with its release day, give the previous version an `upgrade`,
freeze its events in `compat/<version>/event/`, and keep every older `compat/` folder: the compat
test ingests each accepted version's frozen events.

## selfhost.toml

`parseConfig(text)` parses TOML, applies defaults, validates, and returns either the resolved
config or errors with `field` and, when it can be found, `line`. `formatConfigError` prints
them as `selfhost.toml:7: rules[0].mode: Expected one of: observe, enforce, off`. Beyond the
schema it checks rule id uniqueness, regex syntax and that team overrides name real rules.
`[mcp]` and `[models]` hold allow lists (names or globs) with a mode; a call outside a
non-empty list is a block verdict under the built-in rule ids `mcp.allow` and `models.allow`,
which team overrides can name and which a rule may not reuse while that list is in use.
Decisions from a policy file carry `policy_commit` and `policy_hash` so each one can be traced
to the exact file. A rule's `message` says why; its optional `alternative` says what the agent
should do instead and `docs` links a page about it. Pre-tool hooks show all three on every block
and ask, with the rule's `selfhost.toml` line; team overrides can change `alternative` too.

`json/config.schema.json` is published at `CONFIG_SCHEMA_URL`,
`https://selfhost.ai/schema/selfhost.toml.v1.json`, which is also its `$id`. Every
`selfhost.toml` selfhost writes starts with `CONFIG_SCHEMA_DIRECTIVE`, the line
`#:schema https://selfhost.ai/schema/selfhost.toml.v1.json`, so TOML language servers that read
JSON Schema (Taplo, Even Better TOML) complete keys and flag errors in the editor. Taplo reads a
2020-12 schema as draft-07; a test checks the presets and fixtures mean the same both ways.

`parsePolicyTestFile(text)` parses the test files `selfhost policy test` runs: an optional
`config` path and `[[cases]]`, each a tool call (`tool`, default `Bash`, `command`, `path`, `url`,
`model`, `agent`, `team`) with the expected `decision` (`allow`, `ask`, `block`) and optionally
its `mode` (`enforce`, `observe`) and the exact `rules` that fire. Errors carry field and line,
like `parseConfig`.

```toml
version = 1

[[rules]]
id = "no-force-push"
match = { tool = "Bash", command = "git\\s+push\\s+.*--force" }
action = "block"
message = "Force pushes are blocked."
alternative = "Push to a new branch and open a pull request."   # what to do instead
docs = "https://wiki.example.com/rules/force-push"               # linked from every block
# mode defaults to "observe", agents to ["all"], irreversible to false

[mcp]
allow = ["github", "acme-*"]   # MCP servers, from mcp__<server>__<tool>

[models]
allow = ["claude-opus-*", "gpt-5*"]

[teams.platform.rules.no-force-push]
mode = "enforce"
```

`[packages]` configures the package guard
([`packages/package-guard`](../package-guard/README.md)), which checks every package an agent
installs against its registry. Its verdicts carry rule ids that start with `packages.`
(`PACKAGE_RULE_IDS`), which a rule may not use.

```toml
[packages]
mode = "observe"                # observe records verdicts, enforce applies them, off checks nothing
allow = ["@acme/*", "go:github.com/acme/**"]   # skip every check; npm:, pypi:, cargo:, go: limit an entry
deny = ["event-stream"]         # always blocked; deny wins over allow
min_age_days = 7                # flag versions younger than this; absent checks no age
blocked_registries = ["*.example.com", "registry.npmjs.cf"]   # hosts, URLs or globs
install_scripts = "ask"         # ask (default), block or allow
```

## Org, team and repo policy

On a team server a team's policy is layered: the org's `selfhost.toml` is a floor, then the
team's, then a repo's own rules (`src/layers.ts`). `checkLayer(orgText, text)` validates a team
or repo file on top of the floor: the file itself, then every field that would relax the org,
each error naming the org rule in `org_rule`. `composePolicy(layers)` merges the layers into the
file in use; one layer is used as it is, so a team with no org policy keeps its text and hash.

Relaxing the floor means any of:

| Where                                                                      | Relaxes the org when the team or repo file                                                                                                                            |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[[rules]]` with an org rule's id                                          | sets a lower mode (off < observe < enforce), ask where the org blocks, fewer agents, another match, or drops `irreversible`                                           |
| `[teams.<name>.rules.<id>]` for an org rule, `mcp.allow` or `models.allow` | sets a lower mode, ask where the org blocks, or fewer agents, measured against the org rule with the org's own override for that name                                 |
| `[mcp]`, `[models]` (when the org file has the section)                    | sets a lower mode, or an allow list that widens the org's: an entry no org entry covers (equal, or matched by an org glob), or an empty list, which allows everything |
| `[packages]` (when the org file has it)                                    | sets a lower mode, an allow entry the org's allow does not cover, a lower `min_age_days`, or a softer `install_scripts` (allow < ask < block)                         |
| `[guardrails]` (when the org file has it)                                  | sets a lower mode, or disables a guardrail the org keeps on                                                                                                           |
| `[[redaction]]`                                                            | reuses an org pattern's name with another pattern                                                                                                                     |
| `[ledger]`                                                                 | sets `log_prompts = true` where the org sets it to false                                                                                                              |

Org rules are inherited, so a team or repo cannot drop one; it can add rules with new ids and
tighten the org's. Lists that only add protection (`deny`, `blocked_registries`,
`prod_connections`, `prod_credentials`, redaction patterns, team `members`) are joined. Other
sections (`[review]`, `[alerts]`, `[plans]`, `[ledger] retention_days`) merge key by key with the
later layer winning. When the org raises its floor over stored team or repo files, the fields
that now relax it are reported as conflicts and the org's value is used. `[budget]` is not
inherited: the org's is the org total, a team's is its own.

`[budget]` sets `daily_usd`, `weekly_usd` (from Monday) and `monthly_usd`, UTC, in API-equivalent
USD. Spend is shown against it; nothing is charged back and nothing is stopped.

## Roles

Every person has exactly one role per team: owner (the first to join), admin or member.
`ROLE_PERMISSIONS` (`src/team.ts`) is the permission table the server checks on every request,
and `GET /v1/me` lists the caller's actions so the console offers only those:

| Action                                                                                  | owner | admin | member |
| --------------------------------------------------------------------------------------- | ----- | ----- | ------ |
| `read`: the team's events, review items, people, repos, policy, spend, budget, overview | yes   | yes   | yes    |
| `work`: write own events, answer and snooze review items, leave                         | yes   | yes   | yes    |
| `policy.write`: the team's selfhost.toml and its repos' rules                           | yes   | yes   | no     |
| `settings.write`: rename the team, map and unmap repos                                  | yes   | yes   | no     |
| `invites`: create and revoke invites (they add members)                                 | yes   | yes   | no     |
| `people`: add org people as members, revoke a member's or admin's tokens                | yes   | yes   | no     |
| `roles`: change roles, add admins and owners, revoke an owner's tokens                  | yes   | no    | no     |
| `org.overview`: the team shows in the person's cross-team view                          | yes   | yes   | no     |

A team always keeps an owner. The admin token can do everything; it alone creates orgs and
teams and sets the org floor. Anyone can revoke their own tokens.

## Guardrails

`[guardrails]` sets the built-in guardrails that pre-tool hooks apply on top of `[[rules]]`
(`GUARDRAIL_IDS`; what each matches is in
[`packages/policy`](../policy/README.md#guardrails)). They block by default; their ids are
reserved, so no rule may use one.

```toml
[guardrails]
mode = "enforce"                                    # enforce (default), observe or off
disable = ["guard.reset_hard"]                      # turn single guardrails off
prod_connections = ["*.prod.acme.internal", "PROD_DATABASE_URL"]   # DROP and TRUNCATE are blocked on these
prod_credentials = ["PROD_*", "prod", "~/.config/acme/prod-*.json"] # variables, profiles and files
```

`prod_connections` globs are matched, ignoring case, against the hosts, connection URLs, database
names and variable names in a command; `prod_credentials` globs against the variable names a
command reads or sets, `--profile`, `--context` and similar values, and (for globs starting with
`/` or `~/`) the paths of files a tool reads. Both are empty by default, which leaves
`guard.prod_sql` and `guard.prod_credentials` with nothing to match.

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

## Runtime

`[runtime]` says how each agent workspace is set up, run and cleaned up; the runtime plugin reads
it, and `selfhost migrate conductor` writes it from Conductor's settings. Every command runs in
the workspace folder with `RUNTIME_VARIABLES` set: `SELFHOST_WORKSPACE_NAME`,
`SELFHOST_WORKSPACE_PATH`, `SELFHOST_ROOT_PATH`, `SELFHOST_DEFAULT_BRANCH` and `SELFHOST_PORT`
(the first of 10 ports kept for the workspace). `[runtime.env]` values may refer to them as
`$NAME` or `${NAME}`; names that start with `SELFHOST_` are reserved, and at most one run command
is the default.

```toml
[runtime]
setup = """
pnpm install
cp "$SELFHOST_ROOT_PATH/.env.local" .env.local
"""
archive = "./script/workspace-archive.sh"   # before a workspace is archived
run_mode = "concurrent"                     # concurrent (default) or exclusive

[runtime.run.dev]
command = "pnpm dev --port $SELFHOST_PORT"
default = true

[runtime.run.api]
command = "pnpm api --port $((SELFHOST_PORT + 1))"
cwd = "services/api"                        # relative to the workspace

[runtime.env]
API_BASE_URL = "http://localhost:${SELFHOST_PORT}"
```

## Review item

One entry in the review list: `kind`, `state`, `blocking`, `risk` (score 0 to 100 with reasons),
`owners`, links back to the ledger in `source_event_ids`, and the human `answer`, which is
required once `state` is `answered`. Optional fields the review list engine
([`packages/review`](../review/README.md)) fills in: `why` (the signal and rule behind the item),
`deadline` (when a blocking approval times out to a deny), `actions` (approve, deny, answer,
snooze, open), `delivery` (`instant` or `digest`), `group` (`run:<id>` or `session:<id>`),
`route` (which routing step chose the owners) and `snoozed_until` with `snoozed_by`.

`[review]` in `selfhost.toml` routes and times items: `owners` (path glob to people),
`fallback` (people who get items nobody else owns), `approval_timeout_minutes` (default 30),
`exception_expiry_minutes` (default 30: how long an approved one-time exception stays usable),
`high_risk_paths` and `high_risk_threshold` (default 70, also the line for instant delivery).

`kind` `exception` is a tool call a rule blocked, which a person can allow once: approving it
lets that exact call through one time, within `exception_expiry_minutes`.

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
batches of up to 1000), `GET /v1/events`, `GET /v1/review-items`, `GET /v1/review-items/{id}`,
`POST /v1/review-items/{id}/decision` (409 with the current item when it is no longer open),
`POST /v1/review-items/{id}/snooze`, `GET` and `PUT /v1/policy`, and the team endpoints
`POST /v1/teams`, `POST /v1/join` (no bearer token: the invite code is the credential) and
`GET /v1/me`, whose bodies are in `src/team.ts`, plus roles and people
(`/v1/teams/{team}/people`, `.../role`, `PATCH /v1/teams/{team}`), orgs, repos and overviews
(`/v1/orgs`, `/v1/orgs/{org}/policy`, `/v1/orgs/{org}/overview`, `/v1/teams/{team}/repos`,
`/v1/teams/{team}/overview`, `/v1/budget`), whose bodies are in `src/org.ts`, and agent-written
code (`/v1/teams/{team}/provenance` and `.../provenance/modules`), whose bodies are in
`src/provenance.ts` with the `selfhost provenance --json` report and the `VendorLineStat` input. It references the JSON Schema files for events,
review items and the config. `mcp-tools.json` lists the tools of the selfhost MCP server
(`packages/mcp`) with self-contained input and output schemas and a `readOnlyHint`: the read
tools `get_policy`, `get_budget`, `list_review_items`, `search_events`, `search_decisions`,
`list_file_runs`, `list_active_on_file` and `get_answer`, and the writing tools `ask_human`,
`request_exception` and `record_decision`. List tools default to 10 items (`MCP_LIMIT_DEFAULT`)
and no answer goes over `MCP_RESPONSE_TOKEN_BUDGET` tokens.

## Versioning

- Additive changes stay in v1: a new optional field, a new enum value, a new event kind, a new
  endpoint or tool.
- Anything that can reject data written under v1 is breaking: removing or renaming a field,
  making a field required, narrowing a type or pattern, removing an enum value. A breaking
  change needs a v2 schema (`selfhost.event/v2`, `version = 2`, `/v2`) and a migration from v1.
- `compat/v1/` holds frozen copies of v1 fixtures. They must validate forever; never edit or
  delete them. New fixtures go in `fixtures/<contract>/valid` and `invalid`, and each invalid
  fixture names the field it must fail on in `invalid/expected.json`.

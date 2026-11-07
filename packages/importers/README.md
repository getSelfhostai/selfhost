# @selfhost/importers

Turns agent session logs on disk into `selfhost.event/v1` ledger events with `source: "local_log"`.
Today that is Claude Code and Codex. OpenTelemetry exports, hook payloads and vendor audit APIs come
later.

```ts
import { importAll, watchLogs } from "@selfhost/importers";

await importAll(ledger, {}); // the last 30 days, no setup
const watcher = watchLogs(ledger, {}, (n) => console.log(`${n} new events`));
await watcher.close();
```

| Function                           | What it does                                                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discoverLogFiles(opts)`           | Finds `~/.claude/projects/**/*.jsonl` (and `~/.config/claude`, or `CLAUDE_CONFIG_DIR`) and `~/.codex/sessions/**/*.jsonl` and `archived_sessions/` (or `CODEX_HOME`). |
| `parseLogFile(vendor, path, opts)` | Maps one file to events from `fromOffset` and returns `nextOffset`. Lines before the offset are read for context, so ids match a full read.                           |
| `importAll(writer, opts)`          | Reads every log touched since `since` (default 30 days ago) and appends the events in batches of up to 1000.                                                          |
| `watchLogs(writer, opts, onBatch)` | `importAll`, then tails the logs by polling (`pollIntervalMs`, default 1000). New lines and new files are written without a restart.                                  |

`writer` is anything with `append(events): Promise<{ accepted: string[]; duplicates: string[] }>`,
such as the ledger store. Nothing here opens a network connection; a test fails on any attempt.

## Events

| Kind               | From                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.started`  | The first line of a session.                                                                                                                             |
| `session.ended`    | The last line, once the session has been quiet for 30 minutes or logged a SessionEnd hook.                                                               |
| `cost.recorded`    | Each API response (Claude Code) or `token_count` delta (Codex): model, input, output, cache read and cache write tokens, and USD with `estimated: true`. |
| `tool.called`      | Each tool call: the tool name and a short `input_summary`, plus a `target` for commands, files and URLs.                                                 |
| `commit.created`   | A `git commit` call whose output shows `[branch sha]`, with `links.commit_sha`.                                                                          |
| `prompt.submitted` | Only with `logPrompts: true`. The text goes in `data.prompt`, masked and capped at 2000 characters.                                                      |
| `alert.raised`     | A plan usage limit hit, with `data.alert: "usage_limit"` and, when the log says, `window` (`session` or `weekly`) and `resets_at`. See below.            |

Summaries keep the first line of a command or a file path relative to the session's cwd, masked
for secret-shaped values and email addresses (`maskSecrets` from `@selfhost/schema`, the same
masker the ledger runs on every write), and cut at 120 characters. File contents, patch
bodies, tool output and, unless `logPrompts` is on, prompt text are never stored. Any field that
was masked is listed in `redacted`.

## Usage limit hits

The limit forecast in [`packages/spend`](../spend/README.md#limit-forecast) calibrates each
person's limits from the usage that led up to a hit. Only the hit is read: no plan, account or
login details.

- Claude Code: the synthetic response line it writes when a request is refused
  (`isApiErrorMessage`, model `<synthetic>`), when its text names a usage limit ("5-hour limit
  reached", "Weekly limit reached", "You've hit your limit", or the older "... usage limit
  reached|<reset epoch>"). An API key's 429 says none of these and is not counted. The text
  formats come from what Claude Code shows on screen and still need checking against a captured
  log.
- Codex: the `rate_limits` snapshot on `token_count` lines, when `rate_limit_reached_type` is set
  or the primary (5-hour) or secondary (weekly) window reaches 100%. The window and its
  `resets_at` come from the snapshot; `plan_type` is not kept. One event per window reset, however
  many lines repeat it.

## Request types

Each `cost.recorded` event gets `data.request_type` (see
[`packages/spend`](../spend/README.md#request-types)) and, when the log names one,
`data.request_source`:

- Claude Code: the `querySource` of the `api-request` line the response's `requestRef` points at
  (`repl_main_thread`, `agent:builtin:Explore`, ...). Without it, `isSidechain` means
  `subagent`, else `main`. The first response in a thread after a `system` `api_error` line or a
  synthetic `isApiErrorMessage` line is a `retry`, unless a new prompt comes first. Background
  requests such as `agent_summary` are not in transcripts at all.
- Codex: `session_meta` `source` and `thread_source` give the rollout's type (`main`, `subagent`,
  `compaction` for compact subagents, `background` for guardian reviews, memory consolidation and
  feature threads), and compaction request records are `compaction`. Rollouts do not persist API
  errors, so Codex retries are not visible here.

## Ids and re-imports

Each event id is a UUIDv7 whose time bits hold the event time and whose other bits come from a
SHA-256 of the vendor, the session and what identifies the line (the Claude message and request
ids, a tool call id, a Codex token count). Importing the same files again gives the same ids, so
the ledger stores nothing new. Ids that the vendor makes unique across sessions are not scoped to
the session, so a response Claude Code copies into a resumed session's transcript, or history a
forked Codex rollout replays, is counted once.

## Pricing

Token parsing and cost estimates follow [ccusage](https://github.com/ccusage/ccusage) by
ryoppippi (MIT): the same dedupe of multi-line responses, cache write pricing (1-hour writes at
twice the input rate), Codex `token_count` deltas and long-context tiers, and the same price
tables. ccusage 20 ships as a native binary with no JavaScript loaders, so the parts we need are
ported from its v20.0.48 Rust source into `src/vendor/ccusage/`, which keeps its MIT license.

Prices come from the snapshot ccusage v20.0.48 embeds, bundled in
`src/vendor/ccusage/pricing-snapshot.ts`, so estimates work offline. On the fixture logs, tokens
and cost per day and model match `ccusage claude daily`, `ccusage codex daily` and `ccusage daily`
(see `fixtures/expected/`). To refresh the snapshot, take LiteLLM's
`model_prices_and_context_window.json` at the commit ccusage pins in `flake.lock` and ccusage's
`models-dev-pricing.json`, then run:

```sh
pnpm --filter @selfhost/importers gen:pricing <litellm.json> <models-dev-pricing.json>
pnpm biome format --write packages/importers/src/vendor/ccusage/pricing-snapshot.ts
```

Not ported yet: Codex subagent replay markers (verbatim replays still collapse by id), the
service tier default from Codex `config.toml`, `.jsonl.zst` rollouts, `CCUSAGE_MODEL_ALIASES` and
live price refresh.

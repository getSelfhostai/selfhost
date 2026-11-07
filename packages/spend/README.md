# @selfhost/spend

Spend grouped by request type, agent, model and person, per UTC day, and a detector that flags a
request type the day its share of spend crosses a threshold. Status pings, retry loops and
background requests show up the day they start, not at the end of the month.

```ts
import { detectWaste, groupSpend, oneSourcePerSession } from "@selfhost/spend";

const events = oneSourcePerSession(costEvents); // cost.recorded events from the ledger
const series = groupSpend(events, { by: ["request_type", "model"], interval: "day" });
const flags = detectWaste(series, { shareThreshold: 0.1, minUsd: 0 });
```

Everything here is pure: no I/O, and the same events give the same result in the same order.
`selfhost spend` in `apps/cli` reads the ledger and prints the result.

## Request types

Every `cost.recorded` event carries `data.request_type`, one of the values below, and
`data.request_source` with the vendor's own label when it has one (for example `agent_summary`).
The list lives in `@selfhost/schema` (`REQUEST_TYPES`).

| Type          | What it is                                                                   |
| ------------- | ---------------------------------------------------------------------------- |
| `main`        | The agent's main conversation, working on what the person asked.             |
| `subagent`    | A subagent or spawned thread doing part of the work.                         |
| `compaction`  | Summarizing the conversation to free context.                                |
| `title`       | Naming the session.                                                          |
| `status_line` | Short progress labels for background agents.                                 |
| `background`  | Other requests the agent makes on its own: suggestions, memory, classifiers. |
| `retry`       | A request sent again after the previous attempt failed.                      |
| `unknown`     | The source does not say.                                                     |

`main` and `subagent` are the work; the detector watches the rest except `unknown`.

### Where each type comes from

- **Claude Code OpenTelemetry**: `query_source` on `claude_code.api_request`, with `agent.name`
  and `agent_id` ([monitoring docs](https://code.claude.com/docs/en/monitoring-usage)).
  `repl_main_thread*`, `sdk` and `side_question` are main; `agent:*`, `hook_agent`,
  `verification_agent`, or any unlisted source with `agent.name` or `agent_id`, are subagent;
  `compact` is compaction; `generate_session_title`, `teleport_generate_title` and
  `rename_generate_name` are title; `agent_summary` (the background agent progress label) is
  status_line; any other source is background (the docs group requests into main, subagent and
  auxiliary). Without `query_source` (older versions) the request is unknown.
- **Claude Code OpenTelemetry retries**: an `api_request` after a `claude_code.api_error` with
  the same `session.id`, `prompt.id` and `query_source`. Claude Code logs `api_error` only once
  it gives up on a request, then re-issues it
  ([retry exhaustion](https://code.claude.com/docs/en/monitoring-usage#detect-retry-exhaustion)).
- **Claude Code local logs**: `querySource` on the transcript's `api-request` line that the
  assistant line's `requestRef` names, mapped as above. Without one, `isSidechain` on the
  assistant line means subagent, else main. The transcript format is internal and
  undocumented; these fields come from third-party transcript references (the
  [clawdipedia transcript schema](https://clawdipedia.cc/reference/transcript-format), from
  2.1.305) and still need checking against a captured log.
- **Claude Code local log retries**: a `system` line with `subtype: "api_error"` (`retryAttempt`,
  `retryInMs`), or an assistant line with `isApiErrorMessage`, marks its thread (the main thread
  or one `agentId`). The thread's next response is a retry, unless a new prompt comes first.
- **Codex local logs**: `session_meta.payload.source` and `thread_source` (`SessionSource` and
  `ThreadSource` in
  [codex-rs/protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)).
  `source: { subagent: "compact" }` is compaction; `thread_source: "subagent"` or
  `source: { subagent: "review" | { thread_spawn } }` is subagent; `thread_source`
  `guardian_review` (automatic approval reviews), `memory_consolidation` or a feature name,
  `source: { internal }` and `source: { subagent: "memory_consolidation" }` are background;
  anything else is main. A `token_usage_record` that a `compacted` line names by
  `compaction_response_id` is compaction in any thread.
- **Codex OpenTelemetry**: tokens come from `codex.sse_event` with `event.kind:
  response.completed`; a response after a `codex.api_request` whose `attempt` (counted from 0) is
  1 or more is a retry. Codex log events name no request kind, so the rest is unknown
  ([Codex observability](https://developers.openai.com/codex/config-advanced),
  [session_telemetry.rs](https://github.com/openai/codex/blob/main/codex-rs/otel/src/events/session_telemetry.rs)).
- **Codex hooks**: `PostModelRequest` with `agent_id` is subagent, else main.
- **LiteLLM gateway and the vendor audit feed**: nothing says, so unknown.

Claude Code does not write background requests to its transcripts: `agent_summary`, `compact`,
`generate_session_title`, `prompt_suggestion`, `auto_mode` and others leave no assistant line
([anthropics/claude-code#104358](https://github.com/anthropics/claude-code/issues/104358)). Local
logs see main, subagent and retry spend; OpenTelemetry sees all of it. Codex writes its
compaction, subagent, review and memory threads to disk, so its local logs see those too.

## groupSpend

`groupSpend(events, { by, interval: "day", from?, to? })` adds up `cost.recorded` events per UTC
day and group. `by` is any of `request_type`, `agent` (vendor), `model` and `person` (actor id when
the actor is a person). Missing values are `unknown`. Each row has `requests`, the four token
counts, `tokens` (their sum) and `usd`. `days` lists every day in the range, including days with
no spend; `from` and `to` widen or cut the range. `totalSpend(series)` adds the days up per group,
with each group's share of the total.

## detectWaste

`detectWaste(series, opts)` needs a series grouped by `request_type` (other dimensions are added
up). It flags a request type on the first day its share of that day's spend reaches
`shareThreshold` (default `0.1`) and it costs at least `minUsd` (default `0`), after a day with
spend where it did not, or on the first day with spend in the series. It is flagged again only
after dropping back below. Days with no spend at all are skipped. `types` picks the request types
to watch (default `WASTE_REQUEST_TYPES`: compaction, title, status_line, background, retry).

Each flag has `day`, `request_type`, `usd`, `day_usd`, `share`, `previous_share` (the previous day
with spend, or `null`) and `trend`: the `trendDays` days before (default 7) that the series covers,
oldest first, with their USD and share.

## One source per session

A session can reach the ledger from several sources at once, for example OpenTelemetry and the
local logs. `oneSourcePerSession(events)` keeps the cost events of one source per agent and
session, in the order `otel`, `local_log`, `hook`, `gateway`, `vendor_api`, so nothing is counted
twice. OpenTelemetry comes first because it is the only source that sees every request.

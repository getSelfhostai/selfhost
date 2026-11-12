# @selfhost/spend

Spend grouped by request type, agent, model and person, per UTC day, and a detector that flags a
request type the day its share of spend crosses a threshold. Status pings, retry loops and
background requests show up the day they start, not at the end of the month. Also: when each
person's Claude and Codex plan limits run out this week ([limit forecast](#limit-forecast)), and
spend that jumps out of its usual band as a possible stolen key ([spike alarm](#spike-alarm)).

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

## Where spend comes from: one source per request, then per session

A request can reach the ledger from several sources at once. `oneSourcePerSession(events)`
counts each once, by two rules applied in order:

1. **A request that went through the model gateway counts once, as the gateway's event.** The
   gateway logs it as billed (`source: gateway`), and the agent's session log, OpenTelemetry or
   a hook logs it again on the laptop. The gateway's request log names no session, so its event
   takes the session (and repo and request type) of its agent-side copy. No shared id joins the
   two: Bifrost and LiteLLM log their own request ids, not the vendor's message id. They are
   joined on the request itself: the person (when both name one), prompt tokens (uncached input,
   cache reads and cache writes together) and output tokens, the n-th request of a size on one
   side with the n-th of that size on the other, no more than `GATEWAY_PAIR_WINDOW_MS` (10
   minutes) apart. Requests under `GATEWAY_PAIR_MIN_TOKENS` (100) are never joined, as sizes
   that small repeat.
2. **Everything else counts one source per session.** A session (agent and session id) reported
   by more than one source keeps the cost events of one, in the order `otel`, `local_log`,
   `hook`, `gateway`, `vendor_api`. OpenTelemetry comes first because it is the only source that
   sees every request. Sessions that did not go through the gateway keep their session log.
3. **A vendor-reported daily total counts once per person-day.** The vendor usage importers
   (`@selfhost/importers`, run by the server) write a person's usage of a model per UTC day,
   with no session and `data.rollup: "day"` (`isVendorRollup`). It counts only when no other
   source recorded spend for the same person, agent and day, so a day a laptop's logs, a hook or
   the gateway saw is counted from them, request by request.

`pairGatewayCosts(events)` returns the pairs of rule 1. `countedCostsSql(input, prefix)` is rule 1
as SQL CTEs over a table of cost rows, for the server's usage and ROI queries; it pairs the same
events, so `GET /v1/usage`, the team overview, `GET /v1/budget`, ROI and `selfhost spend` agree.
`vendorRollupCountsSql(columns)` is rule 3 as a SQL condition on a cost row.

## Seat or API key

`breakEven(spend, days)` takes spend per person and agent over a range of `days` and answers, for
each agent with seat tiers (`SEAT_TIERS`: Claude Code Pro, Max 5x and Max 20x, Codex Plus and Pro,
list prices as of `SEAT_PRICES_AS_OF`), whether a seat or an API key is cheaper. The spend is
scaled to 30 days; a tier costs its price plus API rates for use past its approximate monthly
limit (the weekly limits of `PLAN_LIMITS` times 30/7). The cheapest choice wins, the API key on a
tie. Rows come heaviest use first, with the tier, the monthly saving and `break_even_usd`, the
cheapest seat's price. The server serves it at `GET /v1/usage/break-even`.

## Prompt cache hit rate

`cacheByGroup(events, by)`, `cacheStats(events)` and `sessionCaches(events)` turn the token
counts `cost.recorded` events already carry into a hit rate: cache reads over cache reads plus
uncached input plus cache writes. A session (agent and session id) that reported no cache read
and no cache write at all is unknown, `hit_rate: null`, and left out of every group's rate: some
agents' logs have no cache fields, and their importers write 0 for both, which would read as
"every request missed". A session that wrote the cache and never read it is a known 0.

`sessionCaches` adds each session's spend, model switches and the hit rate of its last 10
requests (`recent_hit_rate`), so a collapse shows while the session runs. `cacheDrops` picks
sessions past `minRequests` whose recent rate is under the floor (`[alerts] cache_min_requests`
and `cache_hit_floor`), and `cacheAlert` turns one into an `alert.raised` event with
`data.alert: "cache_hit_low"`, one per session (its id comes from the session alone). `cacheTips`
picks sessions that cost at least `[alerts] cache_tip_usd` at an overall rate under the floor,
and `cacheTipText` says it in one line with the usual causes: a value that changes early in the
prompt (such as a timestamp), tool lists that reorder, or a model switch.

## Limit forecast

`forecastLimits(events, person, { now, tiers, limits, warnHours, overflow })` says, for each of a
person's plans (`claude` from Claude Code usage, `codex` from Codex usage), when the plan's limit
runs out this week. It reads only `cost.recorded` events and the `usage_limit` alerts the
importers write; it never reads vendor logins or credentials. Gateway spend is billed to an API
key, not the subscription, so it does not count.

Usage is in API-equivalent USD: the estimated cost the ledger records for the same tokens.
Vendors publish limits as multiples and hours, not numbers, so a limit is resolved per window,
and the output names which basis it used (`basis`, `basis_label`):

1. `calibrated`: the person's own limit hits in the last 28 days. The importers turn the hit
   Claude Code and Codex log (see [`packages/importers`](../importers/README.md#events)) into an
   `alert.raised` event with `data.alert: "usage_limit"`; the limit is the median, over the
   latest three hits, of the usage in that window up to the hit. A hit that does not name its
   window counts as the 5-hour window.
2. `table`: the tier the person set (`selfhost spend plan claude=max_5x`), from `[plans]` in
   selfhost.toml, else the built-in table below.
3. `none`: no hit and no tier, so no forecast for that window.

The built-in table (`PLAN_LIMITS`, as of `PLAN_LIMITS_AS_OF`, 2026-11-01) holds rough starting
points, to be replaced by calibration or by `[plans]`. Check them against real accounts before
relying on them.

| Plan   | Tier       | 5-hour | Weekly |
| ------ | ---------- | -----: | -----: |
| claude | `pro`      |    $10 |    $75 |
| claude | `max_5x`   |    $50 |   $375 |
| claude | `max_20x`  |   $200 |  $1500 |
| codex  | `plus`     |     $8 |    $50 |
| codex  | `business` |     $8 |    $50 |
| codex  | `pro`      |    $60 |   $400 |

Each plan has two windows:

- **5-hour session window**: starts at the hour of the first request after the previous one
  ended, as ccusage models it. The projection takes the burn rate over the last hour (at least
  half an hour, so a burst in the first minutes is spread out) to the end of the window.
  `run_out` is null when the window resets first.
- **Weekly window**: Monday 00:00 UTC to Monday, unless a weekly limit hit gave a reset time, in
  which case weeks start there. The projection replays the same hours of the week from the last
  7 days over the rest of this week, hour by hour. `run_out` is null when the week ends first
  ("not this week").

A window is `warn` when its run-out is within `warnHours` (default 24, `[alerts]
forecast_warn_hours`), `reached` when usage is at the limit, `idle` when no session window is
running, and `unknown` without a limit. A plan that warns or has reached a limit gets a
`suggestion`: overflow to the team's API key (`[plans.overflow]`) while its spend this month is
under its cap, else move background work to the quietest 4 hours of the person's day.

## Spike alarm

`detectSpikes(events, { now, since, factor, floorUsd, baselineDays, madK })` adds up spend per
15-minute slot for each series: one key (`data.key_alias` from the gateway, or a provider key
actor), person, agent and runtime (`data.runtime`). Each slot from `since` to `now` is compared
with that series' own baseline at the same time of day:

- For each of the trailing `baselineDays` (default 14, `[alerts] spike_baseline_days`) on which
  the series had any spend, take the highest slot within 30 minutes of the same time of day.
- `band = max(factor x median, median + madK x 1.4826 x MAD)`, with `factor` from `[alerts]
  spike_factor` (default 10) and `madK` 6.
- A slot above the band alarms, unless it is under `floorUsd` (default 5, `[alerts]
  spike_floor_usd`); spend under the floor never alarms. A series with fewer than 3 days of
  spend has no baseline yet, so any slot at or above the floor alarms (`reason: no_baseline`).

A slot's baseline only looks back, so evaluating a week at once gives the same alarms as
evaluating each slot as it ends. Each alarm lists the actions that apply: `rotate_key` always,
`pause_runtime` when the spend ran on a runtime, `disable_virtual_key` when it went through a
gateway key. On a synthetic three-person team, a normal week replayed slot by slot raises
nothing even with no floor, and one person's normal week spent in one hour alarms in its first
15 minutes (`test/spike.test.ts`, `test/backtest.test.ts`).

## Key rotation runbook

What a spend spike alarm links to (override with `[alerts] runbook_url`). Treat it as a
possible stolen key until shown otherwise.

1. Find the series in the alarm: key, person, agent, runtime. `selfhost spend --since 1d --by
   person,agent` shows what else it spent.
2. Gateway virtual key: disable it in the gateway (LiteLLM: `POST /key/block`), then issue a new
   one to its owner.
3. Provider API key: create a new key in the Anthropic or OpenAI console, roll it out, then
   revoke the old one and check the provider's usage page for spend you do not recognise.
4. A person's own login: sign out of the agent on every machine (`/logout` in Claude Code,
   `codex logout`), sign in again, and review the account's active sessions.
5. A runtime: pause it and its scheduled runs until the owner confirms the work.
6. Tell the owner and the budget owner what was rotated. The alarm stays in the ledger as an
   `alert.raised` event with `data.alert: "spend_spike"`.

## Sandbox waste

`sandboxWaste(events, { now })` reads the `sandbox.started` and `sandbox.stopped` events
background runs write (see [`packages/runtime`](../runtime/README.md)), the runs' `cost.recorded`
events and the events that end a run (`session.ended`, or `alert.raised` `run_failed` or
`run_stuck`). It reports:

- per runtime, for 7 and 30 days: sandbox cost, the part paid while idle (billed seconds with no
  command running) and its share, prorated when a sandbox straddles the window;
- a cheaper billing model when more than half of a reserved-billing runtime's cost was idle:
  providers that bill active CPU only, or pausing while the agent waits on the model, with the
  saving scaled to 30 days;
- sandboxes still running `leftover_minutes` (15) after their run ended, with their cost so far
  and the part after the run;
- each run of the last 7 days: billed, busy and idle seconds and sandbox cost next to its model
  cost.

`sandboxSpendIn(spans, from, to, now)` is the sandbox spend inside a range, each sandbox's cost
split by how much of its life falls inside; the daily runtime cap reads it.

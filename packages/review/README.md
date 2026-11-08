# @selfhost/review

The review list: one ranked, routed list of everything in the ledger that needs a person. It is
headless. The HTTP API, the CLI, GitHub, Slack, Telegram, MCP and the console all read and act on
the same rows, so an answer given on one surface shows on every other surface's next read.

```ts
import { openLedger } from "@selfhost/ledger";
import { openReviewList, refreshReviewList } from "@selfhost/review";

const ledger = await openLedger({ url: process.env.DATABASE_URL });
const list = openReviewList(ledger, { config }); // config: a resolved selfhost.toml
await refreshReviewList(ledger, list); // { created, updated }
const { items, next_cursor } = await list.list({ state: "open", owner: "alice@example.com" });
await list.decide(items[0].id, {
  verdict: "approve",
  by: "alice@example.com",
  reason: "Read-only",
});
await list.snooze(items[1].id, { by: "alice@example.com", until: "2026-11-10T14:00:00Z" });
```

`openReviewList(ledger, { config?, now?, team? })` returns a `ReviewList`: `list`, `get`,
`pullRequest`, `decide` and `snooze`. With `team` it reads and acts on that team's items only, as a
person token does on the server. `pullRequest(url)` is the `pr` item of an agent pull request (the
open one, else the one opened last), which the GitHub delivery asks for its owner. `decide` throws
`AlreadyAnsweredError` (with the current `item`) when the item is not open,
`ReviewItemNotFoundError` for an unknown id or another team's item, and `ReviewInputError` for a bad
verdict, person or time; in each case nothing is written.

## Store

Items live in `review_items` (ledger migration `0004_review_items.sql`), in the ledger's own
database. Unlike events, items change. History stays append-only because every change of state
is in the ledger too:

| Change                           | Ledger record                                                         |
| -------------------------------- | --------------------------------------------------------------------- |
| Opened, or a signal added        | The signal events, listed in `source_event_ids`                       |
| Answered (`decide`)              | One `decision.recorded` event written with `recordDecision`           |
| Answered on another path         | The `decision.recorded` event that names the item or its pull request |
| Timed out (`expired`)            | One `decision.recorded` deny by `selfhost`, `surface: "timeout"`      |
| Closed by activity (`dismissed`) | The event that closed it, added to `source_event_ids`                 |

A snooze is not a change of state (the item stays open), so it is kept on the item only.

Each row holds the whole `selfhost.review_item/v1` item plus a dedupe key, the team scope
(`events.team` of its signals), the files and tool its signals named, and a version. Every
write checks the version, and an answer first claims the row for up to a minute, so two
surfaces answering at once give one decision and one `AlreadyAnsweredError`.

## Signals

`refreshReviewList(ledger, list, { config?, now? })` reads the events added since the last
refresh (by `ingested_at`, re-reading ten minutes for late commits; `review_signals` records each
event read so none is applied twice), then closes waits, files the weekly report and applies
timeouts. Refreshes take turns under an advisory lock, so several servers can run them.
Approvals, questions and alerts older than seven days open nothing.

| Kind             | Signal                                                                                           | Dedupe key (while open)         | Blocking | Risk     |
| ---------------- | ------------------------------------------------------------------------------------------------ | ------------------------------- | -------- | -------- |
| `pr`             | `pr.opened` for an agent PR (`agent` set, not `data.unattributed`)                               | PR URL                          | no       | input    |
| `approval`       | `approval.requested`: Claude Code permission prompt, Codex `PermissionRequest`                   | session                         | yes      | 50       |
| `approval`       | `policy.evaluated`, enforce, verdict `ask`                                                       | session (live) or the tool call | if live  | 50 or 90 |
| `question`       | `approval.requested` with `notification_type` `idle_prompt` or `elicitation_dialog`              | session                         | yes      | 30       |
| `blocked_action` | `policy.evaluated`, enforce, verdict `block`                                                     | rule, session and call          | no       | 40 or 70 |
| `exception`      | `policy.evaluated` block from a pre-tool hook with `data.exception` (a one-time exception asked) | the call's fingerprint          | if live  | 50 or 80 |
| `stuck_run`      | `alert.raised`: `run_failed`, `run_stuck` (60), `api_error`, `model_request_failed` (30)         | run, else session               | no       | 30 or 60 |
| `budget`         | `alert.raised`: `limit_forecast` (50), `usage_limit` (60), `budget`, `budget_exceeded`           | alert, person, plan and window  | no       | 50 or 60 |
| `spend_spike`    | `alert.raised`: `spend_spike`                                                                    | the alarm's series              | no       | 90       |
| `quality`        | `alert.raised`: `quality`, `quality_alarm`                                                       | metric, else model              | no       | 60       |
| `policy_report`  | Observe-mode `policy.evaluated` block and ask hits of the last full week (Monday to Monday UTC)  | the week                        | no       | 10       |

- A PR's risk score is an input: `data.risk` (`{ score, reasons }`) or `data.risk_score` on
  `pr.opened`. The scoring itself (`ee/risk`) is not imported here. Without one the score is 50.
- Where two scores are given, the higher one is for a rule with `irreversible = true`. A file
  under `[review] high_risk_paths` raises any item to `[review] high_risk_threshold`.
- A verdict counts as live when it was given within a minute of the call and not by the observe
  pass (`selfhost policy observe`, source `cli`), which judges calls after the fact: no agent
  waits on those, so their approvals do not block or time out, and their blocks read "Rule
  <id> blocks" instead of "Blocked".
- The same signal again (a repeated notification, the same rule blocking the same call) adds its
  event to the open item instead of opening another. A signal for a key whose item is closed opens
  a new item.
- An `exception` item takes the id the hook named in `data.exception.id` (the agent and the
  person were told it before the item existed), and `why` adds the rule's alternative. A retry of
  the same call (same fingerprint) names a new id, so it dismisses the open item and opens one
  under the new id. Approving it lets that exact call through once: the CLI turns the answer into
  a grant the hook reads (see [the CLI](../../apps/cli/README.md#one-time-exceptions)). It times
  out like a blocking approval.
- Items from one run share `group: "run:<run_id>"`, else one session `group: "session:<id>"`.
- `pr.merged` and `pr.closed` dismiss the PR's item. A `decision.recorded` event from a person
  with `item_id` (or, for a PR, its `pr_url`) answers the open item; a later decision that
  replaces the answer updates it. Decisions from a person token answer only that team's items.
- A wait ends when the session moves on before the deadline: a prompt the person typed
  (`prompt.submitted`, not the Codex notify record), the session ending, or for an approval the
  tool it waited on returning a result (any tool when the signal does not name one). The item is
  dismissed with that event added.
- The weekly report is built by `buildPolicyReport` (also behind `selfhost policy report`), one
  per team scope, and only for a week in which an observed rule fired.

## Routing

`routeItem(config, { paths, person?, team? })` picks the owners from `selfhost.toml`, in three
steps; the first that names anyone wins, and the item records which in `route`:

1. Owner: the people of every `[review.owners]` glob that matches one of the item's files, in file
   order; else the person whose session raised it (the signal's person actor or `data.owner`, else
   the first person actor in that session).
2. Team: the members of the item's team (`team` on the event) in `[teams.<name>]`.
3. Fallback: `[review] fallback`.

When none names anyone, `owners` is empty and `route.step` is `none`. Items built from a team's
events use that team's stored `selfhost.toml` on a team server, else the list's config.

## Delivery and timeout

- `delivery` is `instant` when an agent is blocked (`blocking`) or the risk score is at or above
  `[review] high_risk_threshold` (70), else `digest`. Push surfaces send instant items now and the
  rest in their digest.
- A blocking approval gets `deadline`: its first signal plus `[review] approval_timeout_minutes`
  (30). A refresh after the deadline denies it: one `decision.recorded` event by `selfhost` (a
  system actor) with `surface: "timeout"`, timed at the deadline, and the item becomes `expired`
  with that answer. The event id comes from the item and the deadline, so a second refresh or a
  second server writes nothing new.

## Ranking

The list order is the same on every surface, for every state, and depends only on the items and
the time of the read:

1. Items not snoozed, then items whose `snoozed_until` is still ahead.
2. Items an agent is blocked on (`blocking: true`) first.
3. Higher `risk.score` first.
4. Older `created_at` first (the time of the item's first signal).
5. Lower `id` first, so no two items tie.

`compareItems(a, b, now)` is that order in TypeScript; the store sorts the same way in SQL and
pages with a cursor over the same keys.

## Tests

`pnpm --filter @selfhost/review test` runs on in-memory PGlite, and also on Postgres when
`DATABASE_URL` is set (CI provides Postgres 16), each run in a schema of its own.

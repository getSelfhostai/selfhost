# @selfhost/mcp

The MCP server agents use to read the team's rules, budget and review list, see who else is
working on a file, find past human decisions, and ask a person. The tools are the contract in
[`@selfhost/schema/mcp-tools.json`](../schema/README.md#api-and-mcp) (`selfhost.mcp_tools/v1`);
tools/list serves that file as it is. They run over a small data interface (`McpData`), so the
same tools answer on a laptop and on the team server, through the official
`@modelcontextprotocol/sdk` on stdio and Streamable HTTP.

## Tools

| Tool                  | Writes | What it answers                                                                                                                                                                                                |
| --------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_policy`          | no     | The rules that apply to you in this repo, after team overrides. `text` and `config.rules` only with `full: true`.                                                                                              |
| `get_budget`          | no     | Spend, the budget and `remaining_usd` for the day, week or month, and `budgets`: every budget that applies to the caller (person, team, org), gateway-enforced or alert-only, and which one cuts them off now. |
| `list_review_items`   | no     | Your pending items: open items you own or your own sessions raised (`mine: false` for the team's). Briefs and all but 5 source event ids only with `full: true`.                                               |
| `search_events`       | no     | The ledger by person, agent, model, session, kind and time.                                                                                                                                                    |
| `search_decisions`    | no     | Past human decisions and rule verdicts by path, topic, rule or person.                                                                                                                                         |
| `list_file_runs`      | no     | Past runs that touched a file or folder: who, which agent, when, which tools.                                                                                                                                  |
| `list_active_on_file` | no     | Sessions with calls on a file or folder in the last `within_minutes` (default 120), yours marked `you`.                                                                                                        |
| `ask_human`           | yes    | Opens a question on the review list and returns its `item_id` at once.                                                                                                                                         |
| `request_exception`   | yes    | Adds the agent's reason to the exception item a block named, and returns its `item_id`.                                                                                                                        |
| `get_answer`          | no     | The item's state and, once answered, the verdict, who and why; for an approved exception made on this machine, the one-time grant.                                                                             |
| `record_decision`     | yes    | The person's own decision on an item they asked the agent to answer, such as a pull request. Items an agent waits on, proposals to add to the team's context, and budget and alert items are refused.          |

List tools return 10 items by default (`MCP_LIMIT_DEFAULT`, at most 50). No answer goes over
`MCP_RESPONSE_TOKEN_BUDGET` (6,000) tokens: a page that would comes back shorter, with
`next_cursor` to read on. `test/tools.test.ts` fails if a default answer on a busy ledger goes
over.

A failure the agent can act on comes back as a tool error (`isError`) whose text is an
`ApiError`: `forbidden` for a team, repo or item outside the person's permissions (with no
data), `not_found`, `invalid_request`, `not_open`, or `unavailable` when the ledger is held.

## Waiting for a person

`ask_human` and `request_exception` never block: they create or update the review item and
return its `item_id` with `state: "open"` and a `next` sentence. The agent then calls
`get_answer` with `wait_seconds` (up to 55, under the 60 second tool timeouts agents use),
which polls every 2 seconds and returns as soon as a person answers, or `open` when the wait
runs out, and the agent calls again. A person answers in `selfhost inbox`, with `selfhost decide
<id> answer --reason ...`, through `POST /v1/review-items/{id}/decision` or the console. The
answer goes into the decision log, so `search_decisions` finds it the next time.

An exception request reuses the one-time exception flow of the pre-tool hook: when the hook
blocks a call it writes a request and names its id in the block message; `request_exception`
takes that id and the agent's reason, which the person reads in the item's brief. Approving it
writes the same signed one-time grant as `selfhost inbox approve` does, on the machine that made
the call, and `get_answer` returns it (`grant.expires_at`) once it is there. The agent makes the
identical call again and it is allowed once.

## Where it runs

- **Solo**: `selfhost mcp` in `apps/cli` serves the tools on stdio from this machine's ledger
  and the selfhost.toml the hooks use for the repository it starts in. The embedded ledger is
  opened for each call and closed after it. While `selfhost import --watch` holds it,
  `get_budget` answers from the spend the watcher saves (`~/.selfhost/feed/spend.json`, a few
  times a minute) and `list_review_items` from the person's open items it saves for `selfhost
  inbox`; other states and the other tools that read the ledger answer `unavailable`.
- **Team**: the team server serves `POST /v1/mcp` for person tokens (`apps/server`). On a laptop
  in a team, `selfhost mcp` hands every call to that endpoint with the person token from
  `selfhost join`, so agents keep one local entry and no token is written into their configs; it
  also writes approved exceptions' grants on the laptop. An agent that speaks Streamable HTTP
  can also call `/v1/mcp` directly with `Authorization: Bearer <person token>`.

`selfhost mcp install` adds the `selfhost` entry (`selfhost mcp`) to Claude Code, Codex,
Cursor, OpenCode and Goose through `packages/agents`, under its own profile;
`selfhost mcp uninstall` takes it out again.

```ts
import { createMcpServer, handleMcpHttp, ledgerData, serveStdio } from "@selfhost/mcp";

const data = {
  ...ledgerData({ use: (fn) => fn(ledger), person, now: () => new Date(), source: "cli" }),
  policy: async (query) => policyFor(query),
  budget: async (query) => budgetFor(query),
};
await serveStdio(createMcpServer(data, { version }));
// or, per HTTP request:
return handleMcpHttp(request, () => createMcpServer(data, { version }));
```

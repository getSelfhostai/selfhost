# selfhost

The open backend for your coding agent fleet: one ledger, one review list, one team config across every coding agent.

## Status

Usable, before a first release. The npm package is not published yet, so it runs from a clone
(see [`apps/cli/AGENTS.md`](./apps/cli/AGENTS.md)). What works today:

- `selfhost init` on a laptop: a hook in Claude Code and Codex (`selfhost guard install` also
  covers Cursor, OpenCode and Goose) that applies `selfhost.toml` and the built-in guardrails
  before every tool call, a starter `selfhost.toml`, and the last 30 days of session logs in a
  local ledger (embedded Postgres, no Docker).
- The guardrails block force pushes, `git reset --hard`, `rm -rf` outside the workspace and reads
  of `.env` and key files from the first run; rules start in observe and move to enforce with
  `selfhost policy promote`. A blocked call can be allowed once by a person (`selfhost inbox`).
- The review list (`selfhost inbox`, `selfhost review list`), the decision log (`selfhost
  decide`, `selfhost decisions`), spend and budgets (`selfhost spend`), the MCP server for agents
  (`selfhost mcp`) and the web console (`selfhost console`).
- Team mode: `selfhost up` sets up a server, `selfhost team init` and `selfhost join` connect
  laptops to it, and `selfhost team policy push` sets the team's policy.

## What it is

- **Agent ledger**: one event schema for every run, tool call, approval, human decision and cost
  across Claude Code, Codex, OpenCode, Goose and Cursor, stored append-only in Postgres.
- **Review list**: a headless, ranked list of everything that needs a human.
- **Team config**: `selfhost.toml`, compiled into each agent's own config. Rules start in observe
  and move to enforce.

It runs as a laptop install (embedded Postgres via PGlite, no Docker), a self-hosted server
(Postgres 16 via Docker Compose, see [`deploy/docker`](./deploy/docker/README.md)) or hosted,
from the same code.

## Repository layout

| Path                     | What                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `packages/schema`        | v1 contracts: ledger event, `selfhost.toml`, review item, hook payloads, OpenAPI, MCP tools |
| `packages/ledger`        | Append-only ledger store on Postgres or PGlite, plus a mapper per event source              |
| `packages/importers`     | Local session log importers for Claude Code and Codex (pricing ported from ccusage, MIT)    |
| `packages/spend`         | Spend by request type, agent, model and person, and the waste detector                      |
| `packages/gateway`       | Writes the AI gateway's keys and budgets (Bifrost or LiteLLM), reads its usage              |
| `packages/policy`        | Evaluates `selfhost.toml` rules against tool calls and records would-block events           |
| `packages/compile`       | Compiles `selfhost.toml` into each vendor's native controls, with coverage per rule         |
| `packages/review`        | The review list: items from ledger signals, deduped, routed, ranked, with approval timeouts |
| `packages/notify`        | Phone, chat and email alerts and digests through Apprise, every send recorded, no secrets   |
| `packages/agents`        | Agent and login detection, context file listing, and config writing for five agent CLIs     |
| `packages/attribution`   | Links commits and pull requests to the agent and model that produced them, with merge stats |
| `packages/pr`            | Reads a pull request or local commits: hunks, new dependencies, test changes, the agent run |
| `packages/brief`         | The review brief comment on agent pull requests, as data and as Markdown                    |
| `packages/github`        | Labels, review check run, review requests and brief comment on agent PRs, via a GitHub App  |
| `packages/integrations`  | The router, tracer, runtime and reviewer a team picks: one adapter per tool and its check   |
| `packages/sdk`           | The event schema versions clients send (the API client is not written yet)                  |
| `packages/vendor-compat` | Scheduled checks of new vendor CLI releases, and the page in `docs/compatibility`           |
| `apps/server`            | HTTP API server (Hono)                                                                      |
| `apps/cli`               | `selfhost` command line                                                                     |
| `apps/console`           | Web console: usage, spend, review list, rules, runs, code and team settings                 |
| `adapters/`              | Per-agent and per-system integrations (none yet)                                            |
| `deploy/docker`          | Docker Compose install: Postgres, the OpenTelemetry collector and the server, with backups  |
| `ee/risk`                | PR risk score and its label and check result (commercial license, see `ee/`)                |
| `docs/build-plan`        | Milestones and acceptance criteria                                                          |

## Development

Requires Node 20 or later (CI uses 22, see `.nvmrc`) and pnpm 10.

```sh
pnpm install
pnpm check                          # typecheck, lint, test
pnpm --filter @selfhost/server dev  # http://127.0.0.1:4400/v1/health
pnpm --filter @selfhost/cli dev doctor
```

Other scripts: `pnpm build`, `pnpm format`, `pnpm build:cli` (standalone binaries with
`bun build --compile`). `docker compose up -d` starts Postgres 16 for local development.

After changing a contract in `packages/schema/src`, run `pnpm --filter @selfhost/schema export`
to regenerate the JSON Schema, OpenAPI and MCP files; a test fails if they are stale.

Import the last 30 days of local session logs into the embedded ledger (`~/.selfhost/data`):

```sh
pnpm --filter @selfhost/cli dev import
pnpm --filter @selfhost/cli dev import --watch
```

See where the spend goes and which overhead started growing (request types are listed in
[`packages/spend`](./packages/spend/README.md#request-types)):

```sh
pnpm --filter @selfhost/cli dev spend --since 7d --by request_type,model --threshold 10
```

Check `selfhost.toml`, run its test cases, try a rule on a made-up tool call, and record what
each rule would have blocked in the tool calls already in the ledger (observe mode: nothing is
stopped). [`presets/`](./presets) holds four starting policies with their tests, which
`selfhost init --preset <name>` writes as `selfhost.toml`:

```sh
pnpm --filter @selfhost/cli dev policy check
pnpm --filter @selfhost/cli dev policy test ../../presets
pnpm --filter @selfhost/cli dev policy test --tool Bash --command "git push --force"
pnpm --filter @selfhost/cli dev policy observe --since 30d
```

Audit the last 30 days of local agent logs in one command, with no account and nothing uploaded:
cost by agent and model, leaks (status loops, cache misses, retry loops, oversized context) and
the most expensive sessions, plus, in a git repo, who wrote the commits and what merged with no
review (see [`apps/cli`](./apps/cli/README.md)). Token parsing and prices come from
[ccusage](https://github.com/ccusage/ccusage) by ryoppippi (MIT):

```sh
pnpm --filter @selfhost/cli dev scan --since 30d --report scan.html --share scan.svg
```

## Security

The team server decides who may answer what. The hooks and the CLI's checks on a laptop (a
command that refuses inside an agent session, a hook that blocks `selfhost inbox approve`) are a
convenience: an agent running as the same OS user, with the person's token, can always get past
them, so the server checks every answer itself, whichever way it arrives (the review item route,
decisions synced from a laptop, the MCP server):

- A person token records decisions only as its own person. A synced `decision.recorded` event
  whose `decision.by` names someone else is refused; the admin token may name anyone.
- Approving or overriding a one-time exception needs the owner or admin role in the item's team,
  and the person whose agent was blocked cannot approve their own unless the team's
  `selfhost.toml` sets `[review] self_approve_exceptions = true`. Answering a proposal to the
  team's context needs the owner or admin role. Denying an exception is always allowed.
- A decision the server refuses is logged and leaves the item open. A laptop in team mode gets a
  grant only from the server's answer, so a refused decision allows nothing.
- Agents never answer approvals, questions, exceptions, blocked actions, context proposals or
  budget and alert items through the MCP `record_decision` tool.

On a laptop, the embedded ledger (`~/.selfhost/data`, which holds notification target URLs) and
the server's data folder are readable by their owner only: folders 0700, files 0600, fixed on the
next open for installs made before. `selfhost ledger backup` writes 0600 files, and `selfhost
ledger restore`, `backup`, `migrate` and `prune` refuse while `selfhost import --watch` holds the
ledger.

## License

Apache-2.0, see [LICENSE](./LICENSE). The `ee/` folder is under a separate commercial license,
see [ee/LICENSE](./ee/LICENSE).

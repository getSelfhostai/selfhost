# selfhost

The open backend for your coding agent fleet: one ledger, one review list, one team config across every coding agent.

## Status

Early. Not ready for use. The repository has the toolchain, the v1 contracts, the ledger store,
an API server that ingests and searches events, importers for local Claude Code and Codex
session logs, commit and pull request attribution to agents and models, and `selfhost agents`,
which finds installed agents and their logins and writes selfhost's settings into each agent's
own config, and solo and team modes: `selfhost team init` and `selfhost join` connect laptops to
a shared server that holds their usage and one team policy, and the human decision log:
`selfhost decide`, `selfhost decisions` and `POST /v1/decisions` record every person's answer on
agent work with its reason and find past ones by file or topic, and the review list engine:
items built from ledger signals, routed by `selfhost.toml`, ranked, with approval timeouts,
served by `GET /v1/review-items` and `selfhost review list`. The team config comes next.

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

| Path                   | What                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `packages/schema`      | v1 contracts: ledger event, `selfhost.toml`, review item, hook payloads, OpenAPI, MCP tools |
| `packages/ledger`      | Append-only ledger store on Postgres or PGlite, plus a mapper per event source              |
| `packages/importers`   | Local session log importers for Claude Code and Codex (pricing ported from ccusage, MIT)    |
| `packages/spend`       | Spend by request type, agent, model and person, and the waste detector                      |
| `packages/policy`      | Evaluates `selfhost.toml` rules against tool calls and records would-block events           |
| `packages/review`      | The review list: items from ledger signals, deduped, routed, ranked, with approval timeouts |
| `packages/agents`      | Agent and login detection, context file listing, and config writing for five agent CLIs     |
| `packages/attribution` | Links commits and pull requests to the agent and model that produced them, with merge stats |
| `packages/pr`          | Reads a pull request or local commits: hunks, new dependencies, test changes, the agent run |
| `packages/brief`       | The review brief comment on agent pull requests, as data and as Markdown                    |
| `packages/github`      | Labels, review check run, review requests and brief comment on agent PRs, via a GitHub App  |
| `packages/sdk`         | API client (placeholder)                                                                    |
| `apps/server`          | HTTP API server (Hono)                                                                      |
| `apps/cli`             | `selfhost` command line                                                                     |
| `apps/console`         | Web console (placeholder)                                                                   |
| `adapters/`            | Per-agent and per-system integrations (none yet)                                            |
| `deploy/docker`        | Docker Compose install: Postgres, the OpenTelemetry collector and the server, with backups  |
| `ee/risk`              | PR risk score and its label and check result (commercial license, see `ee/`)                |
| `docs/build-plan`      | Milestones and acceptance criteria                                                          |

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

## License

Apache-2.0, see [LICENSE](./LICENSE). The `ee/` folder is under a separate commercial license,
see [ee/LICENSE](./ee/LICENSE).

# selfhost

The open backend for your coding agent fleet: one ledger, one review list, one team config across every coding agent.

## Status

Early. Not ready for use. The repository has the toolchain, the v1 contracts, the ledger store,
an API server that ingests and searches events, importers for local Claude Code and Codex
session logs, commit and pull request attribution to agents and models, and `selfhost agents`,
which finds installed agents and their logins and writes selfhost's settings into each agent's
own config. The review list and team config come next.

## What it is

- **Agent ledger**: one event schema for every run, tool call, approval, human decision and cost
  across Claude Code, Codex, OpenCode, Goose and Cursor, stored append-only in Postgres.
- **Review list**: a headless, ranked list of everything that needs a human.
- **Team config**: `selfhost.toml`, compiled into each agent's own config. Rules start in observe
  and move to enforce.

It runs as a laptop install (embedded Postgres via PGlite, no Docker), a self-hosted server
(Postgres 16 via Docker Compose) or hosted, from the same code.

## Repository layout

| Path                   | What                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `packages/schema`      | v1 contracts: ledger event, `selfhost.toml`, review item, hook payloads, OpenAPI, MCP tools |
| `packages/ledger`      | Append-only ledger store on Postgres or PGlite, plus a mapper per event source              |
| `packages/importers`   | Local session log importers for Claude Code and Codex (pricing ported from ccusage, MIT)    |
| `packages/spend`       | Spend by request type, agent, model and person, and the waste detector                      |
| `packages/agents`      | Agent and login detection, context file listing, and config writing for five agent CLIs     |
| `packages/attribution` | Links commits and pull requests to the agent and model that produced them, with merge stats |
| `packages/sdk`         | API client (placeholder)                                                                    |
| `apps/server`          | HTTP API server (Hono)                                                                      |
| `apps/cli`             | `selfhost` command line                                                                     |
| `apps/console`         | Web console (placeholder)                                                                   |
| `adapters/`            | Per-agent and per-system integrations (none yet)                                            |
| `ee/`                  | Commercial code under a separate license (empty)                                            |
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

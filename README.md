# selfhost

The open backend for your coding agent fleet: one ledger, one review list, one team config across every coding agent.

## Status

Early. Not ready for use. The repository has the toolchain, the v1 contracts and a health-check
server; the ledger, importers and review list come next.

## What it is

- **Agent ledger**: one event schema for every run, tool call, approval, human decision and cost
  across Claude Code, Codex, OpenCode, Goose and Cursor, stored append-only in Postgres.
- **Review list**: a headless, ranked list of everything that needs a human.
- **Team config**: `selfhost.toml`, compiled into each agent's own config. Rules start in observe
  and move to enforce.

It runs as a laptop install (embedded Postgres via PGlite, no Docker), a self-hosted server
(Postgres 16 via Docker Compose) or hosted, from the same code.

## Repository layout

| Path                 | What                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `packages/schema`    | v1 contracts: ledger event, `selfhost.toml`, review item, hook payloads, OpenAPI, MCP tools |
| `packages/ledger`    | Ledger store (placeholder)                                                                  |
| `packages/importers` | Log and API importers (placeholder)                                                         |
| `packages/sdk`       | API client (placeholder)                                                                    |
| `apps/server`        | HTTP API server (Hono)                                                                      |
| `apps/cli`           | `selfhost` command line                                                                     |
| `apps/console`       | Web console (placeholder)                                                                   |
| `adapters/`          | Per-agent and per-system integrations (none yet)                                            |
| `ee/`                | Commercial code under a separate license (empty)                                            |
| `docs/build-plan`    | Milestones and acceptance criteria                                                          |

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

## License

Apache-2.0, see [LICENSE](./LICENSE). The `ee/` folder is under a separate commercial license,
see [ee/LICENSE](./ee/LICENSE).

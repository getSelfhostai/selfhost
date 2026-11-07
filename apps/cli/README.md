# @selfhost/cli

The `selfhost` command line.

```sh
pnpm --filter @selfhost/cli dev --version
pnpm --filter @selfhost/cli dev doctor [--config path/to/selfhost.toml]
pnpm --filter @selfhost/cli dev spend --since 7d --by request_type,model
pnpm --filter @selfhost/cli dev scan --since 30d --report scan.html --share scan.svg
pnpm --filter @selfhost/cli dev agents
pnpm --filter @selfhost/cli dev agents configure --dry-run --otel-endpoint http://127.0.0.1:4318
```

`selfhost spend [--since 7d] [--by request_type,model] [--threshold 10] [--min-usd 0] [--json]`
reads `cost.recorded` events from the ledger (the same one `selfhost import` writes, or
`--database` / `--data-dir`), keeps one source per session, and prints spend per group with its
share, then every request type that crossed `--threshold` percent of a day's spend, with the day
it crossed and the days before. `--by` takes `request_type`, `agent`, `model` and `person`; flags
are always by request type. See [`packages/spend`](../../packages/spend/README.md).

`selfhost scan [--since 30d] [--repo <dir>] [--json] [--report <file>] [--share <file>]` is a
one-command audit of the local Claude Code and Codex logs. It needs no account, no ledger and no
network: it reads the logs for the window into memory and prints cost by agent and model, leak
findings and the five most expensive sessions, each with a reason. With a git repository (the
one around the current folder, or `--repo`) it leads with three git-joined numbers: the share of
commits each agent wrote, agent PRs merged with no review, and spend on sessions that produced no
commit. `--report` writes one self-contained HTML page (light and dark, works at phone width),
`--share` an SVG image card with the totals, and `--json` the report as `selfhost.scan/v1`. All
three carry the same totals, and none of them hold prompts, replies or code: totals and file
paths only. Token counts and prices come from [ccusage](https://github.com/ccusage/ccusage) by
ryoppippi (MIT), credited in the output too.

Leak rules (thresholds in `src/scan/leaks.ts`):

| Leak                             | Fires when                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Status-line and background loops | the waste detector flags `status_line` or `background` requests at 10% or more of a day's spend                   |
| Status polling loops             | the same tool call with the same input runs 6 or more times in a row                                              |
| Cache misses                     | under 50% of the context is read from cache after the first request, in sessions with 5+ requests and 50k+ tokens |
| Retry loops                      | 2 or more requests in a session are re-sent after API errors, or the detector flags `retry` on a day              |
| Oversized context                | 3 or more requests in a session carry 150k or more tokens of context                                              |

After the text report, `selfhost scan` asks once whether to send an anonymous count of the agents
it found (the number only). The answer is kept in `~/.selfhost/config.json` and defaults to no.
It is never asked with `--json` or when stdin is not a terminal, and nothing is sent unless the
answer was yes and `SELFHOST_TELEMETRY_URL` is set.

`selfhost doctor` prints the runtime, finds `selfhost.toml` (the `--config` flag, then
`SELFHOST_CONFIG`, then the nearest file from the current directory up to the repository root)
and validates it. It exits 1 when the file is invalid.

`selfhost agents` lists Claude Code, Codex, OpenCode, Goose and Cursor CLI: installed, version,
login and settings file, then the context files (CLAUDE.md, AGENTS.md, skills) in the
repository and the home config. It never asks for an API key; an agent with no login gets its
own sign-in command.

`selfhost agents configure` writes selfhost's settings into each agent's own settings file:
`--hook-command <cmd>` (`{agent}` becomes the agent id), `--env KEY=VALUE`, `--mcp
name=command args` or `--mcp name=url`, and `--otel-endpoint` with `--otel-protocol`,
`--otel-header`, `--otel-traces` and `--otel-log-prompts`. It configures the agents it finds
unless `--agent` names them. `--dry-run` prints a unified diff with credential-looking values
masked, `--remove` takes selfhost's settings out again, and `--home <dir>` points every path at
a fixture home (it also turns off the keychain and version probes). See
[`@selfhost/agents`](../../packages/agents/README.md) for what is written where.

Every command takes `--json` and prints one object with a `schema` tag: `selfhost.doctor/v1`,
`selfhost.import/v1` (plus one `selfhost.import_batch/v1` line per batch with `--watch`),
`selfhost.agents/v1`, `selfhost.agents_configure/v1` and `selfhost.scan/v1`. Errors print `selfhost.error/v1` and
exit 1. No command needs a network connection.

## Binaries

`pnpm build:cli` compiles standalone binaries with `bun build --compile` into `dist/`:
`selfhost-linux-x64`, `selfhost-linux-arm64`, `selfhost-darwin-arm64` and `selfhost-darwin-x64`.
Pass target names to build a subset, for example `pnpm build:cli bun-darwin-arm64`.

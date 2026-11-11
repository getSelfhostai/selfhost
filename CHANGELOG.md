# Changelog

Each release has a section here; the release workflow uses it as the GitHub Release notes and
fails when the tag's version has none. Versions follow semver. `pnpm release:version <x.y.z>`
sets a new version everywhere it is written down.

## 0.1.0

The first release: the `selfhostai` npm package (the `selfhost` command), standalone binaries for
Linux and macOS (x64 and arm64), and the server image `ghcr.io/<owner>/selfhost:0.1.0` for
linux/amd64 and linux/arm64.

### Laptop

- `selfhost init`: a hook in Claude Code and Codex that applies `selfhost.toml` before every tool
  call, a starter `selfhost.toml` in observe mode (or a preset: `startup`, `strict`, `oss`,
  `irreversible`), and the last 30 days of local session logs imported into an embedded ledger
  (PGlite, no Docker). `--dry-run` shows every change first.
- Guardrails from the first run: force pushes, `git reset --hard`, `rm -rf` outside the
  workspace and reads of `.env` and key files are blocked. `selfhost guard install` also covers
  Cursor and OpenCode. Rules move from observe to enforce with `selfhost policy promote`; a
  blocked call can be allowed once by a person (`selfhost inbox`).
- Policy tooling: `selfhost policy check`, `policy test`, `policy observe` (what each rule would
  have blocked in the ledger), and compiling `selfhost.toml` into each vendor's native controls.
- Spend: `selfhost spend` by request type, agent, model and person, the waste detector, plan
  limit forecasts and spike alarms, and `selfhost scan` for a one-command local audit report.
- The review list (`selfhost inbox`, `selfhost review list`), the decision log (`selfhost
  decide`, `selfhost decisions`), the MCP server for agents (`selfhost mcp`) and the web console
  (`selfhost console`).

### Team

- `selfhost up` sets up a team server on Hetzner, DigitalOcean, AWS or any host over SSH: HTTPS
  through Caddy, optional GitHub or Google sign-in, a daily backup, and optionally the AI gateway
  (Bifrost) with per-person keys and budgets. It checks the image tag exists before it creates
  anything.
- `selfhost team init`, `selfhost join` and `selfhost team policy push` connect laptops and set
  the team's policy. The server checks who may answer each review item and exception.
- The Docker Compose install in `deploy/docker`: Postgres 16, the OpenTelemetry collector and the
  API, with `upgrade.sh` (upgrade and roll back, with down migrations), `backup.sh` and
  `restore.sh`.
- The server: the ledger API, OTLP ingest from the collector, the review list, notifications
  through Apprise, and the GitHub App for labels, the review check and the review brief on agent
  pull requests.

### Contracts

- v1 JSON Schemas for the ledger event, `selfhost.toml`, the review item, the proof receipt and
  the Claude Code and Codex hook payloads, plus the OpenAPI document and the MCP tool list
  (`packages/schema`). The schemas are attached to each GitHub Release.

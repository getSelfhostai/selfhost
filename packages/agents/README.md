# @selfhost/agents

Finds the coding agents on a machine and their logins, lists the context files they load, and
writes selfhost's hooks, env, MCP servers and OpenTelemetry settings into each agent's own
settings file. It never edits a shell profile, so GUI apps launched from the Dock pick the
settings up too.

```ts
import {
  applyAgentConfig,
  detectAgents,
  findContextFiles,
  planAgentConfig,
  systemProbes,
} from "@selfhost/agents";

const agents = detectAgents({ home, env, platform, ...systemProbes(env) });
const plan = planAgentConfig("codex", { home, otel: { endpoint: "http://127.0.0.1:4318" } });
applyAgentConfig(plan); // or show plan.changes as a diff with unifiedDiff()
```

Every function takes a `home` directory. `detectAgents` runs nothing unless it is given a
`keychain` or `version` probe, so tests on fixture homes never touch the real keychain.

## Detection

Logins are found only from the presence of credential files, keychain items and environment
variable names. No secret is read: the macOS check runs `security find-generic-password -s
<service>` without `-w` or `-g`.

| Agent       | Settings                                                      | Login                                                                                      |
| ----------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Claude Code | `~/.claude/settings.json`, MCP in `~/.claude.json`            | `.credentials.json`, keychain `Claude Code-credentials`, `apiKeyHelper`, `ANTHROPIC_*` env |
| Codex       | `~/.codex/config.toml` (`CODEX_HOME`)                         | `auth.json`, keychain `Codex Auth` (account `cli\|<hash>`)                                 |
| OpenCode    | `~/.config/opencode/opencode.json(c)` (`XDG_CONFIG_HOME`)     | `~/.local/share/opencode/auth.json`, provider key env; `opencode.db` reports unknown       |
| Goose       | `~/.config/goose/config.yaml`, `%APPDATA%\Block\goose\config` | `secrets.yaml`, keychain `goose`/`secrets`, provider key env                               |
| Cursor CLI  | `~/.cursor/cli-config.json`, `mcp.json`, `hooks.json`         | `auth.json`, keychain `cursor-access-token`, `CURSOR_API_KEY`                              |

`CLAUDE_CONFIG_DIR` moves `~/.claude` and `~/.claude.json` and adds a hash of the directory to
the keychain service name. Keyrings on Linux and Windows can't be checked without reading them,
so those logins report `unknown`.

## What gets written

| Agent       | hooks                                     | env                   | MCP                           | OpenTelemetry                  |
| ----------- | ----------------------------------------- | --------------------- | ----------------------------- | ------------------------------ |
| Claude Code | `settings.json` `hooks`                   | `settings.json` `env` | `~/.claude.json` `mcpServers` | `env` (`OTEL_*`)               |
| Codex       | `[[hooks.*]]`, or `hooks.json` if present | unsupported           | `[mcp_servers.<name>]`        | `[otel]`                       |
| OpenCode    | unsupported (JavaScript plugins)          | unsupported           | `mcp.servers.<name>`          | unsupported (process env only) |
| Goose       | unsupported                               | unsupported           | `extensions.<name>`           | `otel_exporter_otlp_endpoint`  |
| Cursor CLI  | `~/.cursor/hooks.json`                    | unsupported           | `~/.cursor/mcp.json`          | unsupported                    |

JSON and YAML files are merged key by key; YAML comments survive. In TOML, selfhost keeps
everything in one block between `# >>> selfhost >>>` and `# <<< selfhost <<<`, so the rest of
the file is never rewritten. A key the user already set to another value is reported as a
conflict and left alone. What selfhost added is recorded in `~/.selfhost/agents/<agent>.json`,
so a re-run plans no changes and `removeAgentConfig` takes out exactly that, restoring the
user's keys. `applyAgentConfig` refuses a plan whose files changed since it was made, writes
each file through a temporary file and a rename, keeps its permissions, writes through
symlinks, and saves a timestamped `.selfhost-backup-*` copy next to each changed file.

## Context files

`findContextFiles` lists `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, skills
(`.claude/skills`, `.agents/skills`, `.codex/skills`, `.opencode/skill(s)`, `.cursor/skills`),
subagents, commands, Cursor rules and `.goosehints`, in the repository and the home config,
with path, kind and size. It does not read them.

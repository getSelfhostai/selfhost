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
| OpenCode    | `plugins/selfhost.js` when given one      | unsupported           | `mcp.servers.<name>`          | unsupported (process env only) |
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

`hooks.events: "pre_tool"` hooks only the events whose answer can stop a tool call
(`PRE_TOOL_HOOK_EVENTS`: Claude Code and Codex `PreToolUse`; Cursor `preToolUse`,
`beforeShellExecution`, `beforeReadFile` and `beforeMCPExecution`). OpenCode has no hook
settings, so `hooks.opencodePlugin` (JavaScript source) is written whole to
`plugins/selfhost.js` in its config folder; a file there that selfhost did not write is a
conflict. A `profile` keeps a separate record (`~/.selfhost/agents/<agent>.<profile>.json`) and
its own TOML block (`# >>> selfhost <profile> >>>`), so `selfhost guard install` (profile
`guard`) and `agents configure` are added and removed apart. A hook another profile already
added counts as already set and is left to that profile.

## The AI gateway

`gateway` (with `profile: GATEWAY_PROFILE`, as `selfhost gateway connect` uses it) points an
agent's model traffic at an AI gateway with a virtual key: `{ anthropic, openai, key }`, the
gateway's Anthropic-style base URL, its OpenAI-style one ending in `/v1`, and the key.

| Agent       | What is written                                                                              |
| ----------- | -------------------------------------------------------------------------------------------- |
| Claude Code | `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` in `settings.json` `env`                     |
| Codex       | `model_provider = "selfhost"` and `model_providers.selfhost` (`experimental_bearer_token`)   |
| OpenCode    | `provider.anthropic.options` and `provider.openai.options`: `baseURL` and `apiKey`           |
| Goose       | `custom_providers/selfhost.json`: OpenAI-style, `requires_auth: false`, the key in `headers` |
| Cursor CLI  | unsupported: its model traffic leaves from Cursor's servers                                  |

Codex's keys are top-level, so the gateway profile's TOML block goes at the start of
`config.toml`, where a key can't fall into the user's last table, and holds nothing else.
Claude Code settings with `ANTHROPIC_API_KEY`, `apiKeyHelper` or a `CLAUDE_CODE_USE_*` provider
in `env` are a conflict: they would send a second key or go past the gateway. Goose reads no
key from its config files, so the key is a header on the custom provider.

`subscriptionLogin(agent, { home, env, platform, keychain })` says whether an agent is signed
in with a subscription, whose traffic goes to the vendor and never reaches a gateway: a Claude
account login (`.credentials.json`, the keychain item, `CLAUDE_CODE_OAUTH_TOKEN`), a ChatGPT
login in Codex's `auth.json` (or a keychain login, which can't be told from an API key), or an
OAuth login to Anthropic or OpenAI in OpenCode's `auth.json`. Only the kind of login is looked
at, never a token.

## Context files

`findContextFiles` lists `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `AGENTS.override.md`,
`GEMINI.md`, Copilot instructions (`.github/copilot-instructions.md`, `.github/instructions`,
`~/.copilot`), skills (`.claude/skills`, `.agents/skills`, `.codex/skills`, `.opencode/skill(s)`,
`.cursor/skills`), subagents, commands, Claude Code and Cursor rules, `.goosehints` and MCP
configs (`.mcp.json`, `~/.claude.json`, `.cursor/mcp.json`, `.codex/config.toml`, `opencode.json`,
`.vscode/mcp.json`, Goose `config.yaml`, Gemini `settings.json`, `~/.copilot/mcp-config.json`), in
the repository and the home config, with path, kind, size and `readers`: every agent that reads
the file with default settings, after one file hides another (Claude Code skips `AGENTS.md`
under a `CLAUDE.md`, OpenCode skips `CLAUDE.md` next to an `AGENTS.md`, Codex reads
`AGENTS.override.md` instead of `AGENTS.md`). The sources are cited in `src/context.ts`. It does
not read the files.

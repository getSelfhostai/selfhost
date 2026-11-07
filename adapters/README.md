# adapters

Integrations with each coding agent and outside system live here, one package per folder
(`adapters/<name>`), for example the Claude Code and Codex hook installers, the runtime plugin
and notification channels. None exist yet.

Each adapter turns its system's payloads into the contracts in [`packages/schema`](../packages/schema)
and compiles `selfhost.toml` into that agent's own config.

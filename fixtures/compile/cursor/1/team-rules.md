# Team policy

These rules come from selfhost.toml. Follow every one. Rules in enforce mode are also enforced through each agent's settings and hooks; the others are recorded.

selfhost policy compile writes this file. Change selfhost.toml and compile again instead of editing it.

## Rules

- `no-force-push` (enforced: blocked, cannot be undone): Force pushes are blocked. Push a new commit instead. Applies to shell commands matching the regular expression `^git push (--force|-f)(\s|$)`.
- `reset-hard` (enforced: asks a person first, cannot be undone): git reset --hard drops uncommitted work. Applies to shell commands matching the regular expression `^git reset --hard`.
- `no-rm-rf` (enforced: blocked): rm -rf is blocked. Applies to shell commands matching the regular expression `rm -rf`.
- `no-curl-pipe` (enforced: blocked): Do not pipe downloads into a shell. Applies to shell commands matching the regular expression `curl .*\| *sh`.
- `env-files` (enforced: blocked): Do not read or write .env files. Applies to files matching `**/.env*` from the repository root.
- `infra-edits` (enforced: asks a person first): Infrastructure changes need a person. Applies to `Edit` calls on files matching `infra/**` from the repository root.
- `no-paste-sites` (enforced: blocked): Do not send code to paste sites. Applies to URLs matching `https://*.pastebin.com/**`.
- `no-web-search` (observed: would be blocked): Web search is off for now. Applies to every `WebSearch` call.
- `codex-npm-publish` (enforced: blocked, only for Codex): Publishing happens in CI. Applies to shell commands matching the regular expression `^npm publish$`.

## MCP servers

Use only these MCP servers (enforced): `github`, `linear`.

## Models

Use only these models (observed): `claude-opus-5`, `claude-sonnet-5`.

# Installing selfhost on a laptop

For a coding agent asked to set up selfhost. It is one command. Without a terminal it asks
nothing; pass `--import-context` or `--no-import-context` to decide the one question it asks in a
terminal.

## Install

```sh
npx selfhostai init --dry-run   # show the person what would change; writes nothing
npx selfhostai init
```

The npm package is not published yet. Until it is, from a clone of the repository:

```sh
pnpm install && pnpm --filter @selfhost/cli build
node apps/cli/dist/main.js init --dry-run
node apps/cli/dist/main.js init
```

Flags: `--json` prints one `selfhost.init/v1` object, `--since 30d` sets the import window,
`--agent claude codex` limits the agents, and `--team "selfhost join <server> <invite>"` (the
line the team admin shared) joins a team first. A refused invite exits 1 and changes no files.
`--preset startup|strict|oss|irreversible` writes that preset as `selfhost.toml` instead of the
starter rules; use it only when the person asks for one, since presets enforce some rules.
`--import-context` copies the repository's CLAUDE.md, AGENTS.md, rules, skills, commands,
subagents and MCP servers into `.selfhost/context/`; ask the person first, since it adds files to
the repository.

## What it changes

- Claude Code `~/.claude/settings.json` and Codex `~/.codex/config.toml` (or `~/.codex/hooks.json`
  when that file exists): a hook that runs `selfhost hook <agent>` on each event. Every file is
  backed up first, next to itself, as `<file>.selfhost-backup-<UTC time>`. Codex asks the person
  to approve new hooks with `/hooks`.
- `~/.selfhost/`: the ledger (`data/`), hook events waiting for import (`spool/`), the list of
  files init changed (`init.json`) and, with `--team`, the membership (`config.json`).
- `selfhost.toml` at the git repository root, only when none exists: four starter rules, all in
  observe mode, or the preset given with `--preset`. The hooks still apply the built-in guardrails
  before each tool call: force pushes, `git reset --hard`, `rm -rf` outside the workspace and reads
  of `.env` and key files are blocked unless `[guardrails] mode` in `selfhost.toml` is `observe`
  or `off`.
- With `--import-context`: new files in `.selfhost/context/` at the repository root. The context
  files they come from are not changed.
- Nothing else: no shell profile, no API key, no sign-in.

## Undo

`selfhost init --undo` puts every agent config file back byte for byte from its backup and
deletes the context files init imported, unless the file was edited since; it then says which
one and where its backup is. It keeps the ledger, `selfhost.toml`, the context files init copied
from and any team membership (`selfhost team leave` ends that).

## Where data goes

Solo mode, the default: nothing leaves the laptop and no command makes a network request. Logs
and hook events go into the local ledger only, which keeps no prompt text. Raw hook payloads wait
in `~/.selfhost/spool` (readable by this user only) until the next import. With `--team`, each
`selfhost import` also sends the ledger to the team's server.

## Afterwards

- Hook events wait in `~/.selfhost/spool` until the next `selfhost import`; keep
  `selfhost import --watch` running to see them as they happen.
- Look around with `selfhost spend`, `selfhost review list`, `selfhost policy report` and `selfhost scan`. `selfhost console` opens the same ledger in the web console for a person to read.
- If `selfhost` is not on PATH, the hooks call the node binary and script that ran init by
  absolute path. Install it globally and run `selfhost init` again for a path that lasts.

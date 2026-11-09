# @selfhost/cli

The `selfhost` command line.

```sh
pnpm --filter @selfhost/cli dev --version
pnpm --filter @selfhost/cli dev doctor [--config path/to/selfhost.toml]
pnpm --filter @selfhost/cli dev spend --since 7d --by request_type,model
pnpm --filter @selfhost/cli dev console
pnpm --filter @selfhost/cli dev ledger prune --days 30
pnpm --filter @selfhost/cli dev spend forecast
pnpm --filter @selfhost/cli dev spend alarms --since 1h
pnpm --filter @selfhost/cli dev statusline
pnpm --filter @selfhost/cli dev inbox
pnpm --filter @selfhost/cli dev policy check
pnpm --filter @selfhost/cli dev policy test ../../presets
pnpm --filter @selfhost/cli dev policy test --tool Bash --command "git push --force"
pnpm --filter @selfhost/cli dev policy observe --since 30d
pnpm --filter @selfhost/cli dev packages check "npm i left-pad && pip install requests"
pnpm --filter @selfhost/cli dev review risk --base main
pnpm --filter @selfhost/cli dev review brief --base main
pnpm --filter @selfhost/cli dev provenance --since 30d
pnpm --filter @selfhost/cli dev scan --since 30d --report scan.html --share scan.svg
pnpm --filter @selfhost/cli dev agents
pnpm --filter @selfhost/cli dev agents configure --dry-run --otel-endpoint http://127.0.0.1:4318
pnpm --filter @selfhost/cli dev migrate conductor --dry-run --history ~/conductor-export
```

`selfhost spend [--since 7d] [--by request_type,model] [--threshold 10] [--min-usd 0] [--json]`
reads `cost.recorded` events from the ledger (the same one `selfhost import` writes, or
`--database` / `--data-dir`), keeps one source per session, and prints spend per group with its
share, then every request type that crossed `--threshold` percent of a day's spend, with the day
it crossed and the days before. `--by` takes `request_type`, `agent`, `model` and `person`; flags
are always by request type. See [`packages/spend`](../../packages/spend/README.md).

Each row and the total also show the prompt cache hit rate: cache reads over cache reads plus
uncached input plus cache writes (`cache_hit_rate` in `--json`). A session that reported no cache
read or write at all is left out and its group reads `unknown`, not 0%: some agents' logs carry
no cache fields. Sessions that cost at least `[alerts] cache_tip_usd` (default $5) at a hit rate
under `cache_hit_floor` (default 0.5) get one `Cost tip:` line each (`cache_tips` in `--json`).
While `selfhost import --watch` runs, a session past `cache_min_requests` (default 20) whose hit
rate over its last 10 requests falls under the floor raises one `alert.raised` event
(`data.alert: "cache_hit_low"`) naming the usual causes: a value that changes early in the
prompt, tool lists that reorder, model switches. The team server raises the same alert for the
sessions it receives (`SELFHOST_CACHE_ALERTS=off` stops it).

`selfhost tail [--agent <agent>] [--repo <owner/name>] [--person <id>] [--kind <kinds>]
[--session <id>] [--since 15m] [--json]` streams agent activity as it lands, one line each: time,
who, agent, what happened (session start and end, prompt, tool call with its redacted input, rule
`BLOCKED` or `ASKED` with the rule id, or `would block` in observe, cost with the session's cache
hit rate so far, alerts, review items that opened) and the link to its run in the console.
`--kind` takes event kinds or their first part (`tool`, `policy`, `cost`, `alert`, `session`) and
`review`; `--json` prints one `selfhost.tail_line/v1` object per line. Prompt text never shows, and
tool input only as the run view shows it.

- On a laptop it never holds the embedded ledger open while `selfhost import --watch` runs: the
  watcher appends each event it writes to `~/.selfhost/feed/` (redacted, two days kept, this user
  only) and the tail follows that. Without a watcher it reads the hook spool itself (no model
  costs, which come from the session logs only the watcher imports) and switches to the feed
  once one starts. `--since` without a watcher opens the ledger once, briefly, to read the past.
- With `DATABASE_URL` it polls Postgres directly.
- In a team it follows the team server (`GET /v1/events/tail`, a long poll), which shows the
  person only the teams they are in; `--local` follows this machine instead.

`selfhost console [--port 4400] [--host 127.0.0.1] [--no-open] [--json]` serves the web console
([`apps/console`](../console/README.md)) and the API on this machine's ledger (the one `selfhost
import` writes, or `--database` / `--data-dir`) and opens it in the browser, signed in: it prints
the URL, the link with the API token in its fragment, and the token (kept in `<data dir>/token`).
Usage, cost, sessions and PRs by team, developer, agent and model, with filters and CSV export.
It listens on 127.0.0.1 unless `--host` says otherwise and stops on Ctrl-C. The embedded ledger
is one process at a time, so stop `selfhost import --watch` first, or use Postgres. On a laptop
that joined a team it opens the team server's console instead, signed in as this person
(`<server>/#token=<person token>`, the same fragment sign-in); `--local` serves this machine's
own ledger.

`selfhost ledger prune [--days <n>] [--config <path>] [--json]` deletes events older than the
retention from the ledger (the one `selfhost import` writes, or `--database` / `--data-dir`):
`--days`, else `ledger.retention_days` in `selfhost.toml` (found like `doctor` does), else 90.
`selfhost import` keeps prompt text only with `--prompts`, and masks secrets and emails either
way; the ledger drops prompt text from any import without it.

`selfhost ledger status [--json]` prints the ledger's schema version against the migrations this
release knows (pending ones, and any from a newer release, which this one refuses to run on) and
the rows of every table. `selfhost ledger migrate [--to <version>] [--json]` applies pending
migrations, or moves the schema to a version (`0008`, or `0` for none), down with the rollback
of each newer migration, all in one transaction. Roll back with the newer release before you go
back to an older one: only it has the newer migrations' rollbacks. Both take `--database` /
`--data-dir`.

`selfhost ledger backup [file]` and `selfhost ledger restore <file> [--force]` back up and restore:

- The embedded ledger (`--data-dir`, default `~/.selfhost/data`): a gzipped tar of its folder,
  `selfhost-<UTC time>.tar.gz` here by default. A restore unpacks it next to the ledger and checks
  it first, so a bad file or one from a newer release changes nothing; then the ledger it replaces
  is moved to `<data dir>.before-restore-<time>`, not deleted. A ledger that already holds events
  is replaced only with `--force`. Stop `selfhost import --watch` and `selfhost console` first.
- A Docker Compose install or a `selfhost up` server, with `--host user@host` (`--port`, `-i`,
  `--dir`, default `/opt/selfhost/deploy/docker`): over SSH it runs the stack's `backup.sh`
  (`pg_dump --format=custom`) and copies the dump here with `scp`, or copies a dump there and runs
  `restore.sh`. Users other than root need `sudo` without a password.

Both print the rows of every table, so a restore can be checked against its backup. A ledger in
your own Postgres (`DATABASE_URL`) is refused: use `pg_dump --format=custom` and `pg_restore`.

`selfhost traces export [--since <date>] [--dry-run] [--json]` sends the ledger's finished runs
to the tracer in `[integrations.tracer]` of `selfhost.toml` (Langfuse, Phoenix, Datadog or any
OTLP endpoint), each agent session as one OpenTelemetry trace with GenAI attributes, the same
spans the team server sends. Header values come from the variables `headers_env` names. Runs
already sent are skipped, runs still going wait for the next export, and prompt text goes only
with `[ledger] log_prompts` on. `--dry-run` prints the spans and sends nothing.

### Plan limits and spend alarms

`selfhost spend plan [claude=<tier>] [codex=<tier>]` sets your own plan tiers (`pro`,
`max_5x`, `max_20x` for Claude; `plus`, `business`, `pro` for Codex; `none` clears one) in
`~/.selfhost/config.json`, and with no arguments prints them and the limit table. selfhost never
reads a vendor login or credential file to find your plan: you say which one you are on.

`selfhost spend forecast [--person <id>] [--plan claude=max_5x] [--warn-hours 24] [--json]`
prints, per person and plan, the 5-hour and weekly windows: usage, limit, when it runs out
("not this week" when it lasts) and the basis of the limit: `calibrated from N limit hits in the
logs`, the tier row of `selfhost.toml [plans]` or the built-in table (with its date), or none. A
window forecast to run out within `--warn-hours` (default `[alerts] forecast_warn_hours`, 24)
prints a warning with a fix: overflow to the team's API key under its cap (`[plans.overflow]`),
or move background work to quieter hours. Each warning is recorded once per window as an
`alert.raised` event with `data.alert: "limit_forecast"`, so a rerun records nothing new.
`--json` prints `selfhost.limit_forecast/v1`. See
[limit forecast](../../packages/spend/README.md#limit-forecast).

`selfhost spend alarms [--since 1h] [--json]` evaluates the 15-minute slots since `--since`
(`15m`, `1h`, `2d` or a date) for every key, person, agent and runtime against its own baseline
at the same time of day, and records each slot outside the band as an `alert.raised` event with
`data.alert: "spend_spike"`, labeled a possible stolen key, not a budget warning, with the
actions that apply (the key rotation runbook, pausing the runtime, disabling the gateway key).
Ids depend only on the series and the slot, so reruns record nothing twice. It exits 2 when there
is an alarm and 1 on errors, so a script can page on it:

```sh
*/5 * * * * selfhost spend alarms --since 15m || notify-on-call   # with Postgres (DATABASE_URL)
```

With the embedded ledger, one process at a time can open it, so let `selfhost import --watch` do
this instead: after each batch it forecasts your plans, looks for spikes, records and prints new
warnings and alarms (`Limit warning: ...`, `SPEND ALARM: ...`, or one `selfhost.alert/v1` line
each with `--json`), and rewrites `~/.selfhost/statusline.json`. A check runs at most every 15
seconds while batches keep coming, so an alarm prints within a minute of the spend landing.
Thresholds come from `[alerts]` and `[plans]` in the `selfhost.toml` found from the current
folder, else the team policy from the last sync. Slack, Telegram and email delivery come with
the review list and the Slack app.

### Statusline

`selfhost statusline` prints one short line: a possible stolen key alarm from the last hour,
else a plan limit about to run out (`Claude 5h limit in ~1h40m · overflow to team-overflow`),
else your spend today (`selfhost: $12.34 today`). When review items wait on you, their count
leads the line (after an alarm): `3 to review · $12.34 today`, or `3 to review, 1 blocking ·
Claude 5h limit in ~1h40m · overflow to team-overflow`. The count comes from the copy of your
review list that `selfhost inbox` saves in `~/.selfhost/inbox.json` and `import --watch`
refreshes (at start, after batches and every minute), less the actions you queued since; a copy
more than a day old with no watcher running is left off. No render calls the network.

The rest of the line comes from `~/.selfhost/statusline.json` (`--cache` or
`SELFHOST_STATUSLINE_CACHE` to move it), which `import --watch` keeps fresh, and a render takes
about 50 ms. It opens the ledger only when no watcher is running and the cache is more
than 5 minutes old (about 1.2 s on 35 days of a heavy user's history), then keeps the result in
the cache. It never opens the embedded ledger while a watcher holds it, and with no data it
prints `selfhost: no data yet, run selfhost import` instead of failing.

In Claude Code, add it to `~/.claude/settings.json` (Claude Code passes session details on
stdin, which selfhost ignores):

```json
{
  "statusLine": { "type": "command", "command": "selfhost statusline" }
}
```

Keep `selfhost import --watch` running so the line stays current.

Codex cannot show it: its status line (`[tui] status_line` in `~/.codex/config.toml`, or
`/statusline` in Codex) takes only built-in items and runs no command, as of Codex 0.163
([openai/codex#17827](https://github.com/openai/codex/issues/17827) asks for one). Its
`five-hour-limit` and `weekly-limit` items show the plan left on their own. For the review count
next to Codex, run `selfhost statusline` from a terminal status bar instead, for example in tmux:
`set -g status-right '#(selfhost statusline)'`.

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

The scan also lists every agent context file in the repository and the home folder:
`CLAUDE.md` at any depth, `CLAUDE.local.md`, `AGENTS.md` and `AGENTS.override.md`, `GEMINI.md`,
Copilot instructions, Cursor and Claude Code rules, `.cursorrules`, `.goosehints`, skills,
subagents, commands and MCP configs. Each row has the agents that read it (from
[`@selfhost/agents`](../../packages/agents/README.md)), whether every session loads all of it,
only its name and description (skills, subagents, commands, Cursor rules applied by
description) or nothing until the agent works on matching files, its tokens per session, sessions
a week and USD a week. Tokens are counted with the o200k_base encoding from
[gpt-tokenizer](https://github.com/niieani/gpt-tokenizer) (MIT): exact for Codex's GPT-5 models
and an estimate for Claude and the others, which publish no offline tokenizer. A file costs, for
each session of an agent that reads it in the window (in the repository for repository files,
anywhere for home files), one cache write and then a cache read on every later main or subagent
request, at that session's model rates from the ccusage price table. Agents without local logs
(Cursor, Copilot, Gemini CLI, OpenCode, Goose) are named but not priced, and MCP tool lists are
not counted, since that needs the servers running. Drift rules (in `src/scan/context/drift.ts`):

| Finding                                                         | Fires when                                                                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate                                                       | two files have the same lines (list markers, case and spacing aside), or 80% of the shorter file's lines (3 or more) are in the other       |
| Package manager, test runner, formatter, linter (JS and Python) | two files name tools with none in common (pnpm only, npm only), or one says not to use a tool another uses                                  |
| Node and Python version                                         | two files name versions no one version satisfies (`>=`, `+` and "or later" are minimums)                                                    |
| Do and don't                                                    | one file forbids force pushes, rebases, squash merges, default exports, semicolons, Docker or mocks and another asks for them               |
| MCP server                                                      | one server name has a different command, args, url, env names or header names in two configs                                                |
| Seen by one agent only                                          | a file or MCP server only one agent reads, and more than one agent has context files or sessions here; a copy another agent reads clears it |

A tool counts as used when a command names it (`pnpm install`, `vitest run`) or the bare name
appears; `npx`, global installs and the bare word npm (often the registry) do not. It counts as
forbidden after never, don't, do not, avoid, not, no or "migrated from", or after "instead of"
and "rather than". Each finding gives the file and line of each side and the words that matched,
never the line itself.

After the text report, `selfhost scan` asks once whether to send an anonymous count of the agents
it found (the number only). The answer is kept in `~/.selfhost/config.json` and defaults to no.
It is never asked with `--json` or when stdin is not a terminal, and nothing is sent unless the
answer was yes and `SELFHOST_TELEMETRY_URL` is set.

`selfhost doctor` prints the runtime, finds `selfhost.toml` (the `--config` flag, then
`SELFHOST_CONFIG`, then the nearest file from the current directory up to the repository root,
then, on a machine in a team, the team policy pulled into `~/.selfhost/team-policy.toml`) and
validates it. It exits 1 when the file is invalid. When both a repository file and a pulled
team policy exist, the repository file adds to the team policy, as a repo's rules add to its
team's on the server: it can add rules and tighten the team's, and a field that would relax a
team rule (a lower mode, fewer agents, another match) is ignored and the team's value is used.
`doctor`, `policy check`, the hooks and `policy test` all use the result. A file given with
`--config` or `SELFHOST_CONFIG` is used as it is.

`selfhost policy` works on the rules in `selfhost.toml` (found like `doctor` does, or
`--config`). See [`packages/policy`](../../packages/policy/README.md) for how rules match.

- `selfhost policy check [--json]` validates the file and lists every rule and allow-list check
  with its mode. An invalid file exits 1 with one `selfhost.toml:7: rules[0].mode: message` line
  per error.
- `selfhost policy test [paths...] [--config <path>] [--json]` runs test cases against the
  policy, like OPA's tests, and exits 1 when a case fails or a file cannot run. Each failing case
  is printed with its file and line, the decision it expected and the one it got. Paths are test
  files or folders (every `*.test.toml` in them); with none, `selfhost.test.toml` next to
  `selfhost.toml` runs. The format is below.
- `selfhost policy test --tool <name> [--command] [--path] [--url] [--model] [--agent] [--team]`
  evaluates one made-up tool call and prints the rules that fire and the decision, for trying a
  rule before it ships. `--path` is relative to the repository root; an MCP server is read from
  an `mcp__<server>__<tool>` name.
- `selfhost policy test --replay <file> [--team]` runs recorded tool calls through the policy and
  prints how many get each decision, how often each rule fires and the calls it fires on. The
  file is a JSON array or JSON Lines of tool calls (`{"tool": "Bash", "command": "npm publish"}`,
  with the same fields as the flags above) or ledger events, of which only `tool.called` counts.
  `--from-ledger [--since 7d] [--limit 100] [--repo <dir>]` does the same for the newest tool
  calls of this repository in the ledger (`--database` / `--data-dir` as for `spend`). Replays
  write nothing.
- `selfhost policy observe [--since 30d] [--repo <dir>] [--team <name>]` evaluates the tool calls
  already in the ledger (the one `selfhost import` writes, or `--database` / `--data-dir`) that
  belong to the repository and records one `policy.evaluated` event per hit, with the git commit
  and SHA-256 of the policy file. It prints, per rule, how many hits are new and how many an
  earlier run already recorded. Nothing is stopped and nothing leaves the machine.

`selfhost packages check "<command>" [--timeout <ms>] [--json]` runs the package guard
([`packages/package-guard`](../../packages/package-guard/README.md)) on one shell command the
way the pre-tool hook does: every npm, pnpm, yarn, bun, pip, uv, poetry, pipx, cargo and go
install in it is checked against `selfhost.toml` `[packages]` and the registries, and each
package is printed as ok, blocked, flagged, unchecked, allowed or skipped, with why. It exits 1
when a package would be blocked, whatever the mode. Lookups are cached in
`~/.selfhost/cache/packages`; `--timeout` (default 10000) is how long it waits on the registries.

`selfhost policy promote <rule> [--team <name>] [--to observe|off] [--reason <text>] [--config <path>]`
sets a rule's mode in `selfhost.toml` (default `enforce`) and prints the file's `git diff`. Only
the `mode` line changes, or one line is added after the rule's `id`, so comments and formatting
stay as they are. With `--team` the mode goes into `[teams.<name>.rules.<rule>]`, added at the
end of the file when missing. Nothing is staged or committed: the change is reviewed in a pull
request like any other. A rule already in that mode is left alone (exit 0), and an edit that
would not parse is never written. Each change is also recorded in the decision log (below) as
one decision by the repository's git email: `approve` when the rule moves to enforce,
`override` otherwise, with `--reason` as the reason. When the file found is the pulled team
policy, promote refuses: that copy is replaced on the next sync, so the team policy is changed in
the team's repository or on the server. `selfhost policy report` reads the pulled team policy like
the other commands.

`selfhost policy report [--since 7d] [--config <path>] [--json]` reads the observe-mode
`policy.evaluated` events from the ledger (`--database` / `--data-dir` as for `spend`) and lists,
per rule, how many tool calls it would have blocked or sent for approval, in how many sessions,
the most frequent calls and the likely false positives: a path rule that names no tool matching
a read-only tool, and a command rule matching only inside quotes, a comment or the arguments of
echo, grep or rg. The window is whole UTC days through today. `--json` prints the
`selfhost.review_item/v1` item of kind `policy_report`; its id depends only on the window, so
the same week gives the same item.

`selfhost policy compile [--vendor <name...>] [--target <vendor@version...>] [--out <dir>] [--apply] [--team <name>] [--json]`
compiles the rules into each vendor's own controls (see
[`packages/compile`](../../packages/compile/README.md)): a Claude Code `managed-settings.d`
fragment, Codex `requirements.toml` with a managed hook script, Cursor's enterprise `hooks.json`,
team rule text and MCP allowlist, and Copilot's enterprise `managed-settings.json` with the
GitHub API call that stores it. Files go to `--out` (default `.selfhost/compiled` in the
repository) and it prints a table of every rule per vendor: `compiled` (the vendor's settings
cover every call the rule matches), `partial`, `none` (the vendor can't express it) or `n/a`,
with `+hook` where the selfhost hook checks the rest, then each gap and why. Nothing is
installed. `--apply` writes `.ruler/selfhost-policy.md` and runs Ruler in the repository to
update `AGENTS.md` and `CLAUDE.md` (refusing when they were written by hand and there is no
`.ruler/` yet), makes the GitHub API call when `--github-org` and `GITHUB_TOKEN` are given, and
prints the `sudo install` commands for the system paths. selfhost never runs those itself.

`selfhost policy compile --managed [--root <dir>] [--force]` installs the system files at the
paths each vendor reads on this platform, wherever the user running it may write:

| Vendor      | macOS                                                                      | Linux                                               | Windows                                                        |
| ----------- | -------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| Claude Code | `/Library/Application Support/ClaudeCode/managed-settings.d/selfhost.json` | `/etc/claude-code/managed-settings.d/selfhost.json` | `C:\Program Files\ClaudeCode\managed-settings.d\selfhost.json` |
| Codex       | `/etc/codex/requirements.toml` and `/etc/codex/hooks/selfhost-hook`        | the same                                            | `C:\ProgramData\OpenAI\Codex\requirements.toml`                |
| Cursor      | `/Library/Application Support/Cursor/hooks.json`                           | `/etc/cursor/hooks.json`                            | `C:\ProgramData\Cursor\hooks.json`                             |
| Copilot     | `/Library/Application Support/GitHubCopilot/managed-settings.json`         | `/etc/github-copilot/managed-settings.json`         | `C:\Program Files\GitHubCopilot\managed-settings.json`         |

A file that is already what the policy compiles to is left as it is, and every write goes
through a temporary file and a rename. Where the user may not write, it prints the exact
`sudo install` command (PowerShell `Copy-Item` on Windows) and never runs it or asks for
elevation. A file there that selfhost did not write (its hash is not in
`~/.selfhost/managed/known.json`) is left alone and reported as a conflict, with the command
that would replace it; `--force` replaces it. `--root` writes under a folder instead of `/`, for
images and checks. Per-user files (Cursor's `~/.cursor/permissions.json`) and dashboard text are
not installed here; device management delivers them.

`selfhost policy package --mdm jamf|kandji|intune [--out <dir>] [--team <name>]` writes a bundle
to `--out` (default `.selfhost/mdm/<tool>`): self-contained scripts that carry every file
base64-encoded with its sha256 and write only files that differ, `files/` with plain copies,
`manifest.json` and a short `README.txt` that says where each script goes. Jamf gets
`install.sh` and `extension-attribute.sh` (prints `current <version>` or `pending <n>`), Kandji
`audit.sh` and `remediation.sh`, Intune `install.sh` for macOS and `install.ps1` with
`detect.ps1` (Remediations) for Windows. Per-user files go into every home folder. A `.pkg`,
signing and configuration profiles are not built; no vendor account is needed.

### Context: `selfhost context`

`selfhost context compile [--agent <name...>] [--out <dir>] [--check] [--force] [--json]` compiles
the rules, skills, commands, subagents and MCP servers in `.selfhost/context/` (next to
`selfhost.toml`; see [`packages/context`](../../packages/context/README.md)) into each agent's own
files in the repository: `CLAUDE.md` and `.claude/`, `AGENTS.md`, `.agents/skills`, `.codex/`,
`.cursor/`, `.github/` instructions, prompts and agents, `GEMINI.md` and `.gemini/`, `opencode.json`
and `.opencode/`, `.goosehints` and `.mcp.json`. Rules files are written through Ruler. It prints
a table of every item per agent: `compiled`, `partial`, `none` (the agent can't express it) or
`n/a`, with `n/a*` where an agent reads an item that is not for it, then each gap and why.
`--agent` (claude, codex, cursor, copilot, gemini, opencode, goose) sets the agents; later runs
keep them. `--out` writes into another folder instead. A file selfhost did not write is never
replaced without `--force`, and nothing is written then. `.selfhost/context.lock.json` records
every generated file with its source and the skill version each agent received; commit it with
the files. When the repository has `.selfhost/context`, `selfhost policy compile --apply` writes
`.ruler/selfhost-policy.md` and lets the context compile write the rules files, so both end up in
them.

`selfhost context check [--json]` (or `context compile --check`) writes nothing and exits 1 when a
generated file differs from what `.selfhost/context` compiles to, saying which file and whether it
was edited by hand (move the change into the source), is out of date or missing (run `selfhost
context compile`), or is no longer compiled. Run it in CI. An invalid source fails both commands,
with each problem's file and line.

#### Layers: org, team, repository, personal

Both commands merge four layers, in this order: the org's and the team's (pulled from the team
server by `selfhost join` and every sync into `~/.selfhost/context/org/<org>/` and
`~/.selfhost/context/team/<team>/`), the repository's `.selfhost/context/`, and your own items in
`~/.selfhost/context/personal/` (same layout: `rules/`, `skills/`, `commands/`, `agents/`,
`mcp.json`). Later layers add items. When two layers have the same item (or a skill and a command
share a name) the earlier layer's is used, so the org's items are a floor nothing replaces, and
the output names every item that lost (`layer_conflicts` with `--json`). A repository with no
`.selfhost/context` compiles the other layers alone. `--no-layers` compiles the repository's
layer only, as CI has it. The merged files are per person when team or personal layers are in
use; a repository that commits its generated files should commit what `--no-layers` writes.

A team's memory store (claude-mem or any other) is an MCP server like the rest: put it in the
team layer's `mcp.json` and every member's agents get it.

- `selfhost context push <dir> [--org <org>]` sets the team's layer from a folder in the
  `.selfhost/context` layout (an owner or admin of the team, or the admin token), or with
  `--org` the org's (admin token only). It takes `--server`, `--team` and `--token` like
  `team invite`. Members get it on their next sync.
- `selfhost context propose <kind:name> [--team <id>]` sends one of your personal items (such as
  `rule:no-secrets` or `mcp:notes`) to the team. It stays personal until an owner or admin
  approves the review item it opens, with `selfhost inbox approve <id>` or in the console; a
  member's answer, a deny or a newer proposal of the same item leaves the team layer as it was.
  An item the org or team layer already has cannot be proposed.
- Every sync pulls the layers; when they changed, it compiles again each repository whose
  context was compiled with them on this machine, and says so. A repository with a problem, or
  a file selfhost did not write in the way, is left as it is with the reason.

### Policy test files

A test file is TOML: an optional `config`, the `selfhost.toml` it tests relative to the test file,
and one `[[cases]]` table per tool call. Without `config`, `strict.test.toml` tests `strict.toml`
beside it, and otherwise the nearest `selfhost.toml`; `--config` overrides both for every file.

```toml
config = "selfhost.toml"

[[cases]]
name = "npm publish waits for a person"
command = "npm publish --access public"   # tool defaults to Bash
decision = "ask"                          # allow, ask or block
mode = "enforce"                          # optional: enforce or observe
rules = ["package-publish"]               # optional: exactly these rules fire

[[cases]]
name = "reading source is fine"
tool = "Read"
path = "src/app.ts"
decision = "allow"
```

A case takes the call fields `tool`, `command`, `path`, `url`, `model` and `agent`, plus `team` to
apply that team's overrides. The decision is what selfhost decides on the call: enforce hits
decide first (block when one blocks, else ask, in mode enforce); with none, observe hits decide
the same way in mode observe, where the call goes through and the verdict is only recorded; with
no hit at all it is allow. `--json` prints `selfhost.policy_tests/v1` with every case's expected
and actual decision and its hits.

### Presets

[`presets/`](../../presets) holds four starting points, each with its own test file. Every one
starts with the editor schema line below and sets the built-in guardrails in its `[guardrails]`
section (enforced; `irreversible` leaves `git reset --hard` to an observe rule).

| Preset         | What it enforces                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startup`      | Live payments, production databases and migrations, and tearing down infrastructure. Publishes, deploys, emails and shell habits start in observe. |
| `strict`       | Every rule: payments, production, publishes, deletes and secret reads are blocked, the rest asks. MCP allow list, 7 day package age, merge check.  |
| `oss`          | Package publishes, releases and tags, changes to published packages, GitHub comments, merges, workflow runs and repository settings.               |
| `irreversible` | Only payments, emails, production data, publishes and infrastructure. Everything else is observe.                                                  |

`selfhost init --preset <name>` writes one as `selfhost.toml`; teams fork the file from there.
The presets are embedded in the CLI by `pnpm --filter @selfhost/cli embed-presets`
(`src/init/presets.generated.ts`), and a test fails when that file is stale, when a preset does
not validate against the JSON Schema, or when its test file fails or leaves a rule untested.

### Editor completion

Every `selfhost.toml` selfhost writes starts with

```toml
#:schema https://selfhost.ai/schema/selfhost.toml.v1.json
```

which points TOML language servers that read JSON Schema (Taplo, used by the Even Better TOML
extension for VS Code) at the published schema, `packages/schema/json/config.schema.json`. They
then complete keys and values and underline invalid ones as you type.

## Decision log

Every human answer on agent work goes into the ledger as one `decision.recorded` event, through
the same call the server's `POST /v1/decisions` uses (see
[`@selfhost/ledger`](../../packages/ledger/README.md#decisions)). Both commands use the local
ledger (`--database` / `--data-dir` as for `spend`).

- `selfhost decide <item-or-run> approve|deny|answer|override [--reason <text>]` records your
  answer on a review item (a UUIDv7) or a run (anything else): the CLI inbox's write. `--question`,
  `--path` (repeatable, relative to where you are), `--rule` and `--pr` say what it was about.
  Decisions are never edited: `--replaces <decision-id>` records a correction or overturn as a
  new decision linked to the old one, carrying over what it was about. You are `--person`, else
  the person this laptop joined a team as, else `SELFHOST_PERSON`, else the git email.
- `selfhost decisions [--path <file-or-folder>] [--topic <words>] [--rule <id>] [--person <id>]`
  prints past decisions and rule verdicts, newest first, as plain text: each one's id, verdict,
  who, the question and reason, files and links, and which later decisions replaced it.
  `--path` matches the file, files inside a folder, and folders that hold the file; `--topic`
  needs every word in the question or reason. `--limit` and `--cursor` page through.

## Review list

`selfhost review list [--state open|answered|dismissed|expired] [--owner <person>] [--json]`
brings the review list in the local ledger up to date (`--database` / `--data-dir` as for
`spend`) and prints it: what needs a person, blocking first, then by risk, then oldest first.
Routing and the approval timeout come from the `selfhost.toml` the other commands find. `--limit`
and `--cursor` page through. Answer an item with `selfhost review approve|deny <id> [--reason
<text>]` (the same as `selfhost inbox approve|deny`) or `selfhost decide <item-id>
approve|deny|answer`; the next `review list` shows it answered. See [`packages/review`](../../packages/review/README.md).

## Inbox

`selfhost inbox [--all] [--json]` lists the review items waiting on you, ranked like the review
list (blocking first, then by risk, then oldest), each with the shortest id prefix that tells it
apart. `--all` lists every open item, other people's and the ones you snoozed included. Act on
one by its id, or any unique start of it:

- `selfhost inbox approve <id> [--reason <text>]` and `selfhost inbox deny <id> [--reason
  <text>]` answer the item. The review list records each answer as one `decision.recorded`
  event in the decision log: the team server in team mode, the local ledger in solo mode. The
  inbox writes no event of its own, so nothing is recorded twice. An item someone else already
  answered is reported (`... was already answered by bob@example.com: deny. Nothing changed.`)
  and exits 1. Approve and deny (here, under `selfhost review` and `selfhost decide`) are a
  person's: they refuse inside a coding agent's session (`CLAUDECODE`, `CODEX_SANDBOX` and the
  like are set) and when stdin is not a terminal, and the hooks block an agent that runs them.
- `selfhost inbox snooze <id> [--for 2h | --until <time>]` hides an item from your list until
  then (default 1h; `--for` takes m, h, d or w).
- `selfhost inbox open <id> [--no-open]` prints the item with its risk reasons and brief, and
  opens its link with the OS opener (`open`, `xdg-open`) when stdout is a terminal. `--no-open`
  and `--json` never open it, and only http and https links are opened.
- `selfhost inbox sync` sends the actions queued offline, then refreshes the saved copy. It
  exits 1 while actions stay queued.

Team mode calls the server's `/v1/review-items` API with the person token from `selfhost join`;
solo mode reads the review list in the local ledger (`--database` / `--data-dir` as for `spend`).

Offline, the inbox keeps working. Every list saves your open items to `~/.selfhost/inbox.json`.
When the team server does not answer (or a proxy answers 502, 503 or 504), `selfhost inbox` and
`open` read that copy and say how old it is, and approve, deny and snooze append the action to
`~/.selfhost/inbox-queue.jsonl` (mode 0600) instead (`outcome: "queued"`). Queued answers leave
the list and the statusline count right away. The next inbox command that reaches the server,
`selfhost inbox sync`, or a running `import --watch` sends the queue first, in the order the
actions were taken. An item someone else answered in the meantime is reported (`Not applied:
approve 019a5b01, already answered by bob@example.com: deny.`, `outcome: "conflict"` with
`--json`) and dropped, never applied. A missing item or an action the server refuses is dropped
with the reason; a refused token or a server error stops the replay and keeps the rest queued.
In solo mode, while `import --watch` holds the embedded ledger, the inbox reads the copy the
watcher saves and queues actions for the watcher to apply within a minute.

## Notifications: `selfhost notify`

Alerts and digests on your phone, in chat or by email, delivered by
[Apprise](https://github.com/caronc/apprise): any of its 100+ URL types is a target, so Telegram,
Slack, email, Teams, Discord or ntfy is a different URL, not different code.

- `selfhost notify add <apprise-url> [--name <name>]` adds a target, such as
  `tgram://<bot token>/<chat id>`, `slack://...`, `mailtos://...` or `ntfys://<topic>`. Pass
  `-` to read the URL from stdin and keep it out of shell history. The URL holds a secret, so it
  is never printed back: lists show its name and `tgram://****`.
- `selfhost notify [list]`, `selfhost notify remove <name>`, and `selfhost notify test
  [--name <name>]`, which sends a test to each target and exits 1 when one fails.
- `selfhost notify digest daily|weekly|off` picks how often your digest comes (default
  `[notify] digest` in `selfhost.toml`, daily at `[notify] digest_hour` UTC; weekly on Mondays).

An agent that waits on you (an approval, a question) is pushed at once; everything else on your
review list comes in the digest. Budget alerts at 50%, 80% and 100% of `[budget]` go to the
budget owners, who also get a daily spend digest: top spenders, fastest-growing teams and runs
that hit their cap. A message holds a summary written by selfhost and a link to the item in the
console, where you answer it; never code, a diff, a prompt or a secret.

In team mode the server keeps the targets and sends through its Apprise (`compose.notify.yml`,
see [`deploy/docker`](../../deploy/docker/README.md#notifications)). In solo mode the local
ledger keeps them and `selfhost import` sends through the `apprise` command when it is on PATH
(`pipx install apprise`); without it, import says so in one line and sends nothing. Solo import
also raises the 50%, 80% and 100% budget alerts from this laptop's own spend against `[budget]`
in the repository's `selfhost.toml`, and prints each one (`Budget alert: You spent 80% of the
day's budget of $20`).

## Risk score

`selfhost review risk <pr-number | --base <ref>> [--head <ref>] [--tests passed|failed|not-run]
[--json]` scores an agent pull request low, medium or high and prints the PR label
(`selfhost:risk-low`, `-medium` or `-high`) and the `selfhost/risk` check result: a title, a
summary of what set the level and what was missing, and a table of every input with its points.
A number reads the pull request through the developer's own `gh` login (read-only); `--base`
scores the local commits since the merge base instead. The agent run, guardrail blocks and
outside effects come from the ledger when there is one (`--database` / `--data-dir` as for
`spend`), the revert rate and the touched modules' revert and rework rates from git, and `--tests` stands in for the sandbox result until sandbox
runs exist. Nothing is posted to GitHub. The scoring is commercial code in
[`ee/risk`](../../ee/risk/README.md), loaded only when this command runs.

## Agent-written code: `selfhost provenance`

`selfhost provenance [--since 30d] [--until <when>] [--branch <ref>] [--vendor-stats <file>]
[--no-github] [--json]` prints the lines merged to the main branch in the window by agent and
model (with the agent runs behind them), by module (ranked by agent-written lines, flagged above
`[review] revert_rate_threshold`) and by person, and how many were reverted or reworked within
`[review] revert_window_days` of merge. Fix-forward edits count as rework. Commits are joined
to the runs the ledger recorded (`--database` / `--data-dir` as for `spend`), to their own
attribution, and to merged pull requests from the ledger and, unless `--no-github`, the
developer's own `gh`. `--vendor-stats` takes vendor-reported line counts (Cursor AI Code
Tracking, Claude Code Analytics) as `VendorLineStat` JSON and shows them next to the git
numbers. `selfhost scan` adds one line of the same numbers, and an HTML section with the
module table. Definitions are in [`packages/provenance`](../../packages/provenance/README.md).

## Review brief

`selfhost review brief <pr-number | --base <ref>> [--head <ref>] [--json]` prints the review
brief for an agent pull request as the Markdown comment the GitHub delivery posts: the task, the
plan, the lines to look at (protected paths, new dependencies, deleted or skipped tests, each
linked to its line in the diff), the files touched, the commands and tests run with their
results, blocked actions with their rule ids, the cost and a link to each session's trace. Every
section is present and says so when the run has nothing for it. `--json` prints the brief as
`selfhost.review_brief/v1`. It reads the change as `review risk` does (the developer's `gh`,
read-only, or the local commits since `--base`), the run from the ledger (`--database` /
`--data-dir`) and `[review] high_risk_paths` from `selfhost.toml`. Trace links point at the team
server when this machine joined one, else at `selfhost review trace <session> [--json]`, which
prints every event of one session, oldest first. Apache-2.0: it works without `ee/`. See
[`@selfhost/brief`](../../packages/brief/README.md).

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

## Install on a laptop: `selfhost init`

`selfhost init [--since 30d] [--team <invite>] [--server <url> | --hosted] [--agent claude codex]
[--preset <name>] [--import-context | --no-import-context] [--dry-run] [--json]` goes from nothing
to real data on the first screen. Its one question, asked only in a terminal, is whether to import
the context files; `--import-context` and `--no-import-context` answer it, and `--yes`, `--json`
and `--dry-run` never ask (the files are then only listed). [`AGENTS.md`](AGENTS.md) and
[`llms.txt`](llms.txt) say the same for a coding agent doing the install.

1. With `--team`, it joins first. The invite is `--team <invite>` with `--server <url>` or
   `--hosted` (`SELFHOST_HOSTED_URL`, else `https://app.selfhost.ai`), or the whole line `selfhost
   team init` prints, pasted as is. A refused invite or an unreachable server exits 1 before any
   file is written.
2. It lists the agents it finds and where each keeps its config, then adds a hook running
   `selfhost hook <agent>` to Claude Code and Codex through `agents configure`, which backs up
   every file first. When `selfhost` is not on PATH the hook calls the running node and script
   by absolute path instead. An agent where `agents configure` already set other settings is
   left alone, so they are not taken out.
3. It writes a starter `selfhost.toml` at the git repository root when none is found: four
   rules (`.env` files, force pushes, `rm -rf` on `/` or home, `curl | sh`), all in observe
   mode. `--preset startup|strict|oss|irreversible` writes that preset instead (see
   [Presets](#presets)). An existing file is kept, also with `--preset`. In team mode no
   starter is written, since the team's policy applies; a preset is still written when asked
   for, and adds to the team's policy.
4. It lists the context files the scan finds and offers to copy the repository's into the one
   context source, `.selfhost/context/` (`rules/`, `skills/`, `commands/`, `agents/`,
   `mcp.json`). The repository's own instruction files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`,
   `.goosehints`, `.github/copilot-instructions.md`) become rules for every agent; a file in one
   agent's rules folder (`.cursor/rules`, `.claude/rules`, `.github/instructions`) keeps the
   agents that read it in its `agents` front matter, and an `agents` list in the file's own front
   matter wins. A nested `CLAUDE.md` or `AGENTS.md` becomes a rule with a `globs` for its folder,
   and exact copies become one rule. Each file the import moved into the source that `selfhost
   context compile` writes (such as `CLAUDE.md`, `AGENTS.md`, `.mcp.json` or a skill in
   `.claude/skills`) is recorded in `.selfhost/context.lock.json` with its hash, so the next
   compile replaces it with the compiled copy without `--force`. A file whose content was not
   all imported (another file was in the way, an MCP server set up differently elsewhere, a
   secret swapped for a reference) is not handed over. The originals are never edited or deleted, a file already in
   `.selfhost/context/` is never replaced, and home files and `CLAUDE.local.md` stay where they
   are. Secret-looking MCP env and header values are written as `${NAME}` references, and a
   server with a secret in its command, args or url is left out.
5. It imports the window, runs `policy observe` when there is a `selfhost.toml`, and prints the
   import counts, spend by agent and request type, and the hits per rule. `--json` prints one
   `selfhost.init/v1` object instead.

`--dry-run` prints the same plan, with the number of log files and hook events it would import,
and writes nothing. `selfhost init --undo` puts every agent config file init changed back byte
for byte from its backup (recorded in `~/.selfhost/init.json`) and deletes the context files it
imported, unless a file was edited since;
`agents configure --remove` takes the same settings out but writes the file in its own layout.
The ledger, `selfhost.toml` and a team membership are kept.

`selfhost hook <agent>` (`claude`, `codex`, `codex-notify`, `cursor` or `opencode`) is what the
agents run on each hook event. It reads the payload from stdin (the last argument for
`codex-notify`), appends one line `{agent, received_at, payload}` to
`~/.selfhost/spool/hooks-<UTC day>.jsonl` with a single append, and exits 0 even when that fails.
Tool output and file contents (`tool_response`, and Cursor's `output` and `content`) are
dropped. It never opens the ledger, since the embedded database takes one process at a time and
agents run hooks concurrently. Pre-tool events also get an answer on stdout (see
[Guardrails](#guardrails-selfhost-guard)); every other event prints nothing, except Cursor's
`beforeSubmitPrompt`, which gets `{"continue":true}` because Cursor reads a silent hook as a
block. `selfhost import` (and `--watch`, every poll) maps the spool into the ledger with the hook
mappers: ids come from the receive time and the payload, so a line read twice is a duplicate, a
malformed line is skipped and counted, and a finished day's file is deleted once imported.

## Moving from Conductor: `selfhost migrate conductor`

`selfhost migrate conductor [--repo <path...>] [--history <export>] [--force] [--dry-run]
[--json]` reads each repository's Conductor settings and writes them into the `[runtime]` section
of its `selfhost.toml`, which the runtime plugin reads to set up, run and clean up each agent
workspace. Without `--repo` it migrates the git repository it runs in. Conductor's own files are
read, never written: the report hashes them before and after.

- Source: `.conductor/settings.toml` (or `.json`), else the legacy `conductor.json`, which
  Conductor ignores once the first exists. `.conductor/settings.local.toml` holds one machine's
  overrides and can hold secrets, so it is listed with its keys (never values) and not moved.
  Scripts set only in the Conductor app are kept by the app, not the repository; the command says
  so when it finds no settings file.
- `scripts.setup` and `scripts.archive` become `setup` and `archive`, each action in
  `scripts.run` (or the single `run` string, as `dev`) becomes `[runtime.run.<name>]` with its
  `command`, `options.cwd` as `cwd`, `args` appended and `default`, `run_mode` keeps `concurrent`
  and turns `nonconcurrent` into `exclusive`, and `environment_variables` become `[runtime.env]`.
  Values that look like secrets or emails are not copied: `selfhost.toml` is shared.
- `CONDUCTOR_WORKSPACE_NAME`, `CONDUCTOR_WORKSPACE_PATH`, `CONDUCTOR_ROOT_PATH`,
  `CONDUCTOR_DEFAULT_BRANCH` and `CONDUCTOR_PORT` are renamed to their `SELFHOST_*` twins in the
  commands. Script files the commands run (such as `./script/setup.sh`) are never edited: when one
  reads a Conductor name, `[runtime.env]` keeps that name, set from the selfhost variable.
  `CONDUCTOR_IS_LOCAL`, `CONDUCTOR_BASE_DIR`, `CONDUCTOR_API_*` and `CONDUCTOR_SESSION_ID` have no
  selfhost value and are listed with why.
- Everything else (icons, `available_in`, `hide`, prompts, git and provider settings, preview
  links, files to copy) is listed by key with the reason it was not moved, and keys Conductor's
  schema does not have are listed as unknown.

An existing `selfhost.toml` keeps every byte; `[runtime]` goes at the end. A file with a
different `[runtime]` is left as is (exit 1) unless `--force` replaces that section in place. A
second run with the same settings changes nothing. `--dry-run` prints the plan and the diff and
writes nothing. `selfhost migrate conductor --undo` puts each `selfhost.toml` back byte for byte
(recorded in `~/.selfhost/migrate.json`), unless it was edited since.

`--history <path>` imports workspace history into the ledger (`--database` / `--data-dir`):
an unpacked export folder or one JSON or JSON Lines file. Conductor does not publish the format
of its account export (Settings, Account, Export data), so the importer reads JSON shaped like
the objects of Conductor's published API wherever they sit: workspaces, sessions with their
transcript messages, pages of `GET /v0/sessions/{id}/messages` and rows of `POST /v0/sql`. Each
session becomes `session.started` and `session.ended` with `run_id: conductor:<workspace id>`,
and each prompt a `prompt.submitted` with `--prompts`. Tool calls and token usage are not read
from the export: local workspaces' agents already logged them where `selfhost import` reads
them. A second import adds nothing. Without `--history` it says no history was imported and
finishes the rest; an export with no session in a known shape exits 1 after the scripts are
moved. See [`packages/importers`](../../packages/importers/README.md#conductor-history).

## Guardrails: `selfhost guard`

The guardrails pack blocks destructive and secret-leaking tool calls in every agent with a
pre-tool hook, with no account or server:

```sh
selfhost guard install     # add the pre-tool hook to each agent found (--agent, --dry-run, --json)
selfhost guard status      # which agents are covered and which guardrails are on
selfhost guard uninstall   # take out what install added
```

`guard install` adds `selfhost hook <agent>` to the events that can stop a tool call, through
`agents configure`'s planner under its own profile (`~/.selfhost/agents/<agent>.guard.json`, and
its own `# >>> selfhost guard >>>` block in Codex's `config.toml`), with a backup of each file.
So it installs and uninstalls apart from `selfhost init`; a hook init already added counts as
installed and is left in place by `guard uninstall`.

| Agent       | Hook                                                                                                   | Block       | Ask                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------ | ----------- | ----------------------------------------------------- |
| Claude Code | `PreToolUse` in `~/.claude/settings.json`                                                              | yes         | yes                                                   |
| Codex       | `PreToolUse` in `config.toml` (or `hooks.json`); approve it with `/hooks`                              | yes         | answered as a block: Codex hooks cannot ask           |
| Cursor      | `preToolUse`, `beforeShellExecution`, `beforeReadFile`, `beforeMCPExecution` in `~/.cursor/hooks.json` | yes         | on shell and MCP calls; elsewhere answered as a block |
| OpenCode    | plugin `~/.config/opencode/plugins/selfhost.js` (`tool.execute.before`)                                | yes         | answered as a block                                   |
| Goose       | none: Goose has no hooks                                                                               | not covered | not covered                                           |

On a pre-tool event the hook finds `selfhost.toml` from the call's folder (the nearest one up to
the repository root, else the team policy pulled by the last sync, else the built-in defaults),
checks the call against its rules, `[mcp]` and `[models]`, the built-in guardrails and any extra
checkers, and answers in the agent's own format: deny or ask with the reason (see [Errors that
teach](#errors-that-teach)), or nothing at all for allow on Claude Code and Codex, so selfhost
never approves a call the agent would otherwise ask about (Cursor gets `{"permission":"allow"}`,
since a silent permission hook blocks there). Rules and guardrails in observe mode are recorded and never applied. Cursor sends
shell, read and MCP calls to `preToolUse` and then to their own event: `preToolUse` blocks them
but leaves allow and ask, and the record, to the dedicated event.

The built-in guardrails, each with a stable rule id, block by default (`[guardrails]` in
[`selfhost.toml`](../../packages/schema/README.md#guardrails)): `guard.force_push` (including
`-f` and `+refspec`; `--force-with-lease` asks), `guard.reset_hard`, `guard.rm_outside_workspace`
(recursive rm of a path outside the repository root and the temp folders, or of the workspace
or home folder itself; a path that cannot be resolved before it runs asks), `guard.secret_read`
(`.env` files, private keys and credential files, through file tools and shell readers),
`guard.prod_sql` (DROP or TRUNCATE in a command that names a connection marked in
`prod_connections`) and `guard.prod_credentials` (variables, profiles and files marked in
`prod_credentials`). What each one matches, and the known ways around them, are in
[`packages/policy`](../../packages/policy/README.md#guardrails).

Every pre-tool decision, allow included, goes on the event's spool line and becomes one
`policy.evaluated` event on the next `selfhost import`: `decision` (`verdict`, `rule_id`, `mode`,
`reason`, `policy_hash`), the agent, session, tool and target (masked like every ledger write),
and `data` with `answer` (`allow`, `deny` or `ask`, what the agent was told), every hit,
`tool_event_id` when the payload also maps to a `tool.called` event, the policy file's path and
the time the check took. An allowed call with an observe hit records that hit's verdict in
observe mode, as `policy observe` does.

A broken setup never stops the agent. The rules of a `selfhost.toml` that does not parse or
validate are skipped and the built-in guardrails run with their defaults, so the baseline still
holds; an extra checker that throws or runs past its 2 second budget is skipped; any other error
answers allow. Each case is printed on stderr and recorded on the decision (`data.failures`,
`data.fail_open`). The check adds about 20 ms to a pre-tool hook (about 40 ms in all, measured
cold with the bundled `node dist/main.js`; a block, which also writes its exception request, is
about 1 ms more); other events are not slowed, as only pre-tool events load it.

### Errors that teach

Every block and ask says which rule fired, why, and what to do instead, with a link to the rule:
its line in `selfhost.toml` (`/path/to/selfhost.toml:12`) for a repository rule, `[mcp]` or
`[models]`, else the docs of the built-in check (the guardrails table in
[`packages/policy`](../../packages/policy/README.md#guardrails), the rules table in
[`packages/package-guard`](../../packages/package-guard/README.md#rules-and-verdicts)). The why
is the rule's `message`, the alternative its `alternative` (every guardrail and package check
has one), and a rule's `docs` URL is linked too. A block also names a review item that allows
the call once (below). The agent's text adds: do not retry this call or a variant of it, take
the alternative, or ask the user to approve the exception and then make the identical call
again.

| Agent       | What the model reads                   | What the person sees                                      |
| ----------- | -------------------------------------- | --------------------------------------------------------- |
| Claude Code | `permissionDecisionReason` of a deny   | `systemMessage`; an ask's reason in the permission prompt |
| Codex       | `permissionDecisionReason` of a deny   | `systemMessage`, shown as a warning                       |
| Cursor      | `agent_message`                        | `user_message` (the only text `beforeReadFile` takes)     |
| OpenCode    | the error the plugin throws (`reason`) | the same error on the tool call                           |

```text
selfhost blocked this call under rule guard.force_push: Force pushes rewrite shared history and can drop commits other people pushed.
Instead: Push your commits to a new branch and open a pull request. If this branch really has to be rewritten, ask the user first; git push --force-with-lease is the safer form.
Do not retry this call, or a variant of it, to get around the rule: it will be blocked again. Take the alternative above, or, if this exact call is needed, ask the user to approve one-time exception 019a5b01-.... Only a person can approve it, in their own terminal or the console; do not run the approval yourself. Once they approve, make the identical call again and it is allowed once.
Rule: https://github.com/getselfhostai/selfhost/blob/main/packages/policy/README.md#guardrails
```

### One-time exceptions

A person can allow one blocked call, once. Nothing here opens the ledger in the hook:

1. The hook blocks a call and writes a request to `~/.selfhost/exceptions/requests/<id>.json`:
   the review item id it names to the agent and the person, the call's fingerprint and the rule
   ids, never the command. The id also goes on the spool line.
2. `selfhost import` (or `--watch`) maps the line to the `policy.evaluated` block event with
   `data.exception` and `links.item_id`; the review list (local, or the team server after sync)
   opens an `exception` item under that id, routed like any other item, titled `Allow once:
   <call>` with secrets masked. The call was already denied and the agent went on, so the item
   is not blocking and has no timeout (an agent that makes its case over MCP and waits makes it
   blocking). On a team server it goes to the team's owners and admins, and the person whose
   agent was blocked cannot approve it unless `[review] self_approve_exceptions = true`. A retry
   of the same call replaces it with the new id. In solo mode
   `selfhost inbox` and `selfhost review list` read blocked calls from the spool first, so the
   item is there right after the block.
3. A person approves or denies it: `selfhost inbox approve <id>`, `selfhost review approve <id>`,
   `selfhost decide <id> approve`, or the server's API. The answer is a `decision.recorded` event.
4. The machine that asked turns the approval into a grant, `~/.selfhost/exceptions/grants/<id>.json`:
   right away when the person approves there, else on its next `selfhost inbox`, `selfhost
   import` (team mode: the sync reads each of its waiting requests with `GET
   /v1/review-items/{id}`) or `import --watch` refresh. Only this machine's own requests turn into
   grants. A grant is signed and expires `[review] exception_expiry_minutes` (default 30) after
   the approval.
5. The next identical call (same agent, tool, command with white space evened out, file and
   access, URL, MCP server, repository root and agent session), stopped only by rules the exception covers,
   uses the grant: the hook moves it to `used/`, which only one hook can do, so two calls at once
   cannot both get through. It answers allow (Claude Code and Codex also show the person a
   `systemMessage`) and records the use: a `policy.evaluated` allow under the rule, with
   `data.exception.used` and the decision's id. The call after that is blocked again.

So the ledger holds the request, the approval and the use. The fingerprint is an HMAC-SHA256
with a per-machine key (`~/.selfhost/exceptions/key`, mode 0600), which also signs grants, so
neither says anything about the command and a grant cannot be written by hand; reading the key
is blocked by `guard.secret_read`. An agent that can run any code as you can still read it, as
with the guardrails' other known bypasses. A failure in these files never loosens a block: the
call stays blocked, without the exception part.

## Solo and team modes

selfhost starts in solo mode: everything stays on the laptop and no command sends a request to
a selfhost server. Team mode connects the same install to a shared server
([`apps/server`](../server/README.md#teams)):

```sh
selfhost team init --server https://selfhost.example.com --name Platform   # admin token: --token or SELFHOST_TOKEN
selfhost join https://selfhost.example.com selfhost_inv_...                 # on each laptop
selfhost status
selfhost team invite --email bob@example.com --ttl 2d                      # owner or admin
selfhost team revoke bob@example.com                                       # owner or admin
selfhost team role bob@example.com admin                                   # owner
selfhost team repo add https://github.com/acme/api.git                     # owner or admin
selfhost team laptops                                                      # who runs which config version
selfhost team leave
```

- `selfhost team init [--invite-ttl 7d]` creates a team with the server's admin token (`--token`,
  else `SELFHOST_TOKEN`, else the one `selfhost up` saved for that server) and
  prints the `selfhost join` command to share. The invite expires after `--invite-ttl` (30m,
  12h, 7d and so on, up to 365d; default 7d). It does not join the machine it runs on.
- `selfhost team invite [--email <email>] [--ttl 7d]` creates another invite. With `--email`
  only that person can join with it, and they join under that email whatever `--person` says
  otherwise. A team-wide invite only adds new people: joining with it as someone already in the
  team, the owner included, is refused, so a second machine for the same person needs
  `selfhost team invite --email <person>`. `selfhost team revoke <invite>` revokes an invite code; `selfhost team revoke
  <person>` revokes every token the person holds (all their machines) and the open invites for
  their email. Their events stay. Both take `--server` and `--team`, which default to the team
  this machine joined, and the admin token like `team init` does, else this machine's person
  token, whose role in the team the server checks.
- `selfhost team role <person> <owner|admin|member>` changes a person's role (owners only; a
  team always keeps an owner), `selfhost team add <person> [--role]` adds someone already in
  another team of the org, `selfhost team people` lists the team and its roles, and `selfhost
  team repo add|remove|list [remote]` gives a repo to the team by its remote URL, so its runs,
  spend and review items are the team's. They take the same flags as `team invite`. A refused
  call prints the server's permission error, such as `Permission denied: Changing roles needs
  the owner role in team platform; you are an admin there.`, and exits 1.
- `selfhost join <url> <invite> [--person <id>] [--name <name>]` exchanges the invite for a
  person token and adds `server`, `token`, `person` and `team` to `~/.selfhost/config.json`
  (mode 0600), and nothing else: no vendor login or API key is asked for or stored. `--person`
  defaults to the git email, the same person `selfhost import` uses. A refused invite changes
  no files. It then pulls the org and team context layers; `selfhost context compile` in a
  repository gives the agents the merged result. It also pulls the team policy and installs its
  managed settings the way `selfhost policy compile --managed` does: where it may not write, it
  stages a copy in `~/.selfhost/managed/` and prints the exact `sudo install` command, and it
  never escalates by itself. `--no-managed` skips the install; syncs still report the files.
  Then it sends this laptop's first heartbeat.
- `selfhost import` keeps writing the local ledger, then syncs: the first sync after joining
  sends the whole local ledger, so solo history shows up on the server with no migration; later
  syncs resend the `--since` window. Event ids are idempotency keys, so a resend stores nothing
  twice. Sends go in batches of up to 1000 to `POST /v1/events`, retried with exponential
  backoff (0.5 s doubling, 4 retries, honouring `Retry-After`) when the server is unreachable,
  rate limiting or failing; a refused batch is not retried. Person events go up as the joined
  person, the only one the server accepts for the token; the local ledger keeps them as they
  were imported. The sync also pulls the team's `selfhost.toml` into
  `~/.selfhost/team-policy.toml` and the org and team context layers (see
  [Layers](#layers-org-team-repository-personal)). A failed sync keeps the local import, reports the error and
  exits 1; the next sync sends the events. `--watch` sends each batch after the local write,
  and a batch that fails is kept and sent again on the next poll. After pulling, each sync
  installs the managed settings the new policy compiles to (printing the command for any that
  need an admin) and sends a heartbeat when what it says changed or the last one is an hour old.
- A heartbeat is a `config.reported` event with `data.heartbeat` (`selfhost.laptop_heartbeat/v1`):
  a random laptop id kept in `~/.selfhost/machine.json`, the host name, platform and CLI version,
  the team policy hash it runs (its config version) and whether its managed files are current,
  pending, off or none. `selfhost team laptops [--silent-days 7]` lists every laptop of the team
  from the newest heartbeat of each, flagged `behind` (another policy hash than the team's),
  `silent` (nothing for `--silent-days`) or `not installed` (managed files pending or off), and
  the people with no heartbeat from any laptop. The console's Team screen shows the same list.
- `selfhost status` shows solo or team, the server, the person, the last sync and the team
  policy hash, from local files only. Sync progress is in `~/.selfhost/sync.json`.
- `selfhost team policy push [file]` checks a `selfhost.toml` (default: this repository's) and
  makes it the team's policy (owners and admins; the server checks the role, and it refuses
  inside an agent session); `selfhost team policy show` prints it and `selfhost team policy pull
  [file] [--force]` writes it to a file. `selfhost status` points at push when no team policy
  was pulled yet.
- `selfhost team leave` revokes this machine's person token on the server, then removes the
  membership, the pulled team policy and the pulled context layers (your personal layer stays)
  and goes back to solo mode. When the server cannot be
  reached, the membership is still removed and the output says the token keeps working there
  until an admin runs `selfhost team revoke <person>` (`token_revoked: false` with `--json`).
  The local ledger is not touched.

The CLI calls only the configured server, and only its `/v1` API. Agents keep calling their
vendors directly; no model traffic goes through selfhost.

Every command takes `--json` and prints one object with a `schema` tag: `selfhost.doctor/v1`,
`selfhost.init/v1`, `selfhost.init_undo/v1`, `selfhost.import/v1` (plus one `selfhost.import_batch/v1` line per batch with `--watch`),
`selfhost.ledger_prune/v1`, `selfhost.ledger_status/v1`, `selfhost.ledger_migrate/v1`, `selfhost.ledger_backup/v1`,
`selfhost.ledger_restore/v1`, `selfhost.agents/v1`, `selfhost.agents_configure/v1`, `selfhost.scan/v1`,
`selfhost.policy_check/v1`, `selfhost.policy_test/v1`, `selfhost.policy_tests/v1`,
`selfhost.policy_replay/v1`, `selfhost.policy_observe/v1`,
`selfhost.policy_promote/v1`, `selfhost.review_item/v1` (from `policy report`),
`selfhost.decide/v1`, `selfhost.review_risk/v1`, `selfhost.review_brief/v1`,
`selfhost.review_trace/v1`, `selfhost.review_list/v1`, `selfhost.decisions/v1`,
`selfhost.inbox/v1`, `selfhost.inbox_action/v1`, `selfhost.inbox_item/v1`,
`selfhost.inbox_sync/v1`,
`selfhost.limit_forecast/v1`, `selfhost.plan_tiers/v1`, `selfhost.spend_alarms/v1`,
`selfhost.team_init/v1`, `selfhost.team_invite/v1`, `selfhost.team_revoke/v1`,
`selfhost.team_role/v1`, `selfhost.team_add/v1`, `selfhost.team_people/v1`, `selfhost.team_repos/v1`,
`selfhost.team_laptops/v1`, `selfhost.policy_compile/v1`, `selfhost.mdm_bundle/v1` (from `policy package`),
`selfhost.join/v1`, `selfhost.status/v1`, `selfhost.context_compile/v1`, `selfhost.context_push/v1`,
`selfhost.context_propose/v1`, `selfhost.team_leave/v1`, `selfhost.integrations/v1` and `selfhost.up/v1`. Errors print `selfhost.error/v1` and exit 1. In solo mode no command
needs a network connection, except `selfhost integrations check`, which calls the tools named in
`[integrations]` to test them.

## Integrations: `selfhost integrations`

The router, tracer, runtime and reviewer the team picked, from `[integrations]` in
`selfhost.toml`, and whether each one is connected:

```sh
selfhost integrations                                  # list (same as: selfhost integrations list)
selfhost integrations check                            # test each tool; exits 1 on a failure
selfhost integrations set runtime e2b --setting template=base
selfhost integrations set router litellm --setting url=http://litellm:4000 --setting admin_key_env=LITELLM_MASTER_KEY
selfhost integrations set tracer langfuse --setting endpoint=https://cloud.langfuse.com/api/public/otel --setting headers_env.Authorization=LANGFUSE_OTLP_AUTH
selfhost integrations set reviewer none                # remove the reviewer
```

- In team mode the team server keeps the choice and runs the checks with its own environment, so
  `list` already shows each status. `set` needs the owner or admin role; a member gets the
  server's permission error and exit 1.
- In solo mode (or with `--config <path>`) the choice is the `selfhost.toml` found here. `list`
  reads the file only. `check` calls each tool from this machine, with the variables in this
  shell, and reads `.github/workflows` of this checkout for PR-Agent and the Claude Code action;
  CodeRabbit's installation cannot be seen from a laptop, so its check fails here with a link to
  check by hand. `set` rewrites only that table of the file and refuses settings that would make
  it invalid.
- A failing check says what to fix, for example `Set the environment variable E2B_API_KEY
  (api_key_env) where selfhost runs, to an E2B API key. It is not set.` Secrets are named by
  variable in `selfhost.toml`, never written there, and never printed.
- `--setting key=value` repeats; a dotted key such as `headers_env.Authorization=VAR` sets one
  entry of a table. `--json` prints `selfhost.integrations/v1`: `team` (null in solo mode),
  `source` (the server or the file) and per job `tool`, `status`, `detail` and `settings`;
  `status` and `detail` are null for a solo `list`, which checks nothing.

Each tool and its check are in [`packages/integrations`](../../packages/integrations).

## Team server: `selfhost up`

```sh
selfhost up --provider hetzner --people 8 --dry-run   # the plan and the cloud-init user-data
selfhost up --provider hetzner                        # HCLOUD_TOKEN
selfhost up --provider digitalocean                   # DIGITALOCEAN_TOKEN
selfhost up --provider aws --region eu-central-1      # the aws CLI v2, signed in
selfhost up --provider ssh --host ubuntu@203.0.113.10 [-i key] [--port 22]
```

Sets up the team server (the ledger API, the review list and the console) with the Docker Compose
stack in [`deploy/docker`](../../deploy/docker/README.md#selfhost-up): HTTPS through Caddy, only
ports 22, 80 and 443 open, a daily backup kept `--backup-keep-days` (14) on the server, and with
`--signin github|google` console sign-in through oauth2-proxy (`SELFHOST_SIGNIN_CLIENT_ID`,
`SELFHOST_SIGNIN_CLIENT_SECRET`, and `--allow-email`, `--allow-domain` or `--github-org`). Agents
keep running where they are and no model traffic goes through the server. `--gateway` also runs
the AI gateway (Bifrost) next to it; see [AI gateway](#ai-gateway-selfhost-gateway).

- Size: `--people` and `--events-per-day` pick a server: 2 vCPU and 4 GB up to 15 people and
  50,000 events a day (Hetzner `cx23`, else `cpx22`; DigitalOcean `s-2vcpu-4gb`; AWS
  `t3.medium`), 4 vCPU and 8 GB up to 60 people, 8 vCPU and 16 GB beyond. `--size` overrides it.
- HTTPS name: `--domain`, else `<ip>.sslip.io` (sslip.io resolves it to the IP, so there is no
  DNS to set up), or the SSH host when it is a DNS name.
- Clouds go through their APIs with `fetch` (Hetzner, DigitalOcean) or the `aws` CLI (AWS, so the
  binaries carry no AWS SDK and profiles and SSO work). SSH uses the system `ssh` with
  `BatchMode`, so a key that needs a password prompt fails fast.
- No secret goes in user-data: `install.sh` generates the tokens and passwords on the server.
- Image: `--image <image>:<tag>`, else `ghcr.io/getselfhostai/selfhost` at `SELFHOST_VERSION`
  of `deploy/docker/.env.example`, the one place the release tag is set. Before anything is
  created, the registry is asked anonymously (a manifest HEAD) whether the tag exists; a tag
  that is not there, or a registry that cannot be asked, stops it with nothing made.
  `--skip-image-check` deploys a private image the check cannot see.
  When the server answers `/v1/health`, `selfhost up` connects over SSH, writes the OAuth client
  secret to `.env` (mode 0600) when sign-in is asked for, and reads back the admin and agent
  tokens. It then creates team `--team` (default `default`; `--no-team` skips it), prints the
  `selfhost join` line, and with `--join` joins this machine. The server, what was created and
  the admin token are saved under `deployments` in `~/.selfhost/config.json` (mode 0600), where
  `selfhost team init|invite|revoke` find the token.
- On any failure it exits 1 and lists every resource created so far with the command that
  deletes it (`resources` in the `selfhost.error/v1` object with `--json`). Missing credentials
  and failed SSH connections stop before anything is created.

## AI gateway: `selfhost gateway`

```sh
selfhost gateway                          # health, the team's hard limits, your key and what is left
selfhost gateway keys                     # the team's keys and limits, never their values (owners, admins)
selfhost gateway connect claude-code      # issue your key, write it into ~/.claude/settings.json
selfhost gateway connect codex            # or opencode, goose: the provider in their own config
selfhost gateway disconnect               # put every file connect changed back, byte for byte
selfhost gateway connect env --run run-42 # print a key for one background run, for 24 hours
```

The team server configures an AI gateway: the bundled Bifrost (`selfhost up --gateway`, see
[`deploy/docker`](../../deploy/docker/README.md#ai-gateway)) or a LiteLLM proxy the team already
runs (`[integrations.router] tool = "litellm"` with `url` and `admin_key_env` in the server's
`selfhost.toml`). The gateway holds the provider keys; people and runs get virtual keys, one per
person, per team and per run, each named `selfhost:<kind>:<team>:<who>`.

- Budgets: `[budget]` in the team's `selfhost.toml`. With `mode = "hard"` the team's
  `daily_usd`, `weekly_usd` and `monthly_usd` go on the gateway's team, `[budget.person]` on each
  person's key and `run_usd` on each run's key, and the gateway refuses requests once one is
  spent. With `mode = "alert"` (the default) nothing is set on the gateway; spend is shown and
  alerted. A spent budget is also written to the ledger as `alert.raised` (`budget_exceeded`,
  which the review list shows), and each refused request as `gateway_budget_exceeded`.
- Every five minutes the server writes teams, budgets, providers and on or off to the gateway
  (only what differs) and reads its request logs into the ledger as `cost.recorded` events with
  `source = "gateway"`, attributed to the key's person, team and run, so spend views and the
  forecast include them. A person whose tokens are revoked has their key turned off.
- A key's value is shown once, to the person it is for (`connect`), and kept nowhere. `connect
  --rotate` gives a new one. Provider keys never leave the gateway.
- `connect <agent>` writes the gateway and the key into the agent's own config, with a
  `.selfhost-backup-*` copy of each file it changes and a record in
  `~/.selfhost/gateway-connect.json`; `disconnect [agent]` (or `connect <agent> --undo`) puts
  each file back byte for byte while it still holds what connect wrote, and says where the
  backup is when it does not. `--print` prints the settings to paste instead.
  - `claude-code`: `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` in the `env` block of
    `~/.claude/settings.json`. `--managed` prints a `managed-settings.d/selfhost-gateway.json`
    file instead, for an admin to install: managed settings win over every project's.
  - `codex`: `model_provider = "selfhost"` and `model_providers.selfhost` (`base_url`,
    `experimental_bearer_token`) in a marked block at the top of `~/.codex/config.toml`.
  - `opencode`: `baseURL` and `apiKey` on the `anthropic` and `openai` providers in
    `opencode.json`.
  - `goose`: a custom provider, `custom_providers/selfhost.json`, picked with
    `goose session --provider selfhost` or made the default in `goose configure`.
  - `env` prints `ANTHROPIC_*` and `OPENAI_*` exports for anything built on those SDKs.
  - Settings that would take traffic past the gateway (a provider or key the user set, Claude
    Code's `apiKeyHelper` or `ANTHROPIC_API_KEY`) stop it before a key is issued.
- Cursor and GitHub Copilot send model traffic from their own servers and can't use a gateway:
  `connect cursor` and `connect copilot` change nothing and say their usage is read from the
  vendor's admin API.
- Subscription logins (Claude plans, ChatGPT plans) go straight to the vendor, so the gateway's
  budgets and usage cover API key traffic only. For an agent signed in that way, `connect`
  changes nothing and issues no key; `--api-billing` sends it through the gateway on API
  billing anyway. Which CLI versions connect works on is on the
  [compatibility page](../../docs/compatibility/index.html#gateway-connect).

## Binaries

`pnpm build:cli` compiles standalone binaries with `bun build --compile` into `dist/`:
`selfhost-linux-x64`, `selfhost-linux-arm64`, `selfhost-darwin-arm64` and `selfhost-darwin-x64`.
Pass target names to build a subset, for example `pnpm build:cli bun-darwin-arm64`.

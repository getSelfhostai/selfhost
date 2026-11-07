# @selfhost/cli

The `selfhost` command line.

```sh
pnpm --filter @selfhost/cli dev --version
pnpm --filter @selfhost/cli dev doctor [--config path/to/selfhost.toml]
pnpm --filter @selfhost/cli dev spend --since 7d --by request_type,model
pnpm --filter @selfhost/cli dev ledger prune --days 30
pnpm --filter @selfhost/cli dev policy check
pnpm --filter @selfhost/cli dev policy test --tool Bash --command "git push --force"
pnpm --filter @selfhost/cli dev policy observe --since 30d
pnpm --filter @selfhost/cli dev review risk --base main
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

`selfhost ledger prune [--days <n>] [--config <path>] [--json]` deletes events older than the
retention from the ledger (the one `selfhost import` writes, or `--database` / `--data-dir`):
`--days`, else `ledger.retention_days` in `selfhost.toml` (found like `doctor` does), else 90.
`selfhost import` keeps prompt text only with `--prompts`, and masks secrets and emails either
way; the ledger drops prompt text from any import without it.

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
`SELFHOST_CONFIG`, then the nearest file from the current directory up to the repository root,
then, on a machine in a team, the team policy pulled into `~/.selfhost/team-policy.toml`) and
validates it. It exits 1 when the file is invalid. When both a repository file and a pulled
team policy exist, the repository file is used and `doctor` and `policy check` name the team
policy that is not.

`selfhost policy` works on the rules in `selfhost.toml` (found like `doctor` does, or
`--config`). See [`packages/policy`](../../packages/policy/README.md) for how rules match.

- `selfhost policy check [--json]` validates the file and lists every rule and allow-list check
  with its mode. An invalid file exits 1 with one `selfhost.toml:7: rules[0].mode: message` line
  per error.
- `selfhost policy test --tool <name> [--command] [--path] [--url] [--model] [--agent] [--team]`
  evaluates one made-up tool call and prints the rules that fire, for trying a rule before it
  ships. `--path` is relative to the repository root; an MCP server is read from an
  `mcp__<server>__<tool>` name.
- `selfhost policy observe [--since 30d] [--repo <dir>] [--team <name>]` evaluates the tool calls
  already in the ledger (the one `selfhost import` writes, or `--database` / `--data-dir`) that
  belong to the repository and records one `policy.evaluated` event per hit, with the git commit
  and SHA-256 of the policy file. It prints, per rule, how many hits are new and how many an
  earlier run already recorded. Nothing is stopped and nothing leaves the machine.

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

## Risk score

`selfhost review risk <pr-number | --base <ref>> [--head <ref>] [--tests passed|failed|not-run]
[--json]` scores an agent pull request low, medium or high and prints the PR label
(`selfhost:risk-low`, `-medium` or `-high`) and the `selfhost/risk` check result: a title, a
summary of what set the level and what was missing, and a table of every input with its points.
A number reads the pull request through the developer's own `gh` login (read-only); `--base`
scores the local commits since the merge base instead. The agent run, guardrail blocks and
outside effects come from the ledger when there is one (`--database` / `--data-dir` as for
`spend`), the revert rate from git, and `--tests` stands in for the sandbox result until sandbox
runs exist. Nothing is posted to GitHub. The scoring is commercial code in
[`ee/risk`](../../ee/risk/README.md), loaded only when this command runs.

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
[--dry-run] [--json]` goes from nothing to real data on the first screen, with no questions
asked (`--yes` is accepted and changes nothing). [`AGENTS.md`](AGENTS.md) and
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
   mode. An existing file is kept.
4. It imports the window, runs `policy observe` when there is a `selfhost.toml`, and prints the
   import counts, spend by agent and request type, and the hits per rule. `--json` prints one
   `selfhost.init/v1` object instead.

`--dry-run` prints the same plan, with the number of log files and hook events it would import,
and writes nothing. `selfhost init --undo` puts every agent config file init changed back byte
for byte from its backup (recorded in `~/.selfhost/init.json`), unless it was edited since;
`agents configure --remove` takes the same settings out but writes the file in its own layout.
The ledger, `selfhost.toml` and a team membership are kept.

`selfhost hook <agent>` (`claude`, `codex` or `codex-notify`) is what the agents run on each hook
event. It reads the payload from stdin (the last argument for `codex-notify`), appends one line
`{agent, received_at, payload}` to `~/.selfhost/spool/hooks-<UTC day>.jsonl` with a single
append, and exits 0 even when that fails, printing nothing on stdout. Tool output
(`tool_response`) is dropped. It never opens the ledger, since the embedded database takes one
process at a time and agents run hooks concurrently. `selfhost import` (and `--watch`, every
poll) maps the spool into the ledger with the hook mappers: ids come from the receive time and
the payload, so a line read twice is a duplicate, a malformed line is skipped and counted, and a
finished day's file is deleted once imported.

## Solo and team modes

selfhost starts in solo mode: everything stays on the laptop and no command sends a request to
a selfhost server. Team mode connects the same install to a shared server
([`apps/server`](../server/README.md#teams)):

```sh
selfhost team init --server https://selfhost.example.com --name Platform   # admin token: --token or SELFHOST_TOKEN
selfhost join https://selfhost.example.com selfhost_inv_...                 # on each laptop
selfhost status
selfhost team invite --email bob@example.com --ttl 2d                      # admin token
selfhost team revoke bob@example.com                                       # admin token
selfhost team leave
```

- `selfhost team init [--invite-ttl 7d]` creates a team with the server's admin token and
  prints the `selfhost join` command to share. The invite expires after `--invite-ttl` (30m,
  12h, 7d and so on, up to 365d; default 7d). It does not join the machine it runs on.
- `selfhost team invite [--email <email>] [--ttl 7d]` creates another invite. With `--email`
  only that person can join with it, and they join under that email whatever `--person` says
  otherwise. A team-wide invite only adds new people: joining with it as someone already in the
  team, the owner included, is refused, so a second machine for the same person needs
  `selfhost team invite --email <person>`. `selfhost team revoke <invite>` revokes an invite code; `selfhost team revoke
  <person>` revokes every token the person holds (all their machines) and the open invites for
  their email. Their events stay. Both take the admin token like `team init` does, and
  `--server` and `--team`, which default to the team this machine joined.
- `selfhost join <url> <invite> [--person <id>] [--name <name>]` exchanges the invite for a
  person token and adds `server`, `token`, `person` and `team` to `~/.selfhost/config.json`
  (mode 0600), and nothing else: no vendor login or API key is asked for or stored. `--person`
  defaults to the git email, the same person `selfhost import` uses. A refused invite changes
  no files.
- `selfhost import` keeps writing the local ledger, then syncs: the first sync after joining
  sends the whole local ledger, so solo history shows up on the server with no migration; later
  syncs resend the `--since` window. Event ids are idempotency keys, so a resend stores nothing
  twice. Sends go in batches of up to 1000 to `POST /v1/events`, retried with exponential
  backoff (0.5 s doubling, 4 retries, honouring `Retry-After`) when the server is unreachable,
  rate limiting or failing; a refused batch is not retried. Person events go up as the joined
  person, the only one the server accepts for the token; the local ledger keeps them as they
  were imported. The sync also pulls the team's `selfhost.toml` into
  `~/.selfhost/team-policy.toml`. A failed sync keeps the local import, reports the error and
  exits 1; the next sync sends the events. `--watch` sends each batch after the local write,
  and a batch that fails is kept and sent again on the next poll.
- `selfhost status` shows solo or team, the server, the person, the last sync and the team
  policy hash, from local files only. Sync progress is in `~/.selfhost/sync.json`.
- `selfhost team leave` revokes this machine's person token on the server, then removes the
  membership and the pulled team policy and goes back to solo mode. When the server cannot be
  reached, the membership is still removed and the output says the token keeps working there
  until an admin runs `selfhost team revoke <person>` (`token_revoked: false` with `--json`).
  The local ledger is not touched.

The CLI calls only the configured server, and only its `/v1` API. Agents keep calling their
vendors directly; no model traffic goes through selfhost.

Every command takes `--json` and prints one object with a `schema` tag: `selfhost.doctor/v1`,
`selfhost.init/v1`, `selfhost.init_undo/v1`, `selfhost.import/v1` (plus one `selfhost.import_batch/v1` line per batch with `--watch`),
`selfhost.ledger_prune/v1`, `selfhost.agents/v1`, `selfhost.agents_configure/v1`, `selfhost.scan/v1`,
`selfhost.policy_check/v1`, `selfhost.policy_test/v1`, `selfhost.policy_observe/v1`,
`selfhost.policy_promote/v1`, `selfhost.review_item/v1` (from `policy report`),
`selfhost.decide/v1`, `selfhost.review_risk/v1`, `selfhost.decisions/v1`,
`selfhost.team_init/v1`, `selfhost.team_invite/v1`, `selfhost.team_revoke/v1`,
`selfhost.join/v1`, `selfhost.status/v1` and `selfhost.team_leave/v1`. Errors print `selfhost.error/v1` and exit 1. In solo mode no command
needs a network connection.

## Binaries

`pnpm build:cli` compiles standalone binaries with `bun build --compile` into `dist/`:
`selfhost-linux-x64`, `selfhost-linux-arm64`, `selfhost-darwin-arm64` and `selfhost-darwin-x64`.
Pass target names to build a subset, for example `pnpm build:cli bun-darwin-arm64`.

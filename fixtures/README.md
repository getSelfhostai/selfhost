# Fixtures

Test inputs for the session importers, hook ingest, ledger source mappers and redaction. Sessions are synthetic: their line shapes mirror real Claude Code and Codex logs observed in November 2026, and all content is invented (project `acme-api` at `/home/dev/acme-api`, user `dev`, emails at `example.com`). Each vendor folder has a `manifest.json` with the CLI versions observed and one line per file.

| Folder | Holds |
| --- | --- |
| `claude-code/projects/-home-dev-acme-api/` | 3 Claude Code sessions (`~/.claude/projects` layout) across 2026-10-05, 06, 08 and 09 UTC: Read, Edit, Write, Bash, a failing test, git commits, two models. |
| `codex/sessions/YYYY/MM/DD/` | 3 Codex rollouts (`~/.codex/sessions` layout) on 2026-10-05, 07 and 09 UTC: exec_command, apply_patch, git commits, token_count events, a model switch between turns. Folder dates use local time. |
| `hooks/claude-code/` | One stdin payload per Claude Code hook event. |
| `hooks/codex/` | Codex `notify` payload and one payload per documented Codex hook event. |
| `sources/` | Synthetic OpenTelemetry logs, LiteLLM gateway request logs and Anthropic Compliance API style activity, for the ledger source mappers, plus two weeks for the waste detector: a Claude Code OpenTelemetry week where the status line is 16.4% of spend, and a subscription-only week of local logs. `manifest.json` describes each file. |
| `github/` | Synthetic `gh api` responses for repository `acme/acme-api` (pull requests, reviews, review comments, commits, and for `ee/risk` one pull request's files and manifests), laid out by API path, for `packages/attribution`: merged, closed, open, unreviewed, large-diff and conflicting pull requests, plus `webhooks/` with review and comment deliveries for the decision mapper. `manifest.json` describes each one. |
| `risk/` | `selfhost.toml` with protected paths and irreversible rules, and `cases.json`: risk score inputs with the level, score and missing inputs each must give, one or more per acceptance criterion of the PR risk score, for `ee/risk`. |
| `redaction/` | Planted fake secrets and an example.com email. The files hold `{{kind}}` placeholders and `manifest.json` keeps each value in parts; `planted.ts` joins them at test time, so the repository carries no key-shaped string. |
| `markers/` | One Claude Code session and one Codex rollout with marker strings planted in prompts, replies, reasoning, code, commands, tool output and commit messages. `selfhost scan` must print none of them. `manifest.json` lists every marker. |
| `expected/` | ccusage daily totals for the session fixtures. |
| `captured/` | Scrubbed real sessions, written by `scripts/capture-fixtures.mjs`. Absent until someone runs it. |

## Checks

```sh
node scripts/scrub-check.mjs          # scans fixtures/ except redaction/, also fails on JSON that does not parse
```

It fails on secret-shaped strings, emails outside example.com (agent and GitHub service addresses such as noreply@anthropic.com are allowed), home paths other than `/home/dev`, macOS home and temp paths, and (outside CI) the local username or hostname.

## Regenerate expected outputs

Point ccusage at the fixtures with an empty `HOME`, so it reads nothing else on the machine:

```sh
empty=$(mktemp -d)
export npm_config_cache="$HOME/.npm"
HOME=$empty CLAUDE_CONFIG_DIR=fixtures/claude-code npx -y ccusage@20.0.48 claude daily --json --offline -z UTC > fixtures/expected/ccusage-claude-daily.json
HOME=$empty CODEX_HOME=fixtures/codex npx -y ccusage@20.0.48 codex daily --json --offline -z UTC > fixtures/expected/ccusage-codex-daily.json
HOME=$empty CLAUDE_CONFIG_DIR=fixtures/claude-code CODEX_HOME=fixtures/codex npx -y ccusage@20.0.48 daily --json --offline -z UTC > fixtures/expected/ccusage-all-daily.json
```

Days are grouped in UTC. Bump the pinned ccusage version only on purpose and record it in the vendor manifests.

## Capture real sessions

On a laptop with both CLIs signed in:

```sh
node scripts/capture-fixtures.mjs --count 3
```

It copies the newest sessions, keeps structure, ids, timestamps, token counts, model ids and CLI versions, masks all text, rewrites paths to `/home/dev/project-N`, and runs the scrub check on the result. Read the output before committing it.

Never commit a key-shaped value, even a fake one: GitHub push protection blocks it once the
repository is public. Add a placeholder and the value's parts to `redaction/manifest.json`, or
join the parts in the test.

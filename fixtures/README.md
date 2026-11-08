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
| `brief/` | Review brief runs for `packages/brief`: `agent-pr.json` (every section filled: protected paths, a new dependency, deleted and skipped tests, two sessions recorded by hooks, OpenTelemetry and the local logs, a failed then passing test run, an enforced and an observed block, a team server), `no-run.json` (no session, no description, no `high_risk_paths`: every section says why it is empty) and `local.json` (local commits off GitHub, prompts not stored, no tests). Files carry their patch as GitHub returns it; events are ledger events. `github/` holds the `gh api` responses for pull request 142, with patches. |
| `registries/` | Real deps.dev, npm registry, PyPI, crates.io index, Go module proxy and osv.dev responses recorded on 2026-11-08 for `packages/package-guard`, trimmed to the fields it reads: packages that pass, invented names no registry has, packages too new for a 60 day minimum age, install scripts, an sdist-only PyPI release and a known malicious npm package. `manifest.json` describes each one; `pnpm --filter @selfhost/package-guard capture` records them again. |
| `risk/` | `selfhost.toml` with protected paths and irreversible rules, and `cases.json`: risk score inputs with the level, score and missing inputs each must give, one or more per acceptance criterion of the PR risk score, for `ee/risk`. |
| `redaction/` | Planted fake secrets and an example.com email. The files hold `{{kind}}` placeholders and `manifest.json` keeps each value in parts; `planted.ts` joins them at test time, so the repository carries no key-shaped string. |
| `markers/` | One Claude Code session and one Codex rollout with marker strings planted in prompts, replies, reasoning, code, commands, tool output and commit messages. `selfhost scan` must print none of them. `manifest.json` lists every marker. |
| `compile/` | `selfhost.toml` with one rule for each way a rule compiles, and per vendor config version (`<vendor>/<version>/`) the files `packages/compile` writes from it plus `coverage.json` and `install.json`. `rules/<ruler version>/` holds the `AGENTS.md` and `CLAUDE.md` Ruler writes from the policy text, saved as `.out` files. |
| `guardrails/` | `selfhost.toml` and `cases.json`: tool calls (shell commands, file reads and writes, MCP calls) with the verdict and rule each must get from the pre-tool check. Tests in `packages/policy` replay them as agent-neutral calls and tests in `apps/cli` through every agent's own pre-tool payload and `selfhost hook`, so each agent reaches the same decision. `{workspace}` and `{home}` are filled with temporary folders. |
| `context/` | A repository (`repo/`) and a home folder (`home/`) of agent context files for the context drift and cost report in `selfhost scan` and the import in `selfhost init`: a near copy (`CLAUDE.md` and `AGENTS.md`), exact copies (`GEMINI.md` and `.github/copilot-instructions.md`, and one skill in `~/.claude/skills` and `~/.codex/skills`), a pnpm and npm conflict, Node 22 against Node 20, vitest against jest, Biome against Prettier, an MCP server two configs start differently, and Cursor rules no other agent reads. Git here skips files named `CLAUDE.md` and `CLAUDE.local.md` and folders named `.claude`, so they are stored as `CLAUDE.md.fixture`, `CLAUDE.local.md.fixture` and `_claude/`; `apps/cli/test/context-fixture.ts` copies them to their real names in a temporary folder and adds the `claude-code/` and `codex/` sessions, working in that repository, for the cost. |
| `expected/` | ccusage daily totals for the session fixtures. |
| `conductor/` | Synthetic Conductor repositories (`.conductor/settings.toml` with every documented script field, a machine-local override, a legacy `conductor.json`, script files that read `CONDUCTOR_*` variables, an existing `selfhost.toml`) and a workspace history export shaped like Conductor's published API objects, for `selfhost migrate conductor`. `manifest.json` names the Conductor docs each one follows; Conductor's own export format is not published. |
| `cloud/` | Hetzner Cloud and DigitalOcean API responses for `selfhost up`, from the examples in each provider's published OpenAPI document. `manifest.json` names the source of each file. |
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

## Compile golden files

`packages/compile/test/golden.test.ts` compiles `compile/selfhost.toml` for every version in
`VENDOR_VERSIONS` (`packages/compile/src/versions.ts`) and fails when a generated file drifts from
its folder. When a vendor CLI ships a release that changes its config:

1. Check the vendor's docs (cited at the top of `packages/compile/src/vendors/<vendor>.ts`) and
   update the mapping, gating new syntax on the version with `atLeast(version, "x.y.z")`.
2. Add the version to `VENDOR_VERSIONS`, then write its folder and review the diff:

```sh
UPDATE_GOLDEN=1 pnpm --filter @selfhost/compile test
git diff fixtures/compile
```

Bumping the pinned Ruler in `pnpm-workspace.yaml` needs `RULER_VERSION` changed to match; the
same command writes `compile/rules/<new version>/`, and the old folder is deleted by hand. A
vendor version dropped from `VENDOR_VERSIONS` loses its folder the same way.

## Capture real sessions

On a laptop with both CLIs signed in:

```sh
node scripts/capture-fixtures.mjs --count 3
```

It copies the newest sessions, keeps structure, ids, timestamps, token counts, model ids and CLI versions, masks all text, rewrites paths to `/home/dev/project-N`, and runs the scrub check on the result. Read the output before committing it.

Never commit a key-shaped value, even a fake one: GitHub push protection blocks it once the
repository is public. Add a placeholder and the value's parts to `redaction/manifest.json`, or
join the parts in the test.

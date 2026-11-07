# @selfhost/attribution

Links commits and pull requests to the coding agent and model that produced them, and reports
merged versus closed rate, time to merge, review comments and unreviewed merges per agent and
model. Commits pushed with no pull request are attributed the same way.

```ts
import {
  attributionStats,
  ghCliSource,
  readCommits,
  readPulls,
  toLedgerEvents,
} from "@selfhost/attribution";

const since = new Date(Date.now() - 30 * 86_400_000);
const commits = await readCommits(repoDir, { since, sessions }); // sessions: SessionHint[], optional
const pulls = await readPulls("acme/acme-api", { since, commits, source: ghCliSource() });
const { byAgent } = attributionStats(commits, pulls);
await ledger.append(
  toLedgerEvents(commits, pulls, { actorId: "dev@example.com", repo: "acme/acme-api" }),
);
```

## Signals

Each record stores the agent, the model when known, and which signal matched. Strongest first:

| Signal              | Evidence                                                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `co_author_trailer` | A vendor's attribution in the message or body: a `Co-authored-by:` trailer with the agent's address, or the footer the vendor documents (`Generated with [Claude Code]`, `Generated with [Codex]`, `Made-with: Cursor`). |
| `session_id`        | A vendor session link (Claude Code `Claude-Session:`, Codex task, Cursor agent, OpenCode share, Amp thread, Devin session), or the id of a known session.                                                                |
| `bot_account`       | The commit or pull request author is an agent account: a GitHub App bot, or an agent's own git address such as `cursoragent@cursor.com`.                                                                                 |
| `branch_prefix`     | The branch starts with an agent prefix such as `claude/` or `codex/`.                                                                                                                                                    |
| `file_time_match`   | Lower confidence. A local session in the same repository edited at least one of the commit's files, and the commit was authored between the session's start and 30 minutes after its end.                                |

Rules:

- No signal, no agent. A record with no match stays unattributed; nothing is assigned by guess.
- The strongest signal decides. If it names several vendors, the one it names most often wins;
  a tie leaves the record unattributed. The model and session id come from evidence for the
  winning vendor. A co-author trailer and a footer from the same agent in one message count once.
- Trailers match on the email address, so a co-author who is a person named Claude is not an
  agent. Plain logins such as `Copilot` or `Claude` count only with GitHub's `type: "Bot"`, or
  with the account's known id in a noreply address.
- A bare session id counts only when it is a session passed to `readCommits` (or, in
  `readPulls`, a session one of `commits` was matched to), and only as a whole token. A link in
  a vendor's session URL format counts on its own, since the link names the vendor.
- On commits, a branch prefix counts only for commits that agent branches reach and no other
  branch does. A commit merged into main, or shared by two agents' branches, gets none.
- `file_time_match` needs the session's `cwd` inside the repository (symlinked paths such as
  `/tmp` and `/private/tmp` are the same place) and real file overlap. The session with the most
  overlapping files wins; equal overlap across vendors gives no match.
- The model comes from the trailer when the vendor writes one (Claude Code's
  `Claude Opus 4.5` becomes `claude-opus-4-5`; aider's `aider (<model>)` is kept as written),
  else from the matched session's `model`.

## What each agent leaves behind

`src/vendors.ts` holds the patterns, each with its source. "Observed" means seen in real commits
and pull requests but not in the vendor's docs.

| Agent (`vendor`)            | Trailer or footer                                                                                                                                                                                                                                       | Bot account                                                                                                                                               | Branch                                                                         | Session link                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Claude Code (`claude_code`) | `Co-Authored-By: <model> <noreply@anthropic.com>` and `Generated with [Claude Code](https://claude.com/claude-code)` ([settings](https://code.claude.com/docs/en/settings-reference))                                                                   | `claude[bot]` ([claude-code-action](https://github.com/anthropics/claude-code-action/blob/main/action.yml)), `anthropic-code-agent[bot]` (login `Claude`) | `claude/` ([routines](https://code.claude.com/docs/en/routines))               | `Claude-Session: https://claude.ai/code/session_...` ([cloud](https://code.claude.com/docs/en/cloud-environments)) |
| Codex (`codex`)             | `Co-authored-by: Codex <noreply@openai.com>` and `Generated with [Codex](https://openai.com/codex/)` ([git-attribution](https://github.com/openai/codex/blob/main/codex-rs/ext/git-attribution/src/world_state.rs)), off unless the account turns it on | `chatgpt-codex-connector[bot]` ([docs](https://developers.openai.com/codex/integrations/github)), `openai-code-agent[bot]` (login `Codex`)                | `codex/` (observed)                                                            | `chatgpt.com/codex/tasks/task_e_...` (observed)                                                                    |
| Cursor (`cursor`)           | `Made-with: Cursor` ([config](https://cursor.com/docs/cli/reference/configuration), text observed); cloud agents author as `Cursor Agent <cursoragent@cursor.com>` (observed)                                                                           | `cursor[bot]` (observed)                                                                                                                                  | `cursor/` ([API](https://cursor.com/docs/cloud-agent/api/endpoints))           | `cursor.com/agents/bc-...` ([API](https://cursor.com/docs/cloud-agent/api/endpoints))                              |
| Copilot (`copilot`)         | `Co-authored-by: Copilot <...+Copilot@users.noreply.github.com>` (Copilot CLI, observed)                                                                                                                                                                | `copilot-swe-agent[bot]`, login `Copilot` ([docs](https://docs.github.com/en/copilot/responsible-use/agents))                                             | `copilot/` ([docs](https://docs.github.com/en/copilot/responsible-use/agents)) | none                                                                                                               |
| OpenCode (`opencode`)       | none from the CLI                                                                                                                                                                                                                                       | `opencode-agent[bot]` (`packages/opencode/src/cli/cmd/github.ts`)                                                                                         | `opencode/`                                                                    | `opencode.ai/s/...`                                                                                                |
| Goose (`goose`)             | none documented                                                                                                                                                                                                                                         | none                                                                                                                                                      | none                                                                           | none; Goose commits are found by `file_time_match`                                                                 |
| Devin (`other`)             | depends on the repo's setting ([docs](https://docs.devin.ai/integrations/gh))                                                                                                                                                                           | `devin-ai-integration[bot]`                                                                                                                               | `devin/` (observed)                                                            | `app.devin.ai/sessions/...` (observed)                                                                             |
| Aider (`other`)             | `Co-authored-by: aider (<model>) <aider@aider.chat>` ([repo.py](https://github.com/Aider-AI/aider/blob/main/aider/repo.py))                                                                                                                             | none                                                                                                                                                      | none                                                                           | none                                                                                                               |
| Amp (`other`)               | `Co-authored-by: Amp <amp@ampcode.com>` ([settings](https://ampcode.com/docs/cli/settings))                                                                                                                                                             | none                                                                                                                                                      | none                                                                           | `Amp-Thread-ID: https://ampcode.com/threads/T-...`                                                                 |
| Jules (`other`)             | none                                                                                                                                                                                                                                                    | `google-labs-jules[bot]` ([docs](https://jules.google/docs/code))                                                                                         | none                                                                           | `jules.google.com/task/...` (observed)                                                                             |

The claude-code-action and the Copilot coding agent put the person who asked as the co-author,
so their commits match on the bot account and branch, not the trailer. Agents the ledger has no
vendor for (Devin, Aider, Amp, Jules) are `other`.

## Commits

`readCommits(repoDir, { since, sessions })` runs `git log` over every local and remote-tracking
branch with `--since` (committer date), `--numstat` and `-z`, parses the output as it streams
and returns commits newest first. Merge commits are left out. `files` are repository paths
(the new path for a rename); binary files count no lines. Settings that would change git's
output (`log.showSignature`, colors, external diff and textconv drivers) are turned off for the
run. One `git rev-list` per agent branch prefix finds the commits only agent branches reach.

## Pull requests

`readPulls(repo, { since, commits, source, largeDiffLines })` keeps pull requests created,
merged or closed at or after `since`. For each one it reads the full pull request, its reviews,
its review comments and its commits, and weighs the body, the author, the head branch, the
commits' messages and authors on GitHub, and the attribution `commits` already carry for the
same SHAs (which is how a file and time match reaches a pull request).

- `approvals`: people (not bots) whose latest approving or blocking review, submitted before the
  merge, approves. An approval followed by changes requested, or given after the merge, does not
  count.
- `reviewComments`: inline review comments from people. `issueComments` is GitHub's own count of
  conversation comments, bots included.
- `unreviewedMerge`: merged with no approval from a person, or approved with no review comments
  when additions plus deletions exceed `largeDiffLines` (default 300).

`GitHubSource` has five methods (`pulls`, `pull`, `reviews`, `reviewComments`, `commits`) that
return GitHub REST shapes, so a GitHub App source can replace the `gh` one later.
`ghCliSource({ cacheDir, run })` calls `gh api` with the developer's own `gh` login, pages with
`per_page=100`, and stops listing once pull requests are older than `since`. Responses per pull
request are cached in `cacheDir` (default `~/.selfhost/cache/github`) under the pull request's
`updated_at`, which GitHub bumps on every push, review and comment, so later scans only fetch
pull requests that changed. A first scan costs four API calls per pull request. `run` replaces
the `gh` call, for tests.

## Stats

`attributionStats(commits, pulls)` returns one row per agent and model, plus `unattributed`,
sorted by vendor and model with unattributed last: commits and their share of all commits, pull
requests, merged, closed (without merging), `mergedRate` (merged over merged plus closed; open
ones are left out), `medianHoursToMerge`, `reviewCommentsPerPr` and `unreviewedMerges`.
`sessionsWithoutCommits(sessions, commits)` lists sessions no commit was attributed to.

## Ledger events

`toLedgerEvents(commits, pulls, { actorId, repo })` returns `commit.created` (source `cli`, at
the author time) for every commit, and `pr.opened`, then `pr.merged` or `pr.closed` (source
`github`) for every pull request, with `links.commit_sha` and `links.pr_url` (a commit on a pull
request links to it). Attributed records carry `agent.vendor`, `model` and `data.signal`;
unattributed ones carry `data.unattributed: true` and no agent. The commit author email or pull
request login is the actor, kind `agent` for agent accounts; `actorId` stands in when GitHub has
no author (a deleted account). Ids come from the repository and the SHA or URL, so a second scan
stores nothing new. Commit subjects and file paths are not stored.

## Tests

`pnpm --filter @selfhost/attribution test` builds a git repository in a temp dir with every kind
of trailer, bot authors, agent branches (unmerged, merged, remote only), session links, file and
time matches and plain commits, and plays recorded `gh api` responses from
[`fixtures/github`](../../fixtures/github/manifest.json) covering merged, closed, open,
unreviewed, large-diff and conflicting pull requests. No test calls GitHub or runs `gh`.

## Decisions from GitHub

`githubDecision(event, payload, { person? })` turns a GitHub webhook delivery (`event` is the
`X-GitHub-Event` header) into the decision to pass to `recordDecision` or `POST /v1/decisions`,
or undefined when it is not a person's answer on an agent's pull request:

| Event                 | Action      | Verdict                                                                             |
| --------------------- | ----------- | ----------------------------------------------------------------------------------- |
| `pull_request_review` | `submitted` | approved is `approve`, changes_requested is `deny`, commented with text is `answer` |
| `issue_comment`       | `created`   | `answer`, only on pull requests                                                     |

The review or comment text is the reason, `#<number> <title>` the question, and GitHub's review
or comment id the idempotency key, so a redelivered webhook records nothing new. The pull request
counts as an agent's when its body, author or branch names one (`webhookPullAgent`, the same
signals as above minus commits). Bots, edits, dismissals and comment-only reviews with no text
give nothing. `person` maps a GitHub login to a selfhost person id; by default the login is used.
The GitHub App that receives these webhooks comes later; fixtures are in
`fixtures/github/webhooks/`.

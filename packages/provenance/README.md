# @selfhost/provenance

Line-level provenance from git: how much merged code each agent, model and person wrote, per
repository and module, and how much of it was reverted or reworked within days of merge. Every
number comes from git and the ledger; vendor stats only add a column next to them.

```ts
import { readProvenance, runCommits, mergedPulls, settingsFromConfig } from "@selfhost/provenance";

const report = await readProvenance(repoDir, {
  since: new Date(Date.now() - 30 * 86_400_000),
  settings: settingsFromConfig(config), // [review] modules, module_depth, revert_window_days, revert_rate_threshold
  runs: runCommits(events), // commit.created events with a session: the run that made a commit
  pulls: mergedPulls(events, "acme/api"), // pr.merged events (or GitHub) with their agent
});
report.by_agent; // lines, share, runs, reverted, reworked and their rates per agent and model
report.modules; // ranked by agent-written lines, above_threshold per [review] revert_rate_threshold
```

The report is `ProvenanceReport` in [`@selfhost/schema`](../schema/src/provenance.ts). It is
what `selfhost provenance --json` prints, the `provenance` section of `selfhost scan --json`, and
one entry of `GET /v1/teams/{team}/provenance`.

## Lines

The main branch is `--branch`, else what `origin/HEAD` points at, else `origin/main`,
`origin/master`, `main`, `master` or `HEAD`. Its first-parent commits committed in the window are
grouped into landings:

- a merge commit (GitHub's merge button) is one landing: what it brought in against its first
  parent, with each line traced to the branch commit that wrote it;
- a squash merge or a direct push is one landing;
- consecutive commits with the same committer and commit time (GitHub's rebase merge) are one
  landing, so a commit that edits the one before it in the same pull request is not rework.

The lines of a landing are the non-blank lines `git blame --line-porcelain -w -M -C
<bottom>..<landing>` attributes to a commit after `bottom` (the first parent of the landing's
first commit). `-M -C` follows lines moved or copied within and across files, and `-w` ignores
whitespace, so a moved or reindented line keeps its old author and is not new. Binary files and
lockfiles (`LOCKFILES`, the list the risk score's size leaves out) have no lines. Each line's
identity is the commit, path and line number blame gives it; it keeps that identity while it is
unchanged, through renames.

## Who wrote a line

Through the commit the line came from, strongest evidence first:

1. a ledger session that recorded the commit (`commit.created` with a session id and an agent,
   matched on the full or abbreviated SHA): the run that made it;
2. the commit's own attribution from [`@selfhost/attribution`](../attribution/README.md):
   trailers, session links, bot authors, agent branches, and a ledger session that edited the
   same files shortly before;
3. for a squash merge or direct commit, the pull request it merged (`(#N)` or `Merge pull request
   #N`), when GitHub or a `pr.merged` event names its agent; a person's commit on an agent's
   branch stays the person's;
4. a vendor's per-commit stats (`--vendor-stats`), when its agent wrote at least half of the
   commit's added lines.

Lines a merge commit itself wrote (conflict resolutions) go to the pull request's agent, else to
the agent behind most of the landing's other lines. The person is the commit's author email.
Without any of these a line is `unattributed`; nothing is assigned by guess.

## Revert and rework

For `[review] revert_window_days` (default 14) after a landing merged, every later first-parent
commit is checked. Blame at the end of the window first: when every line of the landing is still
there, nothing else is read. Otherwise each later commit that touches the landing's files (their
paths followed through renames) is blamed in turn, and the lines it no longer holds are lost at
that commit:

- **Reverted**: the commit says it reverts the landing (`This reverts commit <sha>` naming one of
  its commits or the commits its lines came from, `Reverts owner/name#N` naming its pull request,
  or the subject `Revert "<the landing's subject>"`), or it removes every line of the landing
  still there and adds back no more than a tenth as many lines to those files
  (`WHOLESALE_ADDED_SHARE`).
- **Reworked**: any other commit that changes or deletes the lines, including fix-forward edits,
  so a team that fixes forward instead of reverting shows its real rate.

Commits after `until` (default now) are not read, and lines whose window has not ended are
counted in `open_lines`: their numbers can still grow. Rates are lines over lines:
`revert_rework_rate` is reverted plus reworked over the lines the group wrote.

## Modules

A file belongs to the first `[review] modules` entry, in file order, with a glob that matches it
(picomatch, dot files included), else to its first `module_depth` folders (default 1), else to
`(root)`. A line's module is its file's at the landing. A module is `above_threshold` when its
agent-written lines' revert plus rework rate is above `[review] revert_rate_threshold` (default
0.25) and it holds at least `MIN_MODULE_LINES` (50) agent lines. The risk score in
[`ee/risk`](../../ee/risk/README.md) raises new pull requests that touch such a module.

## Without a clone

`ledgerOnlyReport` builds the report from `pr.merged` events alone (lines added per merged pull
request, by agent, model and person, and the sessions whose commits are on them), with `status:
"ledger_only"`, no modules and every revert and rework number `null`. The server answers with it
for a team repo it has no clone of.

## Vendor stats

Cursor AI Code Tracking and Claude Code Analytics report lines their agents added. Converted to
`VendorLineStat` (`vendor`, `commit` or `day`, `lines_added`, optional `lines_removed`, `person`,
`model`) they appear in `vendor_reported` next to the git numbers for the same window, and a
per-commit stat can name the agent of a commit nothing else attributes. They are never needed.

## Tests

`pnpm --filter @selfhost/provenance test` builds fixture repositories in temp dirs: agent commits
by session link, task link, bot author and ledger run; a fix-forward edit, a reindent, an edit
after the window, `git revert`, a file deleted with no revert message, a rename then an edit, a
merge commit with a person's commit on an agent's branch, squash merges (one attributed by its
pull request), a rebase merge, a squash-merged revert pull request, `git revert -m 1` of a merge,
a full rewrite, and lines moved to another file. No test reads this repository's history.

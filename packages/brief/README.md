# @selfhost/brief

The review brief: one comment on every agent pull request with the task, the plan, the files
touched, the commands run, the tests run and their results, blocked actions, cost, a link to the
full trace, and the lines a reviewer should look at first. This package builds it as data and
renders it as GitHub-flavored Markdown; posting and editing the comment is the GitHub delivery's
job. Apache-2.0, and it works with the `ee/` folder removed.

```ts
import { BRIEF_MARKER, gatherBrief, renderBrief } from "@selfhost/brief";

const brief = await gatherBrief({
  repoDir,
  target: { pr: 142 }, // or { base: "main" }
  ledger,
  highRiskPaths: config.review.high_risk_paths,
  server: "https://selfhost.example.com", // optional: trace links point at its events API
});
const body = renderBrief(brief); // starts with BRIEF_MARKER
```

`buildBrief(inputs)` is the pure part: the same inputs give the same brief and the same text, so
the comment can be rebuilt on every run and edited in place. `gatherBrief` reads the inputs
through [`@selfhost/pr`](../pr/README.md) and never writes to GitHub. The server builds the
same inputs with `briefInputs(await readPullRequest(...), settings)`, reading the pull request
through its GitHub App instead of a clone. `summarizeBrief(brief)` is one paragraph (the agent,
the size of the change, lines to look at, tests and blocked actions, or why no run was found)
for the check run summary.

## The comment

The first line is `<!-- selfhost:brief v1 -->` (`BRIEF_MARKER`). The delivery finds the comment
it posted before by that marker (`isBriefComment`) and edits it instead of posting another.

Every section is always there. When the run has nothing for one, the section says so and why:
"No tests ran in this run.", "No trace found: no ledger.", "Protected paths not checked:
selfhost.toml has no [review] high_risk_paths."

| Section          | From                                                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task             | The pull request title and the first paragraph of its description (the first commit subject for local commits), and the run's first prompt only when prompts are stored                                    |
| Plan             | List items under a Plan heading in the description, and the run's plan updates (`TodoWrite`, `update_plan`, `ExitPlanMode`)                                                                                |
| Lines to look at | Changes under `[review] high_risk_paths`, new dependencies, deleted test files, deleted tests and skipped or focused tests, each linked to its line in the diff                                            |
| Files touched    | Every changed file with its status and line counts                                                                                                                                                         |
| Commands run     | Shell commands from the run's `tool.called` events, one source per session, identical ones on one line                                                                                                     |
| Tests run        | Commands that run a test runner (vitest, jest, pytest, go test, cargo test, npm/pnpm/yarn/bun test, and others), with the result from the matching `tool.result`                                           |
| Blocked actions  | `policy.evaluated` block and ask verdicts with their rule ids, enforced or observed; package guard verdicts (`packages.*`) read as blocked or flagged installs                                             |
| Cost             | `cost.recorded` events, one source per session, as `selfhost spend` counts them                                                                                                                            |
| Trace            | Each session's run view in the team server's console (`<server>/?screen=run&run=<id>`) and, with `[integrations.tracer] run_url`, the run in the tracer; or the local command `selfhost review trace <id>` |

Package installs the package guard could not check in time (`packages.unchecked`, recorded in
observe mode because the install went ahead) are not listed as blocks: the Blocked actions
section counts them in a note instead.

A test result is matched to its call by the call id when the hook recorded one, else to the
earliest call in the same session with the same command. `passed` and `failed` come from the
recorded success flag, exit code or error; a result with none of them is "finished, outcome not
recorded".

Lines link to the pull request's diff view (`/pull/<n>/files#diff-<sha256 of the path>R<line>`,
`L<line>` for a deleted line). For local commits on a GitHub repository they link to the file at
the head commit (the base commit for deleted lines); elsewhere they are plain `path:line`.

Lists stop at a limit (`LIST_LIMITS`) and end with "and N more"; when the comment would still
pass GitHub's 65,536-character limit, the limits shrink until it fits.

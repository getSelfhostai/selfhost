# @selfhost/ee-risk

Commercial code, under [`ee/LICENSE`](../LICENSE), not Apache-2.0.

Scores an agent pull request as low, medium or high from the rules in `selfhost.toml`, and
builds the PR label and the check result that lists the inputs behind the level. This package
only builds them as data; the server's GitHub App route posts them (see
[`apps/server`](../../apps/server/README.md#github-app)).

```ts
import { gatherRiskInputs, riskCheck, riskLabel, scoreRisk } from "@selfhost/ee-risk";

const { inputs } = await gatherRiskInputs({ repoDir, target: { pr: 101 }, ledger });
const risk = scoreRisk(inputs, config); // { level, score, reasons, missing, factors }
riskLabel(risk.level); // "selfhost:risk-high"
riskCheck(risk, config); // { name: "selfhost/risk", title, summary, text }
```

`scoreRisk` is pure: no I/O, and the same inputs and config give the same result in any input
order. `gatherRiskInputs` reads the inputs locally and never writes to GitHub.

## Inputs

| Input              | Where it comes from                                                                                                                                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Irreversible rules | Rules with `irreversible = true`: `path` rules against the changed files (old and new path of a rename); every rule against the commands, URLs and tools of the run's tool calls and its recorded `policy.evaluated` hits. Paths count through the diff only, so reading a file is never irreversible |
| Outside effects    | The run's tool calls, classified by the patterns in [`src/effects.ts`](./src/effects.ts)                                                                                                                                                                                                              |
| Protected paths    | `[review] high_risk_paths` globs against the changed files                                                                                                                                                                                                                                            |
| Size               | Added plus deleted lines, lockfiles left out                                                                                                                                                                                                                                                          |
| New dependencies   | Names a manifest gained: `package.json` (all four dependency sections), `requirements*.txt`, `go.mod` (direct only), `Cargo.toml` (every dependencies table)                                                                                                                                          |
| Tests              | `passed`, `failed` or `not_run` from the sandbox. Sandbox runs come later, so this is usually missing; `selfhost review risk --tests` passes a CI result                                                                                                                                              |
| Guardrail blocks   | `policy.evaluated` events with a block verdict on the run's sessions, once per tool call and rule, observe or enforce                                                                                                                                                                                 |
| Revert rate        | The agent and model's commits on the repository in the last 90 days, and how many a later `This reverts commit <sha>` line names                                                                                                                                                                      |

The run is the set of ledger sessions behind the change: sessions with a `commit.created` event
for one of its commits, and sessions `readCommits` matches to its commits by session link or by
editing the same files shortly before. A pull request number is read through the developer's own
`gh` (GET requests only: the pull request, its files, its commits, and manifests at the base and
head SHAs); `--base <ref>` reads the local commits since the merge base.

An input that cannot be read is left out of the score and named in `missing` with the reason:
no ledger, no session that made the commits, no sandbox run, no `high_risk_paths`, no agent
attributed, or fewer than 5 commits by the agent and model.

## Weights

| Input              | Points                                                      |
| ------------------ | ----------------------------------------------------------- |
| Irreversible rules | 60, and the level is high                                   |
| Outside effects    | 60, and the level is high                                   |
| Protected paths    | 40, and the level is high                                   |
| Size               | 0 up to 50 lines, 5 to 200, 10 to 500, 15 to 1000, 20 above |
| New dependencies   | 10 for the first, 5 for each more, at most 20               |
| Tests              | failed 30, not run 15, passed 0                             |
| Guardrail blocks   | 10 each, at most 20                                         |
| Revert rate        | 10 from 10%, 20 from 25%                                    |

The score is the sum, held in bands so that what cannot be undone sorts above what can:

- An irreversible rule match or outside effect sets the level to high and the score to at least
  90, whatever else is true and whatever `high_risk_threshold` says.
- Everything else stays at 89 or below. A change under a protected path with every other input
  against it still scores below a run with one outside effect.
- A protected path sets the level to high (as `[review] high_risk_paths` promises) with a score
  of at least `high_risk_threshold`.
- Otherwise the level is high from `[review] high_risk_threshold` (default 70) and medium from
  half of it, rounded up (35).

The numbers are first defaults, to be tuned on real data. The constants live in
[`src/score.ts`](./src/score.ts) (`WEIGHTS`, `IRREVERSIBLE_FLOOR`, `MIN_REVERT_SAMPLE`).

## Outside effects

Patterns read the stored command (its first line, at most 120 characters, secrets masked) or the
MCP tool name. They are kept small on purpose; a match is not proof the call succeeded, and a
command hidden in a script is not seen.

| Kind            | Matches                                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payment         | `stripe <resource> create\|update\|delete\|cancel\|capture\|confirm\|refund\|pay`, `stripe post`; MCP tools on stripe, paypal, square or adyen with a write verb                   |
| Email           | `aws ses send-*`, the SendGrid and Mailgun send endpoints, `sendmail`, `swaks`; MCP `send*` tools on mail servers                                                                  |
| Production data | `psql`, `mysql` or `mongosh` naming a host that is not local (localhost, loopback, a socket path, or a single-label Compose service name)                                          |
| Publish         | `npm`, `pnpm`, `yarn`, `bun` or `cargo publish`, `twine upload`, `gem push`, `docker push`, `gh release create`                                                                    |
| Infrastructure  | `terraform`/`tofu apply\|destroy\|import`, `pulumi up\|destroy`, `kubectl` writes, `helm` release changes, `cdk deploy\|destroy`, `vercel --prod`, `fly deploy`, `wrangler deploy` |

## License boundary

This package is in the `ee/*` workspace with `"license": "SEE LICENSE IN ../LICENSE"`. Apache
code never imports it: a Biome `noRestrictedImports` override fails lint on any import of
`@selfhost/ee-*` or an `ee/` path outside `ee/`, except `apps/cli/src/ee.ts`, which loads the
package when `selfhost review risk` runs, and `apps/server/src/ee.ts`, which loads it when the
GitHub App first scores an agent pull request. `test/boundary.test.ts` checks the license fields
and that only the CLI and the server depend on an `ee/` package.

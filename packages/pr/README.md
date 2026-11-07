# @selfhost/pr

Reads an agent pull request, or local commits since a base, the same way for every reviewer
feature: the changed files with their hunks and line numbers, the dependencies a manifest gained,
the tests the diff deleted or skipped, who the change is attributed to, and the agent sessions in
the ledger that produced it. Apache-2.0; the review brief and the commercial risk score
(`ee/risk`) both read changes through it.

```ts
import { newDependencies, readChange, testChanges } from "@selfhost/pr";

const change = await readChange({ repoDir, target: { pr: 142 }, ledger });
// { target, repo, pull, subjects, files (with hunks), manifests, history, matched, agent, run }
newDependencies(change.manifests); // [{ manifest: "package.json", name: "ioredis" }]
testChanges(change.files); // deleted test files, deleted tests, added skips
```

A pull request number is read through the developer's own `gh` (GET requests only: the pull
request, its files with their patches, its commits, and manifests at the base and head SHAs);
`{ base, head? }` reads the local commits since the merge base with `git diff -M`. Nothing is
written anywhere.

## The run

`change.run` is the set of ledger sessions behind the change: sessions with a `commit.created`
event for one of its commits, and sessions `readCommits` matches to its commits by session link
or by editing the same files shortly before. It carries every event those sessions recorded
(oldest first), their tool calls in the terms rules match on, and their block and ask verdicts
(`policy.evaluated`), once per tool call and rule. Without a ledger, or when no session made the
commits, `run` is undefined and `runMissing` says why.

## Tests in the diff

`isTestFile` knows the usual names: `*.test.*`, `*.spec.*`, `*.cy.*`, `__tests__/`, `test_*.py`,
`*_test.py|go|exs|dart`, `*_spec.rb`, `*Test.java` and the like, and code under `test/`,
`tests/`, `spec/` or `e2e/`. In those files `testChanges` reports:

| Kind                | When                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `deleted_test_file` | The file was deleted; the detail counts the tests it declared                                                                        |
| `deleted_test`      | The file lost more test declarations than it gained, and the lost one is not declared again under the same name                      |
| `skipped_test`      | An added line skips or focuses a test: `.skip`, `.only`, `xit`, `fdescribe`, `@pytest.mark.skip`, `t.Skip`, `#[ignore]`, `@Disabled` |

A line moved or reindented unchanged is not reported again.

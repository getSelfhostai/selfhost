# ee

Code in this folder is not open source. It is licensed under the commercial terms in
[`ee/LICENSE`](./LICENSE), not the Apache License 2.0 that covers the rest of the repository.

Open source code must not import from `ee/`. Lint enforces it: a Biome `noRestrictedImports`
override fails on any import of `@selfhost/ee-*` or an `ee/` path from outside this folder. The
two exceptions are `apps/cli/src/ee.ts`, where the CLI loads a commercial command when it runs,
and `apps/server/src/ee.ts`, where the server loads the risk score when the GitHub App first
scores an agent pull request, and the receipt renderer when the first proof receipt arrives.
Each package here sets `"license": "SEE LICENSE IN ../LICENSE"` and is part of the `ee/*`
workspace, so typecheck, lint, test and CI cover it like the rest.

| Package                          | What                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [`risk`](./risk/README.md)       | PR risk score: low, medium or high from `selfhost.toml`, with the PR label and check result                         |
| [`receipt`](./receipt/README.md) | Proof receipt on agent PRs: changed tests run, Playwright screenshots, preview link; a GitHub Action and its render |

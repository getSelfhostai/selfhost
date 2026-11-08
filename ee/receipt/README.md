# @selfhost/ee-receipt

Commercial code, under [`ee/LICENSE`](../LICENSE), not Apache-2.0.

The proof receipt on agent pull requests. After an agent opens or updates a pull request, the
receipt starts the app, runs the tests the pull request adds or changes and records each result,
takes Playwright screenshots of the screens its changed files map to, and finds its preview
link. When the app does not start or a test fails, the receipt says so and carries the log. It
is attached to the pull request as one comment and linked from the review brief.

The runtime sandbox does not exist yet, so the receipt runs in the repository's own CI, as a
GitHub Action in this folder ([`action.yml`](./action.yml)). The runtime will call the same
`runReceipt` later.

## Adding it to a repository

```yaml
# .github/workflows/receipt.yml
name: Proof receipt
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write # the receipt comment, when there is no selfhost server
  deployments: read # the preview link
  statuses: read # the preview link (Netlify)
  id-token: write # posting to the selfhost server

jobs:
  receipt:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - uses: getselfhostai/selfhost/ee/receipt@<release tag or commit>
        with:
          server-url: https://selfhost.example.com # optional
```

Use `pull_request`, not `pull_request_target`: the receipt runs the pull request's code, which
must not see the repository's secrets. The job needs whatever the app needs to start (a language
runtime, services); `[runtime] setup` installs the dependencies.

By default only agent pull requests get a receipt (an agent bot as author, attribution lines or
session links in the description, or an agent branch prefix such as `claude/` or `codex/`, the
rules of [`@selfhost/attribution`](../../packages/attribution/README.md)); `agent-only: false`
makes one for every pull request.

| Input                | Default            | What                                                                                                  |
| -------------------- | ------------------ | ----------------------------------------------------------------------------------------------------- |
| `server-url`         | unset              | The team's selfhost server. Without it, the action comments with `github-token`                       |
| `github-token`       | `github.token`     | Reads the changed files, deployments and statuses; comments without a server                          |
| `config`             | `selfhost.toml`    | Path of selfhost.toml                                                                                 |
| `working-directory`  | `.`                | The checkout                                                                                          |
| `setup`, `start`     | unset              | Used when selfhost.toml has no `[runtime] setup`, no `[receipt] start` and no `[runtime.run]` command |
| `ready-url`          | unset              | Used when selfhost.toml has no `[receipt] ready_url`                                                  |
| `test-command`       | unset              | Used when selfhost.toml has no `[receipt] test_command`                                               |
| `preview-url`        | unset              | The preview link, for hosts that report it neither as a deployment nor as a commit status             |
| `preview-timeout`    | `300`              | Seconds to wait for a preview that is still deploying                                                 |
| `agent-only`         | `true`             | Only agent pull requests                                                                              |
| `screenshots`        | `true`             | `false` skips Playwright                                                                              |
| `browser-deps`       | `false`            | Also install Chromium's system packages (apt, sudo); GitHub's Ubuntu runners already have them        |
| `fail-on-failure`    | `true`             | Fail the job when the receipt fails                                                                   |
| `artifact-name`      | `selfhost-receipt` | Name of the uploaded artifact                                                                         |
| `retention-days`     | `14`               | Days to keep it                                                                                       |
| `playwright-version` | `1.64.1`           | playwright-core used for the screenshots                                                              |

Outputs: `verdict` (`passed`, `failed` or `nothing_checked`), `skipped`, `dir`, `artifact-url`
and `comment-url`.

The action is a composite of three steps. `run` (Node, bundled into
[`action/index.mjs`](./action/index.mjs), so nothing is installed from npm but playwright-core)
makes the receipt; `actions/upload-artifact` uploads `receipt.json`, `receipt.md`,
`receipt.html` (one page with the screenshots embedded), `screens/` and `logs/`; `report` writes
the job summary and attaches the receipt. Only Chromium's headless shell is installed, cached by
Playwright version, and only when screenshots are on.

## selfhost.toml

The receipt reads `[runtime]` (the runtime plugin's settings) and an optional `[receipt]`:

```toml
[runtime]
setup = "pnpm install --frozen-lockfile"

[runtime.run.web]
command = "pnpm dev --port $SELFHOST_PORT"
default = true

[receipt]
ready_url = "http://127.0.0.1:$SELFHOST_PORT/health"   # default: http://127.0.0.1:$SELFHOST_PORT/
ready_timeout_seconds = 120
# start = "pnpm build && pnpm preview --port $SELFHOST_PORT"   # instead of [runtime.run]
# test_command = "pnpm vitest run {file}"   # instead of the built-in runners
# tests = ["e2e/**/*.ts"]                   # more test file globs
max_tests = 20
max_screens = 10

[receipt.screens]   # glob of changed files = the screens that show them
"src/pages/settings/**" = ["/settings", "/settings/billing"]
"src/components/Nav.tsx" = "/"
```

- **Setup**: `[runtime] setup`, run in the checkout with the `SELFHOST_` variables set
  (`SELFHOST_PORT` is a free port, or `[receipt] port`). When it fails nothing else runs and the
  receipt shows its log.
- **The app**: `[receipt] start`, else the default `[runtime.run]` command (or the only one),
  with `PORT` and `SELFHOST_PORT` set, in the background. It counts as started once `ready_url`
  answers with a status under 500. If the command exits first with a non-zero code, or nothing
  answers in time, the receipt says so with the app's log.
- **Tests**: the test files the pull request adds or changes (not deleted ones):
  `*.test.*`, `*.spec.*` and `__tests__/` for JavaScript and TypeScript, `test_*.py` and
  `*_test.py`, `*_test.go`, plus `[receipt] tests`. Each JavaScript file runs with the runner of
  the nearest `package.json` above it that sets one up (vitest, jest, or a `node --test` test
  script; a vitest or jest config file decides between two), one file per run, with that
  package's and the root's `node_modules/.bin` on `PATH`. Python files run with
  `python3 -m pytest` (a `.venv` python when there is one) from the nearest project root, Go
  files with `go test` once per package. `[receipt] test_command` replaces all of that: `{file}`
  runs it once per file, `{files}` once for all. Test files with no runner (Ruby, Java and the
  like) are listed as not run, with why.
- **Screens**: the URL paths `[receipt.screens]` maps the changed files to (old paths of
  renames count), each once, at most `max_screens`. Without a map, the home page. They are
  opened on the app when it started, else on the ready preview, in headless Chromium at 1280 by
  800, and captured full page. A page that answers 400 or more, or cannot be captured, fails the
  receipt; uncaught page errors are listed.
- **Preview**: GitHub deployments of the head commit that are not production (Vercel,
  Netlify, Render, Cloudflare Pages and others create these) and deploy-preview commit statuses
  (Netlify). A ready one gives the link; one still deploying is waited on for `preview-timeout`
  seconds. With no preview environment, the receipt says so and carries the screenshots and
  logs.

Every log is masked line by line (the built-in secret and email patterns and `[[redaction]]`)
before it is written to the artifact or the receipt, which keeps the last 60 lines of each one
that failed.

## The receipt

`receipt.json` is a `selfhost.receipt/v1` document, schema
[`packages/schema/json/receipt.schema.json`](../../packages/schema/json/receipt.schema.json):
the repository and pull request with its head commit, the CI run, the artifact, setup, the app,
each test run (files, runner, command, result, time, log on failure), the tests not run and why,
each screenshot, the preview, and notes on what could not be checked. Its `verdict` is `failed`
when anything failed, `nothing_checked` when no test ran, no screen was captured and there is
no ready preview, else `passed`.

The comment (`renderReceipt`) leads with that verdict in one sentence, such as "Failed. 1 of 2
test runs failed, 2 screens captured, preview ready.", then the preview link, setup, the app,
a table of test runs, a table of screens and the notes, with the log of each failure open below
it. Logs shrink until the comment fits GitHub's limit. The brief's section
(`receiptBriefSection`) is the same sentence and links to the comment, the preview, the
screenshots and the CI run, or says the receipt is for an older commit.

## Attaching it

With `server-url`, `report` asks GitHub for the job's OIDC token with the server's URL as
audience and posts the receipt to `POST /v1/receipts`. The server checks the token against
GitHub's keys, that the receipt is for the token's own repository (and pull request) and that
the selfhost GitHub App is installed there, then stores it, posts the comment through the App
and links it from the review brief (see
[`apps/server`](../../apps/server/README.md#proof-receipts)). No secret goes into the repository.
If the post fails, or without a server, the action comments with `github-token` instead; a pull
request from a fork gets a read-only token, so its receipt is in the job summary only.

## Development

```sh
pnpm --filter @selfhost/ee-receipt test     # unit tests, the runner on fixtures/receipt-app, the action with a fake GitHub
pnpm --filter @selfhost/ee-receipt bundle   # rebuild action/index.mjs after changing src/ (CI checks it)
SELFHOST_RECEIPT_E2E=1 SELFHOST_RECEIPT_PLAYWRIGHT=<path to playwright-core> \
  pnpm --filter @selfhost/ee-receipt exec vitest run test/e2e.test.ts   # the bundle with real screenshots
```

The `receipt` job in CI runs that last one on the sample app, once with a preview deployment
and once without.

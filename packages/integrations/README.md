# @selfhost/integrations

selfhost is glue. A team picks the best tool for each job and selfhost connects it and keeps the
record; it never rebuilds what the tool does. This package holds one adapter per tool, each
checking that the tool answers and that its key works, and the editor that writes a team's
choice into `selfhost.toml`.

| Job        | Tools                                               |
| ---------- | --------------------------------------------------- |
| `router`   | Bifrost (bundled with the server), LiteLLM          |
| `tracer`   | Langfuse, Phoenix, Datadog, any OTLP/HTTP endpoint  |
| `runtime`  | E2B, Daytona, Modal, Coder, OpenSandbox             |
| `reviewer` | PR-Agent, the Claude Code GitHub Action, CodeRabbit |

The choice lives in `[integrations]` of `selfhost.toml`, except the runtime, which lives in
`[runtime]`. Secrets are never written there, only the name of the environment variable that holds
them:

```toml
[integrations.router]
tool = "litellm"
url = "http://litellm:4000"
admin_key_env = "LITELLM_MASTER_KEY"

[integrations.tracer]
tool = "langfuse"
endpoint = "https://cloud.langfuse.com/api/public/otel"
headers_env = { Authorization = "LANGFUSE_OTLP_AUTH" }

[runtime]
default = "e2b"

[runtime.providers.e2b]
api_key_env = "E2B_API_KEY"

[integrations.reviewer]
tool = "claude-code-action"
```

In a team, the org's `[integrations.<kind>]` is a default, not a floor: a team's own table for the
same job replaces it whole, so a team that picks another tool does not inherit the org tool's
settings.

`[integrations.runtime]` (a `tool` and the provider's settings) is a deprecated alias: it is read
as `[runtime] default = <tool>` with the settings in `[runtime.providers.<tool>]`, with a one-line
warning, and `selfhost integrations set runtime` moves it there. The runtime row of the list and
checks shows the runtime `[runtime] default` names.

## Checks

Each check makes the cheapest call the tool's docs give, changes nothing, and gives up after 5
seconds. On failure the detail says what to change. It names environment variables, never their
values, and a URL with a user name or password in it is refused rather than called.

| Tool                 | Check                                                                                                                                                                                                  | Docs                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `bifrost`            | `GET /health`, then with `admin_key_env` `GET /api/config` (a management key as Bearer, `username:password` as Basic), else `GET /api/session/is-auth-enabled`. Default url `http://bifrost:8080`.     | [Bifrost auth](https://docs.getbifrost.ai/quickstart/gateway/setting-up-auth)                          |
| `litellm`            | `GET /health/liveliness`, then `GET /v1/models` with the master key. Not `/health`, which calls every model.                                                                                           | [LiteLLM health](https://docs.litellm.ai/docs/proxy/health)                                            |
| `langfuse`           | `GET /api/public/projects` with the `Authorization` header from `headers_env` (Basic, public key:secret key).                                                                                          | [Langfuse public API](https://langfuse.com/docs/api-and-data-platform/features/public-api)             |
| `phoenix`            | `GET /healthz`, then `GET /v1/projects?limit=1` with the headers from `headers_env`.                                                                                                                   | [Phoenix auth](https://arize.com/docs/phoenix/self-hosting/features/authentication)                    |
| `datadog`            | `GET https://api.<site>/api/v1/validate` with the `dd-api-key` from `headers_env`; the site comes from `https://otlp.<site>`.                                                                          | [Validate API key](https://docs.datadoghq.com/api/latest/authentication/#validate-api-key)             |
| `otlp`               | `POST <endpoint>/v1/traces` with an empty protobuf export (no spans) and the headers from `headers_env`. Any 2xx passes.                                                                               | [OTLP/HTTP](https://opentelemetry.io/docs/specs/otlp/#otlphttp)                                        |
| `e2b`                | `GET /v2/sandboxes?limit=1` with `X-API-Key`. Default url `https://api.e2b.app`, key `E2B_API_KEY`.                                                                                                    | [E2B list sandboxes](https://docs.e2b.dev/api-reference/sandboxes/list-sandboxes-v2)                   |
| `daytona`            | `GET /api-keys/current` with a Bearer key. Default url `https://app.daytona.io/api`, key `DAYTONA_API_KEY`.                                                                                            | [Daytona API](https://www.daytona.io/docs/en/tools/api)                                                |
| `modal`              | No call: Modal has no HTTP API to test a token. Checks the token id (`ak-`, `MODAL_TOKEN_ID`) and secret (`as-`, `MODAL_TOKEN_SECRET`, or `api_secret_env`) are set and well formed.                   | [modal token](https://modal.com/docs/cli/latest/token)                                                 |
| `coder`              | `GET /api/v2/buildinfo`, then `GET /api/v2/users/me` with `Coder-Session-Token`. url is required; key `CODER_SESSION_TOKEN`.                                                                           | [Coder users API](https://coder.com/docs/reference/api/users)                                          |
| `opensandbox`        | `GET /v1/sandboxes?pageSize=1` with `OPEN-SANDBOX-API-KEY`. url is required; key `OPEN_SANDBOX_API_KEY`, optional for a server on localhost.                                                           | [OpenSandbox server](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/server/README.md) |
| `pr-agent`           | A workflow in `.github/workflows` uses `the-pr-agent/pr-agent` (or its earlier `qodo-ai`, `Codium-ai` names, or the `pragent/pr-agent` image).                                                         | [PR-Agent](https://github.com/the-pr-agent/pr-agent)                                                   |
| `claude-code-action` | A workflow in `.github/workflows` uses `anthropics/claude-code-action` with `anthropic_api_key`; one signing in with `claude_code_oauth_token` alone fails. The fix points at `selfhost review setup`. | [claude-code-action](https://github.com/anthropics/claude-code-action)                                 |
| `coderabbit`         | The `coderabbitai` GitHub App is installed on the org (needs the selfhost App to have Administration read), else `coderabbitai[bot]` commented on recent pull requests.                                | [CodeRabbit on GitHub](https://docs.coderabbit.ai/platforms/github-com)                                |

Reviewer checks never call the reviewer: they read the team's repositories, through the selfhost
GitHub App on a server or the checkout the CLI runs in. Without either they say so. From a laptop
CodeRabbit's installation cannot be seen at all, so its check only passes on a server.

The checks only test the connection. Sending model traffic through the router and traces to the
tracer is the server's gateway sync and trace export.

```ts
import { checkIntegrations, setIntegrationTable } from "@selfhost/integrations";

const states = await checkIntegrations(config.integrations, { env: process.env, fetch });
// states.router: { tool, status: "connected" | "not_configured" | "error", detail, settings }

const text = setIntegrationTable(selfhostToml, "runtime", { tool: "e2b", template: "base" });
```

`setIntegrationTable` replaces one `[integrations.<kind>]` table, or with `null` removes it, and
keeps every other line, comments included. A table written inline or with dotted keys is refused
(`IntegrationEditError`) instead of rewritten. Validating the result is the caller's job, with
`parseConfig` or `checkLayer` from `@selfhost/schema`.

## Reviewers: second opinions

selfhost does not review code. It wires an existing reviewer into a repository, reads its
verdict back and uses it: on the pull request's item in the review list, and as one input to
the risk score. `reviewerSetup(tool, options)` builds the file (pure; `selfhost review setup`
writes it) and `reviewerDelivery(event, payload)` reads a verdict from a GitHub webhook.

| Tool                 | Setup writes                                                                                                                                                                                                           | Key                                                                                                                                                              | Verdict read from                                                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pr-agent`           | `.github/workflows/selfhost-pr-agent.yml`: `docker://pragent/pr-agent:0.49.0-github_action@sha256:...` (v0.49.0). `/review` on open, push and agent label, with the merge recommendation and risk level on, labels off | Repository or org secret `OPENAI_KEY`, or `ANTHROPIC_KEY` for an `anthropic/` model; `api_key_env` renames it                                                    | Its `/review` comment (`<!-- pr-agent:review:full -->`): merge recommendation (No concerns found, Needs review, Changes required), focus areas plus a security concern as findings, risk level |
| `claude-code-action` | `.github/workflows/selfhost-claude-review.yml`: `actions/checkout` and `anthropics/claude-code-action` pinned to release commits (v1.0.259). Inline comments plus one summary comment                                  | Secret `ANTHROPIC_API_KEY` as `anthropic_api_key`. `claude_code_oauth_token` (one person's subscription) is refused, and the check fails a workflow that uses it | The last line of its summary: `<!-- selfhost:second-opinion tool=claude-code-action verdict=changes findings=2 severity=high -->`                                                              |
| `coderabbit`         | `.coderabbit.yaml`: profile chill (assertive with `style`), automatic approvals off, auto review filtered to the `selfhost:agent-*` labels                                                                             | None: CodeRabbit runs on its own plan (free on public repositories, paid seats on private)                                                                       | Its review: state as the verdict, `Actionable comments posted: N` plus outside-diff comments as findings (nitpicks left out), severity labels (Critical, Major, Minor, Trivial)                |

All three run on agent pull requests only unless `[integrations.reviewer] pull_requests = "all"`:
the workflows' `if:` is `agentPullCondition()` from
[`@selfhost/attribution`](../attribution/README.md), the same signals a webhook is attributed by,
plus the App's agent label. Each is told to break the change (a failing input, a missed case, a
broken flow), to prove each finding with a failing test or a repro, and to skip style unless
`style = true`. The two workflows hand the reviewer the selfhost brief comment, which describes
the run behind the pull request (plan, tests run, guardrail hits, cost), and say to review the diff
alone, and say so, when there is none. Model calls go from the team's runner to the vendor on the
team's key; selfhost pays nothing per review.

A failed reviewer job (`check_run` with a failure from the job names setup writes) is the verdict
`failed`. Verdicts are `approve`, `changes`, `comment` and `failed`; findings and severity
(`critical`, `high`, `medium`, `low`) come with them when the reviewer reports them. Reviews and
comments by people never count. The fixtures for each tool are in
[`fixtures/github/webhooks/reviewers`](../../fixtures/github/webhooks/reviewers).

Versions are pinned to releases at least two weeks old when picked (`REVIEWER_PINS` in
`src/reviewers/setup.ts`): actions by commit, the PR-Agent image by digest. Bump them there.

## Adding a tool

1. Add its name to the tool list for its job in `packages/schema/src/config.ts`, plus any setting
   it needs, and run `pnpm --filter @selfhost/schema export`.
2. Add one file in `src/adapters/` exporting an `Adapter`: `kind`, `tool`, `describe()` and
   `check(settings, env, fetch, repos?)`.
3. List it in `ADAPTERS` in `src/registry.ts`, and add a test against the responses its docs
   record (`test/recorded.ts`). Tests never call the network.

# @selfhost/integrations

selfhost is glue. A team picks the best tool for each job and selfhost connects it and keeps the
record; it never rebuilds what the tool does. This package holds one adapter per tool, each
checking that the tool answers and that its key works, and the editor that writes a team's
choice into `selfhost.toml`.

| Job        | Tools                                               |
| ---------- | --------------------------------------------------- |
| `router`   | Bifrost (bundled with the server), LiteLLM          |
| `tracer`   | Langfuse, Phoenix, Datadog, any OTLP/HTTP endpoint  |
| `runtime`  | E2B, Daytona, Modal, Coder                          |
| `reviewer` | PR-Agent, the Claude Code GitHub Action, CodeRabbit |

The choice lives in `[integrations]` of `selfhost.toml`. Secrets are never written there, only the
name of the environment variable that holds them:

```toml
[integrations.router]
tool = "litellm"
url = "http://litellm:4000"
admin_key_env = "LITELLM_MASTER_KEY"

[integrations.tracer]
tool = "langfuse"
endpoint = "https://cloud.langfuse.com/api/public/otel"
headers_env = { Authorization = "LANGFUSE_OTLP_AUTH" }

[integrations.runtime]
tool = "e2b"

[integrations.reviewer]
tool = "claude-code-action"
```

In a team, the org's `[integrations.<kind>]` is a default, not a floor: a team's own table for the
same job replaces it whole, so a team that picks another tool does not inherit the org tool's
settings.

## Checks

Each check makes the cheapest call the tool's docs give, changes nothing, and gives up after 5
seconds. On failure the detail says what to change. It names environment variables, never their
values, and a URL with a user name or password in it is refused rather than called.

| Tool                 | Check                                                                                                                                                                                              | Docs                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `bifrost`            | `GET /health`, then with `admin_key_env` `GET /api/config` (a management key as Bearer, `username:password` as Basic), else `GET /api/session/is-auth-enabled`. Default url `http://bifrost:8080`. | [Bifrost auth](https://docs.getbifrost.ai/quickstart/gateway/setting-up-auth)              |
| `litellm`            | `GET /health/liveliness`, then `GET /v1/models` with the master key. Not `/health`, which calls every model.                                                                                       | [LiteLLM health](https://docs.litellm.ai/docs/proxy/health)                                |
| `langfuse`           | `GET /api/public/projects` with the `Authorization` header from `headers_env` (Basic, public key:secret key).                                                                                      | [Langfuse public API](https://langfuse.com/docs/api-and-data-platform/features/public-api) |
| `phoenix`            | `GET /healthz`, then `GET /v1/projects?limit=1` with the headers from `headers_env`.                                                                                                               | [Phoenix auth](https://arize.com/docs/phoenix/self-hosting/features/authentication)        |
| `datadog`            | `GET https://api.<site>/api/v1/validate` with the `dd-api-key` from `headers_env`; the site comes from `https://otlp.<site>`.                                                                      | [Validate API key](https://docs.datadoghq.com/api/latest/authentication/#validate-api-key) |
| `otlp`               | `POST <endpoint>/v1/traces` with an empty protobuf export (no spans) and the headers from `headers_env`. Any 2xx passes.                                                                           | [OTLP/HTTP](https://opentelemetry.io/docs/specs/otlp/#otlphttp)                            |
| `e2b`                | `GET /v2/sandboxes?limit=1` with `X-API-Key`. Default url `https://api.e2b.app`, key `E2B_API_KEY`.                                                                                                | [E2B list sandboxes](https://docs.e2b.dev/api-reference/sandboxes/list-sandboxes-v2)       |
| `daytona`            | `GET /api-keys/current` with a Bearer key. Default url `https://app.daytona.io/api`, key `DAYTONA_API_KEY`.                                                                                        | [Daytona API](https://www.daytona.io/docs/en/tools/api)                                    |
| `modal`              | No call: Modal has no HTTP API to test a token. Checks the token id (`ak-`, `MODAL_TOKEN_ID`) and secret (`as-`, `MODAL_TOKEN_SECRET`, or `api_secret_env`) are set and well formed.               | [modal token](https://modal.com/docs/cli/latest/token)                                     |
| `coder`              | `GET /api/v2/buildinfo`, then `GET /api/v2/users/me` with `Coder-Session-Token`. url is required; key `CODER_SESSION_TOKEN`.                                                                       | [Coder users API](https://coder.com/docs/reference/api/users)                              |
| `pr-agent`           | A workflow in `.github/workflows` uses `the-pr-agent/pr-agent` (or its earlier `qodo-ai`, `Codium-ai` names, or the `pragent/pr-agent` image).                                                     | [PR-Agent](https://github.com/the-pr-agent/pr-agent)                                       |
| `claude-code-action` | A workflow in `.github/workflows` uses `anthropics/claude-code-action`. The fix points at `/install-github-app` in Claude Code.                                                                    | [claude-code-action](https://github.com/anthropics/claude-code-action)                     |
| `coderabbit`         | The `coderabbitai` GitHub App is installed on the org (needs the selfhost App to have Administration read), else `coderabbitai[bot]` commented on recent pull requests.                            | [CodeRabbit on GitHub](https://docs.coderabbit.ai/platforms/github-com)                    |

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

## Adding a tool

1. Add its name to the tool list for its job in `packages/schema/src/config.ts`, plus any setting
   it needs, and run `pnpm --filter @selfhost/schema export`.
2. Add one file in `src/adapters/` exporting an `Adapter`: `kind`, `tool`, `describe()` and
   `check(settings, env, fetch, repos?)`.
3. List it in `ADAPTERS` in `src/registry.ts`, and add a test against the responses its docs
   record (`test/recorded.ts`). Tests never call the network.

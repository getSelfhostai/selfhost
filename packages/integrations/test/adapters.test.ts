import type { IntegrationKind, Integrations } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import {
  ADAPTERS,
  type CheckResult,
  checkIntegration,
  type Env,
  type RepoView,
} from "../src/index.js";
import { fakeFetch, RECORDED, type Recorded, withHeader } from "./recorded.js";

const KEY = "test-key-value-123";

async function check(
  integrations: Integrations,
  kind: IntegrationKind,
  answers: Parameters<typeof fakeFetch>[0],
  env: Env = {},
  repos?: RepoView,
) {
  const { fetch, sent } = fakeFetch(answers);
  const state = await checkIntegration(kind, integrations, {
    env,
    fetch,
    ...(repos ? { repos: async () => repos } : {}),
  });
  // No secret ever reaches a message.
  for (const value of Object.values(env)) {
    if (value) expect(state.detail).not.toContain(value);
  }
  return { state, sent };
}

const expectStatus = (result: CheckResult, status: CheckResult["status"], text: string) => {
  expect(result.status).toBe(status);
  expect(result.detail).toContain(text);
};

describe("adapters", () => {
  it("has one adapter per tool in the schema, each describing its check and docs", () => {
    const pairs = ADAPTERS.map((a) => `${a.kind}:${a.tool}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(pairs).toHaveLength(13);
    for (const adapter of ADAPTERS) {
      const description = adapter.describe();
      expect(description).toMatchObject({ kind: adapter.kind, tool: adapter.tool });
      expect(description.docs).toMatch(/^https:\/\//);
    }
  });

  it("reports not_configured when no tool is picked", async () => {
    const { state, sent } = await check({}, "router", {});
    expect(state).toMatchObject({ tool: null, status: "not_configured", settings: {} });
    expect(sent).toHaveLength(0);
  });
});

describe("bifrost", () => {
  const base = "http://bifrost:8080";

  it("checks the bundled Bifrost by default and asks whether admin sign-in is on", async () => {
    const { state, sent } = await check({ router: { tool: "bifrost" } }, "router", {
      [`GET ${base}/health`]: RECORDED.bifrostHealth,
      [`GET ${base}/api/session/is-auth-enabled`]: RECORDED.bifrostAuthOff,
    });
    expectStatus(state, "connected", "admin sign-in off");
    expect(sent.map((s) => s.url)).toEqual([
      `${base}/health`,
      `${base}/api/session/is-auth-enabled`,
    ]);
  });

  it("says to set admin_key_env when sign-in is on", async () => {
    const { state } = await check({ router: { tool: "bifrost" } }, "router", {
      [`GET ${base}/health`]: RECORDED.bifrostHealth,
      [`GET ${base}/api/session/is-auth-enabled`]: RECORDED.bifrostAuthOn,
    });
    expectStatus(state, "error", "Set admin_key_env");
  });

  it("sends a management key as Bearer and username:password as Basic", async () => {
    const config = (sent: { headers: Record<string, string> }): Recorded =>
      sent.headers.authorization === `Bearer ${KEY}` ||
      sent.headers.authorization === `Basic ${Buffer.from("admin:pw").toString("base64")}`
        ? RECORDED.bifrostConfig
        : { status: 401 };
    const answers = {
      [`GET ${base}/health`]: RECORDED.bifrostHealth,
      [`GET ${base}/api/config`]: config,
    };
    const integrations = { router: { tool: "bifrost" as const, admin_key_env: "BIFROST_KEY" } };
    expectStatus(
      (await check(integrations, "router", answers, { BIFROST_KEY: KEY })).state,
      "connected",
      "accepts the admin key in BIFROST_KEY",
    );
    expectStatus(
      (await check(integrations, "router", answers, { BIFROST_KEY: "admin:pw" })).state,
      "connected",
      "BIFROST_KEY",
    );
    expectStatus(
      (await check(integrations, "router", answers, { BIFROST_KEY: "wrong" })).state,
      "error",
      "refused the admin key in BIFROST_KEY (401)",
    );
    expectStatus(
      (await check(integrations, "router", answers, {})).state,
      "error",
      "Set the environment variable BIFROST_KEY",
    );
  });

  it("says how to start the bundled Bifrost when it cannot be reached", async () => {
    const { state } = await check({ router: { tool: "bifrost" } }, "router", {});
    expectStatus(state, "error", "Could not reach Bifrost at http://bifrost:8080 (ECONNREFUSED)");
    expect(state.detail).toContain("start it, or set url");
  });
});

describe("litellm", () => {
  const url = "http://litellm:4000";
  const integrations = { router: { tool: "litellm" as const, url, admin_key_env: "LITELLM_KEY" } };
  const answers = {
    [`GET ${url}/health/liveliness`]: RECORDED.litellmAlive,
    [`GET ${url}/v1/models`]: withHeader(
      "authorization",
      `Bearer ${KEY}`,
      RECORDED.litellmModels,
      RECORDED.litellmRefused,
    ),
  };

  it("checks liveness, then the master key on /v1/models", async () => {
    const { state, sent } = await check(integrations, "router", answers, { LITELLM_KEY: KEY });
    expectStatus(state, "connected", "accepts the master key in LITELLM_KEY");
    expect(sent.map((s) => s.url)).not.toContain(`${url}/health`);
  });

  it("names the variable when the key is refused", async () => {
    const { state } = await check(integrations, "router", answers, { LITELLM_KEY: "nope" });
    expectStatus(state, "error", "refused the key in LITELLM_KEY (401)");
  });

  it("needs url", async () => {
    const { state } = await check({ router: { tool: "litellm" } }, "router", {});
    expectStatus(state, "error", "Set url");
  });

  it("refuses credentials in url", async () => {
    const { state, sent } = await check(
      { router: { tool: "litellm", url: "http://user:pw@litellm:4000" } },
      "router",
      {},
    );
    expectStatus(state, "error", "holds a user name or password");
    expect(state.settings).toEqual({ url: "http://***@litellm:4000" });
    expect(sent).toHaveLength(0);
  });
});

describe("tracers", () => {
  it("langfuse: checks the Basic key on /api/public/projects", async () => {
    const auth = `Basic ${Buffer.from("pk-lf-1:sk-lf-1").toString("base64")}`;
    const integrations: Integrations = {
      tracer: {
        tool: "langfuse",
        endpoint: "https://cloud.langfuse.com/api/public/otel",
        headers_env: { Authorization: "LANGFUSE_OTLP_AUTH" },
      },
    };
    const answers = {
      "GET https://cloud.langfuse.com/api/public/projects": withHeader(
        "authorization",
        auth,
        RECORDED.langfuseProjects,
      ),
    };
    expectStatus(
      (await check(integrations, "tracer", answers, { LANGFUSE_OTLP_AUTH: auth })).state,
      "connected",
      "accepts the key in LANGFUSE_OTLP_AUTH (project agents)",
    );
    expectStatus(
      (await check(integrations, "tracer", answers, { LANGFUSE_OTLP_AUTH: "Basic bad" })).state,
      "error",
      "refused the key in LANGFUSE_OTLP_AUTH (401)",
    );
    expectStatus(
      (await check(integrations, "tracer", answers, {})).state,
      "error",
      "Set LANGFUSE_OTLP_AUTH (for the Authorization header)",
    );
  });

  it("langfuse: asks for headers_env and for the OTLP endpoint", async () => {
    expectStatus(
      (
        await check(
          { tracer: { tool: "langfuse", endpoint: "https://cloud.langfuse.com/api/public/otel" } },
          "tracer",
          {},
        )
      ).state,
      "error",
      'headers_env = { Authorization = "LANGFUSE_OTLP_AUTH" }',
    );
    expectStatus(
      (
        await check(
          { tracer: { tool: "langfuse", endpoint: "https://cloud.langfuse.com" } },
          "tracer",
          {},
        )
      ).state,
      "error",
      "endpoint should be Langfuse's OTLP endpoint",
    );
  });

  it("phoenix: health, then projects with the key", async () => {
    const base = "http://phoenix:6006";
    const answers = {
      [`GET ${base}/healthz`]: RECORDED.phoenixHealth,
      [`GET ${base}/v1/projects?limit=1`]: withHeader(
        "authorization",
        `Bearer ${KEY}`,
        RECORDED.phoenixProjects,
      ),
    };
    const withKey: Integrations = {
      tracer: {
        tool: "phoenix",
        endpoint: `${base}/v1/traces`,
        headers_env: { Authorization: "PHOENIX_AUTH" },
      },
    };
    expectStatus(
      (await check(withKey, "tracer", answers, { PHOENIX_AUTH: `Bearer ${KEY}` })).state,
      "connected",
      "Phoenix at http://phoenix:6006 is up",
    );
    expectStatus(
      (await check({ tracer: { tool: "phoenix", endpoint: base } }, "tracer", answers)).state,
      "error",
      "has auth on",
    );
  });

  it("datadog: validates the API key for the endpoint's site", async () => {
    const integrations: Integrations = {
      tracer: {
        tool: "datadog",
        endpoint: "https://otlp.datadoghq.eu/v1/traces",
        headers_env: { "dd-api-key": "DD_API_KEY" },
      },
    };
    const answers = {
      "GET https://api.datadoghq.eu/api/v1/validate": withHeader(
        "dd-api-key",
        KEY,
        RECORDED.datadogValid,
        RECORDED.datadogInvalid,
      ),
    };
    expectStatus(
      (await check(integrations, "tracer", answers, { DD_API_KEY: KEY })).state,
      "connected",
      "Datadog (datadoghq.eu) accepts the API key in DD_API_KEY",
    );
    expectStatus(
      (await check(integrations, "tracer", answers, { DD_API_KEY: "bad" })).state,
      "error",
      "refused the API key in DD_API_KEY",
    );
    expectStatus(
      (
        await check(
          { tracer: { tool: "datadog", endpoint: "https://intake.example.com" } },
          "tracer",
          {},
        )
      ).state,
      "error",
      "https://otlp.datadoghq.com",
    );
  });

  it("otlp: posts an empty protobuf export to /v1/traces", async () => {
    const answers = {
      "POST http://collector:4318/v1/traces": withHeader("authorization", `Bearer ${KEY}`, {
        status: 200,
      }),
    };
    const integrations: Integrations = {
      tracer: {
        tool: "otlp",
        endpoint: "http://collector:4318",
        headers_env: { Authorization: "OTLP_AUTH" },
      },
    };
    const ok = await check(integrations, "tracer", answers, { OTLP_AUTH: `Bearer ${KEY}` });
    expectStatus(ok.state, "connected", "accepted an empty export");
    expect(ok.sent[0]).toMatchObject({
      method: "POST",
      bodyBytes: 0,
      headers: { "content-type": "application/x-protobuf" },
    });
    expectStatus(
      (await check(integrations, "tracer", answers, { OTLP_AUTH: "Bearer bad" })).state,
      "error",
      "refused the headers from OTLP_AUTH (401)",
    );
    expectStatus(
      (
        await check({ tracer: { tool: "otlp", endpoint: "http://collector:4318/" } }, "tracer", {
          "POST http://collector:4318/v1/traces": { status: 404 },
        })
      ).state,
      "error",
      "selfhost adds /v1/traces",
    );
  });
});

describe("runtimes", () => {
  it("e2b: lists sandboxes with X-API-Key, E2B_API_KEY by default", async () => {
    const answers = {
      "GET https://api.e2b.app/v2/sandboxes?limit=1": withHeader(
        "x-api-key",
        KEY,
        RECORDED.e2bSandboxes,
        RECORDED.e2bRefused,
      ),
    };
    expectStatus(
      (await check({ runtime: { tool: "e2b" } }, "runtime", answers, { E2B_API_KEY: KEY })).state,
      "connected",
      "E2B at https://api.e2b.app accepts the key in E2B_API_KEY",
    );
    expectStatus(
      (
        await check({ runtime: { tool: "e2b", api_key_env: "MY_E2B" } }, "runtime", answers, {
          MY_E2B: "wrong-key",
        })
      ).state,
      "error",
      "refused the key in MY_E2B (401)",
    );
    expectStatus(
      (await check({ runtime: { tool: "e2b" } }, "runtime", answers)).state,
      "error",
      "Set the environment variable E2B_API_KEY (api_key_env)",
    );
  });

  it("daytona: reads the current API key with a Bearer token", async () => {
    const answers = {
      "GET https://app.daytona.io/api/api-keys/current": withHeader(
        "authorization",
        `Bearer ${KEY}`,
        RECORDED.daytonaKey,
      ),
    };
    expectStatus(
      (await check({ runtime: { tool: "daytona" } }, "runtime", answers, { DAYTONA_API_KEY: KEY }))
        .state,
      "connected",
      "accepts the key in DAYTONA_API_KEY",
    );
  });

  it("coder: build info, then the session token on users/me", async () => {
    const url = "https://coder.example.com";
    const answers = {
      [`GET ${url}/api/v2/buildinfo`]: RECORDED.coderBuildinfo,
      [`GET ${url}/api/v2/users/me`]: withHeader(
        "coder-session-token",
        KEY,
        RECORDED.coderMe,
        RECORDED.coderRefused,
      ),
    };
    const integrations: Integrations = { runtime: { tool: "coder", url } };
    expectStatus(
      (await check(integrations, "runtime", answers, { CODER_SESSION_TOKEN: KEY })).state,
      "connected",
      "Coder at https://coder.example.com accepts the key in CODER_SESSION_TOKEN",
    );
    expectStatus(
      (await check(integrations, "runtime", answers, { CODER_SESSION_TOKEN: "wrong-token" })).state,
      "error",
      "refused the key",
    );
    expectStatus(
      (await check({ runtime: { tool: "coder" } }, "runtime", answers)).state,
      "error",
      "Set url",
    );
  });

  it("modal: checks the token's two halves without a network call", async () => {
    const good = { MODAL_TOKEN_ID: "ak-test123", MODAL_TOKEN_SECRET: "as-test456" };
    const ok = await check({ runtime: { tool: "modal" } }, "runtime", {}, good);
    expectStatus(ok.state, "connected", "modal token info");
    expect(ok.sent).toHaveLength(0);
    expectStatus(
      (await check({ runtime: { tool: "modal" } }, "runtime", {}, { ...good, MODAL_TOKEN_ID: "x" }))
        .state,
      "error",
      "starts with ak-",
    );
    expectStatus(
      (
        await check(
          { runtime: { tool: "modal", api_secret_env: "MY_SECRET" } },
          "runtime",
          {},
          { MODAL_TOKEN_ID: "ak-1" },
        )
      ).state,
      "error",
      "Set the environment variable MY_SECRET (api_secret_env)",
    );
  });
});

describe("reviewers", () => {
  const view = (files: Record<string, string>, extra: Partial<RepoView> = {}): RepoView => ({
    via: "the selfhost GitHub App",
    repos: ["acme/api", "acme/web"],
    setup: "Install the App.",
    workflows: async (repo) =>
      Object.entries(files)
        .filter(([path]) => path.startsWith(`${repo}:`))
        .map(([path, text]) => ({ path: path.split(":")[1] ?? "", text })),
    ...extra,
  });

  it("pr-agent: finds the action under its current and earlier names", async () => {
    for (const uses of [
      "the-pr-agent/pr-agent@main",
      "qodo-ai/pr-agent@main",
      "Codium-ai/pr-agent@v0.29",
      "docker://pragent/pr-agent:0.30-github_action",
    ]) {
      const repos = view({
        "acme/api:.github/workflows/pr-agent.yml": `jobs:\n  review:\n    steps:\n      - uses: ${uses}\n        env:\n          OPENAI_KEY: \${{ secrets.OPENAI_KEY }}\n`,
      });
      const { state, sent } = await check(
        { reviewer: { tool: "pr-agent", api_key_env: "OPENAI_KEY" } },
        "reviewer",
        {},
        {},
        repos,
      );
      expect(state.detail).toBe(
        "PR-Agent runs from .github/workflows/pr-agent.yml in acme/api. Not in acme/web.",
      );
      expect(sent).toHaveLength(0);
    }
  });

  it("pr-agent: says how to add the workflow when no repository has it", async () => {
    const { state } = await check({ reviewer: { tool: "pr-agent" } }, "reviewer", {}, {}, view({}));
    expectStatus(state, "error", "No workflow in acme/api and acme/web runs PR-Agent");
    expect(state.detail).toContain("uses: the-pr-agent/pr-agent@main");
  });

  it("claude-code-action: finds the action and notes a key no workflow passes", async () => {
    const repos = view({
      "acme/web:.github/workflows/claude.yml":
        "steps:\n  - uses: anthropics/claude-code-action@v1\n    with:\n      claude_code_oauth_token: x\n",
    });
    const { state } = await check(
      { reviewer: { tool: "claude-code-action", api_key_env: "ANTHROPIC_API_KEY" } },
      "reviewer",
      {},
      {},
      repos,
    );
    expectStatus(state, "connected", ".github/workflows/claude.yml in acme/web");
    expect(state.detail).toContain("No workflow mentions ANTHROPIC_API_KEY");
  });

  it("claude-code-action: points at /install-github-app, and at setup without repositories", async () => {
    expectStatus(
      (await check({ reviewer: { tool: "claude-code-action" } }, "reviewer", {}, {}, view({})))
        .state,
      "error",
      "/install-github-app",
    );
    expectStatus(
      (await check({ reviewer: { tool: "claude-code-action" } }, "reviewer", {})).state,
      "error",
      "it has none to read",
    );
    expectStatus(
      (
        await check(
          { reviewer: { tool: "claude-code-action" } },
          "reviewer",
          {},
          {},
          view({}, { workflows: async () => undefined }),
        )
      ).state,
      "error",
      "Could not read .github/workflows in acme/api and acme/web through the selfhost GitHub App",
    );
  });

  it("coderabbit: installed, seen commenting, not installed, or not visible", async () => {
    const reviewer: Integrations = { reviewer: { tool: "coderabbit" } };
    expectStatus(
      (await check(reviewer, "reviewer", {}, {}, view({}, { appInstalled: async () => true })))
        .state,
      "connected",
      "CodeRabbit is installed on acme",
    );
    expectStatus(
      (
        await check(
          reviewer,
          "reviewer",
          {},
          {},
          view(
            {},
            {
              appInstalled: async () => undefined,
              recentBots: async (repo) => (repo === "acme/web" ? ["coderabbitai[bot]"] : []),
            },
          ),
        )
      ).state,
      "connected",
      "commented on recent pull requests in acme/web",
    );
    expectStatus(
      (await check(reviewer, "reviewer", {}, {}, view({}, { appInstalled: async () => false })))
        .state,
      "error",
      "is not installed on acme/api, acme/web",
    );
    expectStatus(
      (
        await check(
          reviewer,
          "reviewer",
          {},
          {},
          view({}, { appInstalled: async () => undefined, recentBots: async () => undefined }),
        )
      ).state,
      "error",
      "cannot list the org's GitHub Apps",
    );
    expectStatus(
      (await check(reviewer, "reviewer", {}, {}, view({}))).state,
      "error",
      "cannot see GitHub App installations from here",
    );
  });
});

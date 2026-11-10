import { bifrostClient } from "@selfhost/gateway";
import { fakeBifrost } from "@selfhost/gateway/testing";
import type { RepoView } from "@selfhost/integrations";
import { openLedger } from "@selfhost/ledger";
import {
  type CreateTeamResponse,
  createValidator,
  type IntegrationsResponse,
  IntegrationsResponseSchema,
  type InvalidPolicyError,
  type JoinResponse,
  type PersonRole,
  type PolicyResponse,
} from "@selfhost/schema";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { BACKENDS, caller, TOKEN } from "./helpers.js";

const E2B_KEY = "test-e2b-key";
const responseShape = createValidator(IntegrationsResponseSchema);

/** Only E2B's sandbox list answers, from its docs; everything else is unreachable. */
const recordedFetch = async (url: string, init?: RequestInit) => {
  const key = new Headers(init?.headers).get("x-api-key");
  if (url === "https://api.e2b.app/v2/sandboxes?limit=1") {
    return new Response(key === E2B_KEY ? "[]" : '{"code":401}', {
      status: key === E2B_KEY ? 200 : 401,
    });
  }
  throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
};

const REPOS: RepoView = {
  via: "the selfhost GitHub App",
  repos: ["acme/api"],
  setup: "Install the App.",
  workflows: async () => [
    {
      path: ".github/workflows/claude.yml",
      text: "steps:\n  - uses: anthropics/claude-code-action@v1\n",
    },
  ],
};

describe.each(BACKENDS)("integrations on $name", (backend) => {
  let store: Awaited<ReturnType<(typeof BACKENDS)[number]["open"]>>;
  let app: Hono;
  let admin: ReturnType<typeof caller>;
  let web: CreateTeamResponse;
  const as = {} as Record<PersonRole, ReturnType<typeof caller>>;

  const join = async (invite: string, person: string) => {
    const res = await app.request("/v1/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite, person }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as JoinResponse;
  };

  beforeAll(async () => {
    if (backend.skip) return;
    store = await backend.open();
    app = createApp({
      version: "test",
      ledger: store.ledger,
      token: TOKEN,
      integrations: {
        env: { E2B_API_KEY: E2B_KEY },
        fetch: recordedFetch,
        repos: async () => REPOS,
      },
    });
    admin = caller(app, TOKEN);
    expect((await admin("/v1/orgs", "POST", { name: "Acme" })).status).toBe(201);
    web = (await (
      await admin("/v1/teams", "POST", { name: "Web", org: "acme" })
    ).json()) as CreateTeamResponse;
    as.owner = caller(app, (await join(web.invite, "ada@example.com")).token);
    as.admin = caller(app, (await join(web.invite, "adam@example.com")).token);
    as.member = caller(app, (await join(web.invite, "mia@example.com")).token);
    const path = `/v1/teams/web/people/${encodeURIComponent("adam@example.com")}/role`;
    expect((await admin(path, "PUT", { role: "admin" })).status).toBe(200);
  });

  afterAll(async () => {
    await store?.close();
  });

  const read = async (call: ReturnType<typeof caller>, path = "/v1/integrations") => {
    const res = await call(path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as IntegrationsResponse;
    expect(responseShape.validate(body).ok).toBe(true);
    return body;
  };

  it.skipIf(backend.skip)("reports every job not_configured before any policy", async () => {
    const body = await read(as.member);
    expect(body.schema).toBe("selfhost.integrations/v1");
    expect(body.team).toBe("web");
    for (const kind of ["router", "tracer", "runtime", "reviewer"] as const) {
      expect(body.integrations[kind]).toMatchObject({
        tool: null,
        status: "not_configured",
        settings: {},
      });
    }
    expect((await admin("/v1/integrations")).status).toBe(400);
    expect((await read(admin, "/v1/integrations?team=web")).team).toBe("web");
  });

  it.skipIf(backend.skip)("lets owners and admins pick a tool and members only read", async () => {
    const body = { tool: "e2b", settings: { template: "base" } };
    const refused = await as.member("/v1/integrations/runtime", "PUT", body);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain(
      "needs the owner or admin role",
    );
    for (const who of [as.owner, as.admin]) {
      const res = await who("/v1/integrations/runtime", "PUT", body);
      expect(res.status).toBe(200);
      const state = ((await res.json()) as IntegrationsResponse).integrations.runtime;
      expect(state).toEqual({
        tool: "e2b",
        status: "connected",
        detail: "E2B at https://api.e2b.app accepts the key in E2B_API_KEY.",
        settings: { template: "base" },
        checked_at: expect.any(String),
      });
    }
    expect((await admin("/v1/integrations/runtime?team=web", "PUT", { tool: "e2b" })).status).toBe(
      200,
    );
  });

  it.skipIf(backend.skip)("writes the table into the team policy and keeps the rest", async () => {
    const text = `version = 1

# Agents may not push to main.
[[rules]]
id = "no-push-main"
match = { tool = "Bash", command = "git push .* main" }
action = "block"
message = "Open a pull request."
`;
    expect((await as.owner("/v1/policy", "PUT", { text })).status).toBe(200);
    const res = await as.admin("/v1/integrations/reviewer", "PUT", {
      tool: "claude-code-action",
      settings: { api_key_env: "ANTHROPIC_API_KEY" },
    });
    expect(res.status).toBe(200);
    const reviewer = ((await res.json()) as IntegrationsResponse).integrations.reviewer;
    expect(reviewer.status).toBe("connected");
    expect(reviewer.detail).toContain(".github/workflows/claude.yml in acme/api");
    const policy = (await (await as.member("/v1/policy")).json()) as PolicyResponse;
    expect(policy.text).toBe(
      `${text}\n[integrations.reviewer]\ntool = "claude-code-action"\napi_key_env = "ANTHROPIC_API_KEY"\n`,
    );
    expect(policy.config.rules?.map((r) => r.id)).toEqual(["no-push-main"]);

    const removed = await as.owner("/v1/integrations/reviewer", "PUT", { tool: null });
    expect(((await removed.json()) as IntegrationsResponse).integrations.reviewer.tool).toBeNull();
    expect(((await (await as.member("/v1/policy")).json()) as PolicyResponse).text).toBe(text);
  });

  it.skipIf(backend.skip)(
    "validates the tool and its settings and stores nothing on error",
    async () => {
      const before = ((await (await as.member("/v1/policy")).json()) as PolicyResponse).text;
      const cases: [string, unknown, string][] = [
        ["/v1/integrations/router", { tool: "nginx" }, "integrations.router.tool"],
        [
          "/v1/integrations/router",
          { tool: "litellm", settings: { api_key: "sk-123" } },
          "integrations.router",
        ],
        [
          "/v1/integrations/runtime",
          { tool: "e2b", settings: { api_key_env: "not a name" } },
          "runtime.providers.e2b.api_key_env",
        ],
        ["/v1/integrations/router", { tool: "bifrost", settings: { tool: "x" } }, "tool"],
      ];
      for (const [path, body, field] of cases) {
        const res = await as.owner(path, "PUT", body);
        expect(res.status).toBe(400);
        const error = (await res.json()) as InvalidPolicyError;
        expect(error.error.code).toBe("invalid_policy");
        expect(error.errors[0]?.field).toContain(field);
      }
      expect((await as.owner("/v1/integrations/gateway", "PUT", { tool: "bifrost" })).status).toBe(
        400,
      );
      expect(((await (await as.member("/v1/policy")).json()) as PolicyResponse).text).toBe(before);
    },
  );

  it.skipIf(backend.skip)("refuses a table written inline instead of rewriting it", async () => {
    const text = 'version = 1\n[integrations]\nrouter = { tool = "bifrost" }\n';
    expect((await as.owner("/v1/policy", "PUT", { text })).status).toBe(200);
    const res = await as.owner("/v1/integrations/router", "PUT", { tool: "litellm" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("cannot_edit");
  });

  it.skipIf(backend.skip)("layers the org's choice under the team's", async () => {
    const org = `version = 1
[integrations.tracer]
tool = "otlp"
endpoint = "http://collector:4318"

[integrations.runtime]
tool = "coder"
url = "https://coder.example.com"
`;
    expect((await admin("/v1/orgs/acme/policy", "PUT", { text: org })).status).toBe(200);
    expect((await as.owner("/v1/policy", "PUT", { text: "version = 1\n" })).status).toBe(200);
    let body = await read(as.member);
    expect(body.integrations.tracer).toMatchObject({ tool: "otlp", status: "error" });
    expect(body.integrations.tracer.detail).toContain("Could not reach the OTLP endpoint");
    expect(body.integrations.runtime.tool).toBe("coder");

    const res = await as.admin("/v1/integrations/runtime", "PUT", { tool: "e2b" });
    expect(res.status).toBe(200);
    body = (await res.json()) as IntegrationsResponse;
    expect(body.integrations.runtime).toMatchObject({
      tool: "e2b",
      status: "connected",
      settings: {},
    });
    expect(body.integrations.tracer.tool).toBe("otlp");
  });
});

describe("integration check cache", () => {
  it("serves a team's results for 60 seconds and checks again when the choice changes", async () => {
    const ledger = await openLedger({ dataDir: "memory://" });
    let clock = new Date("2026-11-08T10:00:00.000Z");
    const calls: string[] = [];
    const app = createApp({
      version: "test",
      ledger,
      token: TOKEN,
      now: () => clock,
      integrations: {
        env: { E2B_API_KEY: E2B_KEY },
        fetch: async (url, init) => {
          calls.push(url);
          return recordedFetch(url, init);
        },
      },
    });
    const admin = caller(app, TOKEN);
    expect((await admin("/v1/teams", "POST", { name: "Web" })).status).toBe(201);
    const runtime = async () => {
      const res = await admin("/v1/integrations?team=web");
      expect(res.status).toBe(200);
      return ((await res.json()) as IntegrationsResponse).integrations.runtime;
    };
    const setPolicy = (text: string) =>
      admin("/v1/policy?team=web", "PUT", { text }).then((res) => expect(res.status).toBe(200));

    await setPolicy('version = 1\n[integrations.runtime]\ntool = "e2b"\n');
    expect(await runtime()).toMatchObject({
      status: "connected",
      checked_at: "2026-11-08T10:00:00.000Z",
    });
    expect(calls).toHaveLength(1);

    clock = new Date("2026-11-08T10:00:59.000Z");
    expect((await runtime()).checked_at).toBe("2026-11-08T10:00:00.000Z");
    expect(calls).toHaveLength(1);

    clock = new Date("2026-11-08T10:01:00.000Z");
    expect((await runtime()).checked_at).toBe("2026-11-08T10:01:00.000Z");
    expect(calls).toHaveLength(2);

    // A policy change is a new choice, checked at once.
    clock = new Date("2026-11-08T10:01:10.000Z");
    await setPolicy('version = 1\n[integrations.runtime]\ntool = "e2b"\ntemplate = "base"\n');
    expect(await runtime()).toMatchObject({
      settings: { template: "base" },
      checked_at: "2026-11-08T10:01:10.000Z",
    });
    expect(calls).toHaveLength(3);

    // A PUT checks again even when it changes nothing, and the GET after it reuses that.
    clock = new Date("2026-11-08T10:01:20.000Z");
    const put = await admin("/v1/integrations/runtime?team=web", "PUT", {
      tool: "e2b",
      settings: { template: "base" },
    });
    expect(((await put.json()) as IntegrationsResponse).integrations.runtime.checked_at).toBe(
      "2026-11-08T10:01:20.000Z",
    );
    expect(calls).toHaveLength(4);
    expect((await runtime()).checked_at).toBe("2026-11-08T10:01:20.000Z");
    expect(calls).toHaveLength(4);
    await ledger.close();
  });
});

describe("the server's own gateway", () => {
  it("shows as the router of a team whose policy picks none, from the server environment", async () => {
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      const fake = fakeBifrost();
      let healthy = true;
      const client = bifrostClient({
        url: "http://bifrost:8080",
        username: "selfhost",
        password: fake.password,
        fetch: fake.fetch,
        minIntervalMs: 0,
      });
      const app = createApp({
        version: "test",
        ledger,
        token: TOKEN,
        integrations: { env: {}, fetch: recordedFetch },
        gateway: {
          client: {
            ...client,
            tool: client.tool,
            health: async () =>
              healthy ? client.health() : { ok: false, detail: "connection refused" },
          },
          baseUrl: "https://selfhost.example.com/llm",
          state: { sync: null, usage: null },
        },
      });
      const admin = caller(app, TOKEN);
      expect((await admin("/v1/teams", "POST", { name: "Web" })).status).toBe(201);
      const router = async () => {
        const res = await admin("/v1/integrations?team=web");
        const body = (await res.json()) as IntegrationsResponse;
        expect(responseShape.validate(body).ok).toBe(true);
        return body.integrations.router;
      };
      expect(await router()).toMatchObject({
        tool: "bifrost",
        status: "connected",
        source: "server_environment",
        settings: { url: "https://selfhost.example.com/llm" },
      });
      expect((await router()).detail).toContain("set up in its environment");

      // The team's own choice wins, and is checked as its policy says.
      const text =
        'version = 1\n[integrations.router]\ntool = "litellm"\nurl = "http://litellm:4000"\n';
      expect((await admin("/v1/policy?team=web", "PUT", { text })).status).toBe(200);
      const own = await router();
      expect(own.tool).toBe("litellm");
      expect(own.source).toBeUndefined();

      healthy = false;
      expect((await admin("/v1/policy?team=web", "PUT", { text: "version = 1\n" })).status).toBe(
        200,
      );
      expect(await router()).toMatchObject({ status: "error", source: "server_environment" });
    } finally {
      await ledger.close();
    }
  });
});

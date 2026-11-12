import { Octokit } from "@octokit/rest";
import type { FakeGitHub } from "@selfhost/github/testing";
import { type LedgerEvent, validateEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { egressBlockedEvent, prepareCredentials, withCredentials } from "../src/index.js";
import { fakeStores, gateway, github, POLICY, policy, SERVER_ENV, VALUES } from "./helpers.js";

const NOW = new Date("2026-11-09T10:00:00Z");
const RUN = { id: "run-7", team: "platform", repo: "acme/acme-api", target: "e2b" as const };

function setup(options: { failVault?: number } = {}) {
  const gh = github();
  const gw = gateway();
  const stores = fakeStores(options);
  const recorded: LedgerEvent[] = [];
  const deps = {
    env: SERVER_ENV,
    fetch: stores.fetch,
    github: gh.app,
    gateway: { client: gw.client, baseUrl: gw.baseUrl },
    record: async (events: LedgerEvent[]) => {
      recorded.push(...events);
    },
    now: () => NOW,
  };
  return { gh, gw, stores, recorded, deps };
}

const asToken = (fake: FakeGitHub, token: string) =>
  new Octokit({ auth: token, request: { fetch: fake.fetch } });

const allValues = () => Object.values(VALUES);

describe("prepareCredentials", () => {
  it("gives the run a token for its one repository, a gateway key and its declared secrets", async () => {
    const { gh, deps, gw } = setup();
    const prepared = await prepareCredentials(RUN, POLICY, deps);

    expect(prepared.secrets).toEqual([
      { name: "GITHUB_TOKEN", from: "github-app:repo" },
      { name: "ANTHROPIC_AUTH_TOKEN", from: "gateway:run" },
      { name: "OPENAI_API_KEY", from: "gateway:run" },
      { name: "DATABASE_URL", from: "vault:selfhost/platform/acme-api/ci#database_url" },
      { name: "SENTRY_DSN", from: "env:SELFHOST_RUN_SECRET_PLATFORM__SENTRY_DSN" },
      { name: "STRIPE_KEY", from: "infisical:/selfhost/platform/payments#STRIPE_KEY" },
    ]);
    // The provider key the repository declared never reaches the sandbox: the gateway key does.
    expect(Object.keys(prepared.env)).not.toContain("ANTHROPIC_API_KEY");
    expect(JSON.stringify(prepared.env)).not.toContain(VALUES.anthropic);
    expect(prepared.env.DATABASE_URL).toBe(VALUES.database);
    expect(prepared.env.STRIPE_KEY).toBe(VALUES.stripe);
    expect(
      prepared.resolve({
        name: "SENTRY_DSN",
        from: "env:SELFHOST_RUN_SECRET_PLATFORM__SENTRY_DSN",
      }),
    ).toBe(VALUES.sentry);

    const minted = gh.fake.requests.find((r) => r.path === "/app/installations/42/access_tokens");
    expect(minted?.body).toEqual({
      repositories: ["acme-api"],
      permissions: { contents: "write", pull_requests: "write", metadata: "read" },
    });

    const [key] = [...gw.fake.keys.values()];
    expect(key).toMatchObject({ name: "selfhost:run:platform:run-7", is_active: true });
    expect(key?.budgets).toEqual([expect.objectContaining({ max_limit: 5 })]);
    expect(prepared.env.ANTHROPIC_AUTH_TOKEN).toBe(key?.value);
    expect(prepared.env.OPENAI_API_KEY).toBe(key?.value);
    expect(prepared.plainEnv).toEqual({
      SELFHOST_LOCATION: "runtime:e2b",
      ANTHROPIC_BASE_URL: "https://selfhost.acme.test/llm/anthropic",
      OPENAI_BASE_URL: "https://selfhost.acme.test/llm/openai/v1",
    });
  });

  it("reads Vault and Infisical with their own tokens and settings", async () => {
    const { stores, deps } = setup();
    await prepareCredentials(RUN, POLICY, deps);
    const vault = stores.calls.find((c) => c.url.includes("vault.acme.test"));
    expect(vault?.url).toBe(
      "https://vault.acme.test:8200/v1/secret/data/selfhost/platform/acme-api/ci",
    );
    expect(vault?.headers["x-vault-namespace"]).toBe("eng");
    const infisical = stores.calls.find((c) => c.url.includes("infisical.acme.test"));
    expect(infisical?.url).toBe(
      "https://infisical.acme.test/api/v4/secrets/STRIPE_KEY?projectId=proj-acme&environment=ci&secretPath=%2Fselfhost%2Fplatform%2Fpayments",
    );
  });

  it("puts the run's person on its gateway key with the run id, so its spend is theirs", async () => {
    const { deps, gw } = setup();
    await prepareCredentials({ ...RUN, person: "ana@acme.test" }, POLICY, deps);
    const [key] = [...gw.fake.keys.values()];
    expect(key?.name).toBe("selfhost:run:platform:run-7");
    expect(key?.metadata).toMatchObject({
      selfhost_kind: "run",
      selfhost_team: "platform",
      selfhost_run: "run-7",
      selfhost_person: "ana@acme.test",
    });
  });

  it("limits egress to the team's list plus the repository's and the gateway's hosts", async () => {
    const { deps } = setup();
    const platform = await prepareCredentials(RUN, POLICY, deps);
    expect(platform.egress?.allow).toEqual([
      "registry.npmjs.org",
      "*.pythonhosted.org",
      "pypi.org",
      "api.stripe.com",
      "10.20.0.0/16",
      "github.com",
      "api.github.com",
      "selfhost.acme.test",
    ]);
    // Team payments may not read platform's secrets, so its run declares none here.
    const { secrets: _platformOnly, ...noSecrets } = POLICY;
    const payments = await prepareCredentials(
      { ...RUN, team: "payments" },
      noSecrets,
      setup().deps,
    );
    expect(payments.egress?.allow).toEqual([
      "registry.npmjs.org",
      "api.stripe.com",
      "github.com",
      "api.github.com",
      "selfhost.acme.test",
    ]);
    expect(payments.native.egress).toEqual({
      target: "e2b",
      create: {
        network: {
          allowOut: [
            "registry.npmjs.org",
            "api.stripe.com",
            "github.com",
            "api.github.com",
            "selfhost.acme.test",
          ],
          denyOut: ["0.0.0.0/0"],
        },
      },
    });
  });

  it("injects the Stripe key at E2B's egress, so the sandbox holds a placeholder", async () => {
    const { deps } = setup();
    const prepared = await prepareCredentials(RUN, POLICY, deps);
    expect(prepared.native.secrets.env.STRIPE_KEY).toBe("selfhost-injected-stripe_key");
    expect(prepared.native.secrets.inject).toEqual([
      {
        name: "STRIPE_KEY",
        host: "api.stripe.com",
        header: "Authorization",
        format: "Bearer {value}",
        value: VALUES.stripe,
      },
    ]);
    expect(prepared.gaps).toEqual([]);
  });

  it("builds the sandbox spec by reference, with no value in it", async () => {
    const { deps } = setup();
    const prepared = await prepareCredentials(RUN, POLICY, deps);
    const spec = prepared.spec({
      timeoutMinutes: 30,
      env: { CI: "1" },
      repo: { url: "https://github.com/acme/acme-api" },
    });
    expect(spec.env).toMatchObject({ CI: "1", SELFHOST_LOCATION: "runtime:e2b" });
    expect(spec.secrets?.map((s) => s.name)).toContain("GITHUB_TOKEN");
    expect(spec.egress?.allow).toContain("github.com");
    expect(spec.labels).toEqual({ "selfhost-run": "run-7", "selfhost-team": "platform" });
    const text = JSON.stringify(spec);
    for (const value of [...allValues(), ...Object.values(prepared.env)]) {
      expect(text).not.toContain(value);
    }
  });

  it("lets the runtime adapter read every issued value through the spec, not only env: refs", async () => {
    const { deps } = setup();
    const prepared = await prepareCredentials(RUN, POLICY, deps);
    const own = { name: "CI_TOKEN", from: "env:CI_TOKEN" };
    const spec = prepared.spec({ timeoutMinutes: 30, secrets: [own] });
    for (const ref of prepared.secrets) {
      expect(await spec.resolveSecret?.(ref)).toBe(prepared.env[ref.name]);
    }
    expect(await spec.resolveSecret?.({ name: "GITHUB_TOKEN", from: "env:GITHUB_TOKEN" })).toBe(
      undefined,
    );
    // A secret of the base spec is left to the adapter's own resolver.
    expect(await spec.resolveSecret?.(own)).toBe(undefined);
  });

  it("records credential.issued events that validate and carry no value", async () => {
    const { deps, recorded } = setup();
    const prepared = await prepareCredentials(RUN, POLICY, deps);
    expect(recorded).toEqual(prepared.events);
    expect(recorded.map((e) => [e.kind, e.data?.name])).toEqual([
      ["credential.issued", "GITHUB_TOKEN"],
      ["credential.issued", "ANTHROPIC_AUTH_TOKEN"],
      ["credential.issued", "DATABASE_URL"],
      ["credential.issued", "SENTRY_DSN"],
      ["credential.issued", "STRIPE_KEY"],
    ]);
    for (const event of recorded) expect(validateEvent(event).ok).toBe(true);
    expect(recorded[0]).toMatchObject({
      run_id: "run-7",
      team: "platform",
      repo: "acme/acme-api",
      data: {
        v: 1,
        credential: "github_app_token",
        source: "github-app",
        repository: "acme/acme-api",
        location: "runtime:e2b",
      },
    });
    expect(recorded[1]?.data).toMatchObject({ credential: "gateway_key", budget_usd: 5 });
    expect(recorded[4]?.data).toMatchObject({ injected_for: "api.stripe.com" });
    expect(prepared.scan(recorded.map((e) => JSON.stringify(e)))).toEqual([]);
  });
});

describe("revoke", () => {
  it("revokes the GitHub token and turns off the gateway key, once", async () => {
    const { gh, gw, deps, recorded } = setup();
    const prepared = await prepareCredentials(RUN, POLICY, deps);
    const token = prepared.env.GITHUB_TOKEN as string;
    const octokit = asToken(gh.fake, token);
    await expect(octokit.rest.repos.get({ owner: "acme", repo: "acme-api" })).resolves.toBeTruthy();
    await expect(octokit.rest.repos.get({ owner: "acme", repo: "acme-web" })).rejects.toMatchObject(
      {
        status: 404,
      },
    );

    const report = await prepared.revoke("timed_out");
    expect(report.ok).toBe(true);
    await expect(octokit.rest.repos.get({ owner: "acme", repo: "acme-api" })).rejects.toMatchObject(
      {
        status: 401,
      },
    );
    expect([...gw.fake.keys.values()][0]?.is_active).toBe(false);
    expect(report.events.map((e) => [e.kind, e.data?.name, e.data?.reason, e.data?.ok])).toEqual([
      ["credential.revoked", "GITHUB_TOKEN", "timed_out", true],
      ["credential.revoked", "ANTHROPIC_AUTH_TOKEN", "timed_out", true],
    ]);
    expect(recorded.filter((e) => e.kind === "credential.revoked")).toHaveLength(2);

    const calls = gh.fake.requests.length;
    expect(await prepared.revoke("killed")).toBe(report);
    expect(gh.fake.requests.length).toBe(calls);
  });

  it("revokes when the run fails, and when the body is killed", async () => {
    const { gh, deps } = setup();
    await expect(
      withCredentials(RUN, POLICY, deps, async () => {
        throw new Error("agent crashed");
      }),
    ).rejects.toThrow("agent crashed");
    const killed = new AbortController();
    const second = setup();
    await expect(
      withCredentials(
        RUN,
        POLICY,
        second.deps,
        async () => {
          killed.abort("stopped by a person");
          throw new Error("aborted");
        },
        killed.signal,
      ),
    ).rejects.toThrow("aborted");
    const revoked = (events: LedgerEvent[]) =>
      events.filter((e) => e.kind === "credential.revoked").map((e) => e.data?.reason);
    expect(gh.fake.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    expect(revoked(second.recorded)).toEqual(["killed", "killed"]);
  });

  it("revokes what was issued when a later secret cannot be read, and names no value", async () => {
    const { gh, gw, deps, recorded } = setup({ failVault: 503 });
    const error = await prepareCredentials(RUN, POLICY, deps).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Credentials for run run-7: vault:selfhost/platform/acme-api/ci#database_url: HTTP 503",
    );
    expect(gh.fake.requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/installation/token",
    });
    expect([...gw.fake.keys.values()][0]?.is_active).toBe(false);
    expect(recorded.map((e) => [e.kind, e.data?.reason])).toEqual([
      ["credential.revoked", "aborted"],
      ["credential.revoked", "aborted"],
    ]);
    for (const value of allValues()) expect(JSON.stringify(recorded)).not.toContain(value);
  });

  it("reports a revoke GitHub refuses without throwing", async () => {
    const { gh, deps } = setup();
    const prepared = await prepareCredentials(RUN, POLICY, deps);
    // A 5xx is tried again by the App client; a refusal is not.
    gh.fake.failNext("DELETE", /^\/installation\/token$/, 403);
    const report = await prepared.revoke();
    expect(report.ok).toBe(false);
    expect(report.events[0]?.data).toMatchObject({ ok: false, reason: "succeeded" });
  });
});

describe("redaction and the leak scan", () => {
  it("masks the run's values in ledger events and finds leaks as is or encoded", async () => {
    const { deps } = setup();
    const prepared = await prepareCredentials(RUN, POLICY, deps);
    const event: LedgerEvent = {
      id: "0193a6f0-0000-7000-8000-000000000001",
      schema: "selfhost.event/v1",
      ts: NOW.toISOString(),
      source: "hook",
      kind: "tool.called",
      actor: { kind: "agent", id: "run-7" },
      tool: { name: "Bash", input_summary: `echo ${VALUES.sentry} | base64` },
      data: { output: `connected with ${VALUES.database}` },
    };
    const masked = prepared.masker.event(event);
    expect(masked.tool?.input_summary).toBe("echo [redacted:SENTRY_DSN] | base64");
    expect(masked.data?.output).toBe("connected with [redacted:DATABASE_URL]");
    expect(masked.redacted).toEqual(["tool.input_summary", "data.output"]);

    const encoded = Buffer.from(VALUES.stripe).toString("base64");
    expect(
      prepared.scan([JSON.stringify(event), JSON.stringify(masked), `log: ${encoded}`]),
    ).toEqual([
      { index: 0, name: "DATABASE_URL", form: "raw" },
      { index: 0, name: "SENTRY_DSN", form: "raw" },
      { index: 2, name: "STRIPE_KEY", form: "base64" },
    ]);
    expect(prepared.masker.text(`token=${prepared.env.GITHUB_TOKEN}`)).toBe(
      "token=[redacted:GITHUB_TOKEN]",
    );
    expect(prepared.redaction({ logPrompts: false, patterns: [] }).literals).toHaveLength(6);
  });
});

describe("without a gateway or a GitHub App", () => {
  it("passes a declared provider key and mints no token", async () => {
    const stores = fakeStores();
    const config = policy(`version = 1
[secrets.env]
ANTHROPIC_API_KEY = "env:SELFHOST_RUN_SECRET_SHARED__ANTHROPIC_API_KEY"
`);
    const prepared = await prepareCredentials({ id: "r", team: "t", target: "daytona" }, config, {
      env: SERVER_ENV,
      fetch: stores.fetch,
    });
    expect(prepared.env).toEqual({ ANTHROPIC_API_KEY: VALUES.anthropic });
    expect(prepared.egress).toBeUndefined();
    expect(prepared.native.egress).toBeUndefined();
    expect(prepared.native.secrets.env).toEqual({ ANTHROPIC_API_KEY: VALUES.anthropic });
    expect(prepared.gaps).toEqual([
      expect.objectContaining({ rule: "secrets.env.ANTHROPIC_API_KEY", effect: "weaker" }),
    ]);
    expect((await prepared.revoke()).events).toEqual([]);
  });

  it("fails on an env source the server does not have", async () => {
    const config = policy(`version = 1
[secrets.env]
TOKEN = "env:SELFHOST_RUN_SECRET_T__NOT_SET"
`);
    await expect(
      prepareCredentials({ id: "r", team: "t", target: "e2b" }, config, { env: {} }),
    ).rejects.toThrow(
      "Credentials for run r: env:SELFHOST_RUN_SECRET_T__NOT_SET: not set on the server",
    );
  });
});

describe("what a policy can make the server read", () => {
  const ADMIN = ["admin", "token", "0123"].join("-");

  it("refuses an env: source outside the team's SELFHOST_RUN_SECRET_<TEAM>__*, even past the schema", async () => {
    // As a stored config object that skipped parseConfig would carry it.
    const config = {
      ...policy("version = 1\n"),
      secrets: { env: { STOLEN: "env:SELFHOST_TOKEN" } },
    };
    await expect(
      prepareCredentials({ id: "r", team: "t", target: "e2b" }, config, {
        env: { SELFHOST_TOKEN: ADMIN },
      }),
    ).rejects.toThrow(
      "env:SELFHOST_TOKEN: team t reads only server variables named SELFHOST_RUN_SECRET_T__<NAME>",
    );
  });

  it("gives a team only its own env: variables, and shared ones only when the server allows it", async () => {
    const env = {
      SELFHOST_RUN_SECRET_WEB__DB: "web-db",
      SELFHOST_RUN_SECRET_WEB_PLATFORM__DB: "web-platform-db",
      SELFHOST_RUN_SECRET_DB: "old-style",
      SELFHOST_RUN_SECRET_SHARED__NPM: "npm",
      SELFHOST_RUN_SECRET_SHARED_TEAMS: "web-platform",
    };
    const run = (team: string, from: string) =>
      prepareCredentials(
        { id: "r", team, target: "e2b" },
        policy(`version = 1\n[secrets.env]\nV = "${from}"\n`),
        { env },
      ).then((prepared) => prepared.env.V);

    expect(await run("web", "env:SELFHOST_RUN_SECRET_WEB__DB")).toBe("web-db");
    expect(await run("web-platform", "env:SELFHOST_RUN_SECRET_WEB_PLATFORM__DB")).toBe(
      "web-platform-db",
    );
    // Another team's variable, even one whose name starts with this team's id.
    await expect(run("web", "env:SELFHOST_RUN_SECRET_WEB_PLATFORM__DB")).rejects.toThrow(
      "team web reads only server variables named SELFHOST_RUN_SECRET_WEB__<NAME>",
    );
    await expect(run("web-platform", "env:SELFHOST_RUN_SECRET_WEB__DB")).rejects.toThrow(
      /team web-platform reads only/,
    );
    // The single prefix every team shared before.
    await expect(run("web", "env:SELFHOST_RUN_SECRET_DB")).rejects.toThrow(/team web reads only/);
    expect(await run("web-platform", "env:SELFHOST_RUN_SECRET_SHARED__NPM")).toBe("npm");
    await expect(run("web", "env:SELFHOST_RUN_SECRET_SHARED__NPM")).rejects.toThrow(
      "SELFHOST_RUN_SECRET_SHARED__NPM is a shared run secret and SELFHOST_RUN_SECRET_SHARED_TEAMS on the server does not list team web",
    );
  });

  it("reads Vault and Infisical only under the team's path prefix", async () => {
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      calls.push(String(input));
      return String(input).includes("vault")
        ? Response.json({ data: { data: { k: "v" } } })
        : Response.json({ secret: { secretValue: "i" } });
    };
    const env = {
      VAULT_ADDR: "https://vault.acme.test",
      VAULT_TOKEN: "vt",
      INFISICAL_URL: "https://infisical.acme.test",
      INFISICAL_PROJECT_ID: "p",
      INFISICAL_ENVIRONMENT: "ci",
      INFISICAL_TOKEN: "it",
    };
    const run = (team: string, from: string, more: NodeJS.ProcessEnv = {}) =>
      prepareCredentials(
        { id: "r", team, target: "e2b" },
        policy(`version = 1\n[secrets.env]\nV = "${from}"\n`),
        { env: { ...env, ...more }, fetch },
      ).then((prepared) => prepared.env.V);

    expect(await run("web", "vault:selfhost/web/db#k")).toBe("v");
    expect(await run("web", "infisical:/selfhost/web#K")).toBe("i");
    for (const from of [
      "vault:selfhost/web-platform/db#k",
      "vault:selfhost/web/../web-platform/db#k",
      "vault:selfhost/web/%2e%2e/web-platform/db#k",
      "vault:selfhost/web/db?version=1#k",
      "vault:other/db#k",
      "infisical:K",
      "infisical:/selfhost/webx#K",
    ]) {
      await expect(run("web", from), from).rejects.toThrow(
        /team web reads only (vault|infisical) paths under \/?selfhost\/web\//,
      );
    }
    expect(calls).toHaveLength(2);
    // The server's own prefix, with {team} for the team id.
    expect(
      await run("web", "vault:kv/teams/web/db#k", {
        SELFHOST_SECRET_PATH_PREFIX: "kv/teams/{team}",
      }),
    ).toBe("v");
    await expect(
      run("web", "vault:selfhost/web/db#k", { SELFHOST_SECRET_PATH_PREFIX: "kv/teams/{team}" }),
    ).rejects.toThrow("team web reads only vault paths under kv/teams/web/");
    await expect(
      run("web", "vault:shared/db#k", { SELFHOST_SECRET_PATH_PREFIX: "shared/" }),
    ).rejects.toThrow("SELFHOST_SECRET_PATH_PREFIX on the server must contain {team}");
  });

  it("reaches Vault and Infisical only where the server's environment says, never a policy's url or token variable", async () => {
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      calls.push(
        `${String(input)} ${JSON.stringify(Object.fromEntries(new Headers(init?.headers)))}`,
      );
      return Response.json({ data: { data: { k: "v" } } });
    };
    // A policy object carrying the old connection tables, as one stored before they were removed.
    const config = {
      ...policy('version = 1\n[secrets.env]\nV = "vault:selfhost/t/any#k"\n'),
      secrets: {
        env: { V: "vault:selfhost/t/any#k" },
        vault: { url: "https://attacker.example", token_env: "SELFHOST_TOKEN" },
      },
    } as unknown as ReturnType<typeof policy>;
    await expect(
      prepareCredentials({ id: "r", team: "t", target: "e2b" }, config, {
        env: { SELFHOST_TOKEN: ADMIN },
        fetch,
      }),
    ).rejects.toThrow("vault:selfhost/t/any#k: VAULT_ADDR is not set on the server");
    expect(calls).toEqual([]);

    const prepared = await prepareCredentials({ id: "r", team: "t", target: "e2b" }, config, {
      env: { SELFHOST_TOKEN: ADMIN, VAULT_ADDR: "https://vault.acme.test", VAULT_TOKEN: "vt" },
      fetch,
    });
    expect(prepared.env.V).toBe("v");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("https://vault.acme.test/v1/secret/data/selfhost/t/any");
    expect(calls[0]).not.toContain("attacker.example");
    expect(calls[0]).not.toContain(ADMIN);
  });
});

describe("egress.blocked", () => {
  it("records a refused connection a runtime reported, for the run", () => {
    const event = egressBlockedEvent(
      { host: "paste.example.com", port: 443, by: "runtime" },
      {
        location: "runtime:daytona",
        ts: NOW.toISOString(),
        run: { id: "run-7", team: "platform" },
      },
    );
    expect(validateEvent(event).ok).toBe(true);
    expect(event).toMatchObject({
      kind: "egress.blocked",
      source: "server",
      run_id: "run-7",
      target: { type: "url", value: "paste.example.com:443" },
      decision: { verdict: "block", rule_id: "egress.allow", mode: "enforce" },
      data: { v: 1, host: "paste.example.com", by: "runtime", location: "runtime:daytona" },
    });
  });
});

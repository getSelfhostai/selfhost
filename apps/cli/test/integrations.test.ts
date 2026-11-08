import { mkdirSync, readFileSync } from "node:fs";
import { openLedger } from "@selfhost/ledger";
import type { CreateTeamResponse, JoinResponse } from "@selfhost/schema";
import { createApp } from "@selfhost/server/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSettings } from "../src/integrations.js";
import { saveMembership } from "../src/team/config.js";
import { blockNetwork } from "./network.js";
import { run, tempDir } from "./run.js";

const E2B_KEY = "test-e2b-key";
const SERVER = "http://team.test";
const ADMIN = "admin-token";

/** E2B's sandbox list as its docs record it; any other call fails as unreachable. */
const e2bFetch = async (url: string, init?: RequestInit) => {
  if (url !== "https://api.e2b.app/v2/sandboxes?limit=1") {
    throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  }
  const ok = new Headers(init?.headers).get("x-api-key") === E2B_KEY;
  return new Response(ok ? "[]" : '{"code":401}', { status: ok ? 200 : 401 });
};

const POLICY = `version = 1

# Agents may not push to main.
[[rules]]
id = "no-push-main"
match = { tool = "Bash", command = "git push .* main" }
action = "block"
message = "Open a pull request."

[integrations.router]
tool = "bifrost"
`;

function soloRepo(text = POLICY) {
  const repo = tempDir("integrations-repo");
  mkdirSync(repo.path(".git"));
  repo.write("selfhost.toml", text);
  return repo;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("selfhost integrations, solo mode", () => {
  it("lists the choices from selfhost.toml without any network call", async () => {
    const repo = soloRepo();
    const attempts = blockNetwork();
    const listed = await run(["integrations", "--json"], { cwd: repo.root });
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.out)).toEqual({
      schema: "selfhost.integrations/v1",
      team: null,
      source: repo.path("selfhost.toml"),
      integrations: {
        router: { tool: "bifrost", status: null, detail: null, settings: {}, checked_at: null },
        tracer: { tool: null, status: null, detail: null, settings: {}, checked_at: null },
        runtime: { tool: null, status: null, detail: null, settings: {}, checked_at: null },
        reviewer: { tool: null, status: null, detail: null, settings: {}, checked_at: null },
      },
    });
    const text = await run(["integrations", "list"], { cwd: repo.root });
    expect(text.out).toContain("router    bifrost  not checked");
    expect(text.out).toContain("selfhost integrations check calls each tool to test it.");
    expect(attempts).toEqual([]);
  });

  it("sets and removes a job's tool, keeping the rest of the file", async () => {
    const repo = soloRepo();
    const set = await run(
      [
        "integrations",
        "set",
        "tracer",
        "langfuse",
        "--setting",
        "endpoint=https://cloud.langfuse.com/api/public/otel",
        "--setting",
        "headers_env.Authorization=LANGFUSE_OTLP_AUTH",
      ],
      { cwd: repo.root },
    );
    expect(set.err).toBe("");
    expect(set.out).toContain(
      `Set [integrations.tracer] in ${repo.path("selfhost.toml")}: langfuse.`,
    );
    expect(readFileSync(repo.path("selfhost.toml"), "utf8")).toBe(
      `${POLICY}\n[integrations.tracer]\ntool = "langfuse"\nendpoint = "https://cloud.langfuse.com/api/public/otel"\nheaders_env = { Authorization = "LANGFUSE_OTLP_AUTH" }\n`,
    );
    const removed = await run(["integrations", "set", "tracer", "none"], { cwd: repo.root });
    expect(removed.out).toContain("Removed [integrations.tracer]");
    expect(readFileSync(repo.path("selfhost.toml"), "utf8")).toBe(POLICY);
  });

  it("refuses an unknown tool or setting and writes nothing", async () => {
    const repo = soloRepo();
    const tool = await run(["integrations", "set", "router", "nginx"], { cwd: repo.root });
    expect(tool.code).toBe(1);
    expect(tool.err).toBe('Expected a router of bifrost, litellm or none, got "nginx"');
    const setting = await run(
      ["integrations", "set", "router", "litellm", "--setting", "api_key=sk-123", "--json"],
      { cwd: repo.root },
    );
    expect(setting.code).toBe(1);
    expect(JSON.parse(setting.out).error).toContain("would make");
    expect(readFileSync(repo.path("selfhost.toml"), "utf8")).toBe(POLICY);
    const none = await run(["integrations", "set", "router", "litellm"], {
      cwd: tempDir("no-config").root,
    });
    expect(none.err).toContain("No selfhost.toml found");
  });

  it("checks each tool, says what to fix and exits 1 on a failure", async () => {
    const repo = soloRepo(`version = 1
[integrations.runtime]
tool = "e2b"

[integrations.reviewer]
tool = "pr-agent"
`);
    repo.write(
      ".github/workflows/review.yml",
      "on: pull_request\njobs:\n  review:\n    steps:\n      - uses: the-pr-agent/pr-agent@main\n",
    );
    const ok = await run(["integrations", "check", "--json"], {
      cwd: repo.root,
      env: { E2B_API_KEY: E2B_KEY },
      fetch: e2bFetch,
    });
    expect(ok.code).toBe(0);
    const report = JSON.parse(ok.out);
    expect(report.integrations.runtime).toMatchObject({ tool: "e2b", status: "connected" });
    expect(report.integrations.reviewer.detail).toMatch(
      /^PR-Agent runs from \.github\/workflows\/review\.yml in /,
    );
    expect(report.integrations.router.status).toBe("not_configured");

    const failed = await run(["integrations", "check"], {
      cwd: repo.root,
      env: {},
      fetch: e2bFetch,
    });
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("runtime   e2b       error");
    expect(failed.out).toContain(
      "runtime: Set the environment variable E2B_API_KEY (api_key_env) where selfhost runs, to an E2B API key. It is not set.",
    );
  });

  it("parses dotted --setting keys into tables", () => {
    expect(parseSettings(["url=http://a:1/x=y", "headers_env.dd-api-key=DD_API_KEY"])).toEqual({
      url: "http://a:1/x=y",
      headers_env: { "dd-api-key": "DD_API_KEY" },
    });
    expect(() => parseSettings(["url"])).toThrow(/expected key=value/);
  });
});

describe("selfhost integrations, team mode", () => {
  async function teamServer() {
    const ledger = await openLedger({ dataDir: "memory://" });
    const app = createApp({
      version: "test",
      ledger,
      token: ADMIN,
      integrations: { env: { E2B_API_KEY: E2B_KEY }, fetch: e2bFetch },
    });
    const call = (path: string, init: RequestInit = {}, token = ADMIN) =>
      app.request(`${SERVER}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      });
    const team = (await (
      await call("/v1/teams", { method: "POST", body: JSON.stringify({ name: "Web" }) })
    ).json()) as CreateTeamResponse;
    const join = async (person: string) =>
      (await (
        await app.request(`${SERVER}/v1/join`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ invite: team.invite, person }),
        })
      ).json()) as JoinResponse;
    return { ledger, app, join };
  }

  it("reads and sets through the server, and a member may only read", async () => {
    const server = await teamServer();
    const owner = await server.join("ada@example.com");
    const member = await server.join("mia@example.com");
    const fetch = (url: string, init: RequestInit) =>
      Promise.resolve(server.app.request(url, init));
    const as = (token: string, person: string) => {
      const config = tempDir("integrations-config").path("config.json");
      saveMembership(config, { server: SERVER, token, person, team: "web" });
      return { configPath: config, fetch, cwd: tempDir("integrations-cwd").root };
    };

    const set = await run(
      ["integrations", "set", "runtime", "e2b", "--setting", "template=base"],
      as(owner.token, "ada@example.com"),
    );
    expect(set.err).toBe("");
    expect(set.out).toBe(
      "Set [integrations.runtime] in team web: e2b.\nCheck: E2B at https://api.e2b.app accepts the key in E2B_API_KEY.",
    );

    const listed = await run(["integrations", "--json"], as(member.token, "mia@example.com"));
    const report = JSON.parse(listed.out);
    expect(report).toMatchObject({ team: "web", source: SERVER });
    expect(report.integrations.runtime).toEqual({
      tool: "e2b",
      status: "connected",
      detail: "E2B at https://api.e2b.app accepts the key in E2B_API_KEY.",
      settings: { template: "base" },
      checked_at: expect.any(String),
    });

    const refused = await run(
      ["integrations", "set", "runtime", "modal"],
      as(member.token, "mia@example.com"),
    );
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(
      /^Permission denied: Changing the team's rules needs the owner or admin role/,
    );

    const invalid = await run(
      ["integrations", "set", "runtime", "e2b", "--setting", "api_key_env=not a name"],
      as(owner.token, "ada@example.com"),
    );
    expect(invalid.err).toMatch(
      /^The team server refused \[integrations\.runtime\]:\n {2}integrations\.runtime\.api_key_env/,
    );
    await server.ledger.close();
  });
});

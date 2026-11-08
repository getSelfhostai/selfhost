import {
  type ApiError,
  createValidator,
  type JoinResponse,
  type PolicyCoverageResponse,
  PolicyCoverageResponseSchema,
} from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./helpers.js";

let server: TestServer;
let owner: string;

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

const TOML = `version = 1

[[rules]]
id = "no-force-push"
mode = "observe"
match = { command = '^git push --force(\\s|$)' }
action = "block"
message = "Force pushes are blocked."

[[rules]]
id = "no-curl-pipe"
mode = "enforce"
match = { command = 'curl .*\\| *sh' }
action = "block"
message = "Do not pipe downloads into a shell."

[teams.coverage-team.rules.no-force-push]
mode = "enforce"
`;

beforeAll(async () => {
  server = await startTestServer();
  const created = await server.request("/v1/teams", json("POST", { name: "Coverage Team" }));
  const { invite } = (await created.json()) as { invite: string };
  const joined = await server.app.request(
    "/v1/join",
    json("POST", { invite, person: "ada@example.com" }),
  );
  owner = ((await joined.json()) as JoinResponse).token;
});

afterAll(async () => {
  await server.ledger.close();
});

describe("GET /v1/policy/coverage", () => {
  it("is 404 until the team has a policy", async () => {
    const res = await server.app.request("/v1/policy/coverage", as(owner));
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiError).error.code).toBe("no_policy");
  });

  it("returns the coverage of every rule per vendor with the team's overrides", async () => {
    const put = await server.app.request("/v1/policy", {
      ...json("PUT", { text: TOML }),
      headers: { "content-type": "application/json", authorization: `Bearer ${owner}` },
    });
    expect(put.status).toBe(200);
    const res = await server.app.request("/v1/policy/coverage", as(owner));
    expect(res.status).toBe(200);
    const body = (await res.json()) as PolicyCoverageResponse;
    const valid = createValidator(PolicyCoverageResponseSchema).validate(body);
    expect(valid.ok ? [] : valid.errors).toEqual([]);
    expect(body.team).toBe("coverage-team");
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
    const push = body.coverage.rules.find(
      (rule) => rule.rule_id === "no-force-push" && rule.vendor === "claude_code",
    );
    expect(push).toMatchObject({
      mode: "enforce",
      status: "compiled",
      native: ["deny: Bash(git push --force *)"],
    });
    const gap = body.coverage.rules.find(
      (rule) => rule.rule_id === "no-curl-pipe" && rule.vendor === "copilot",
    );
    expect(gap).toMatchObject({ status: "not_expressible", hook: "none" });
  });

  it("filters by vendor and checks the query", async () => {
    const res = await server.app.request("/v1/policy/coverage?vendor=codex", as(owner));
    const body = (await res.json()) as PolicyCoverageResponse;
    expect(new Set(body.coverage.rules.map((rule) => rule.vendor))).toEqual(new Set(["codex"]));
    expect((await server.app.request("/v1/policy/coverage?vendor=goose", as(owner))).status).toBe(
      400,
    );
    expect((await server.app.request("/v1/policy/coverage?team=other", as(owner))).status).toBe(
      403,
    );
  });

  it("needs a team with the admin token", async () => {
    expect((await server.request("/v1/policy/coverage")).status).toBe(400);
    const res = await server.request("/v1/policy/coverage?team=coverage-team");
    expect(res.status).toBe(200);
    expect(((await res.json()) as PolicyCoverageResponse).team).toBe("coverage-team");
  });
});

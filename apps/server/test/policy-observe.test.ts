import { type Ledger, openLedger } from "@selfhost/ledger";
import {
  createValidator,
  type JoinResponse,
  type LedgerEvent,
  type PolicyObservedResponse,
  PolicyObservedResponseSchema,
} from "@selfhost/schema";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { policyObservedReport } from "../src/policy-observe.js";
import { caller, TOKEN } from "./helpers.js";

const NOW = new Date("2026-11-08T12:00:00.000Z");

const TOML = `version = 1

[[rules]]
id = "no-force-push"
mode = "observe"
match = { command = 'git push --force' }
action = "block"
message = "Force pushes are blocked."

[[rules]]
id = "ask-migrations"
mode = "enforce"
match = { path = "db/migrations/**" }
action = "ask"
message = "Migrations need a person."

[guardrails]
mode = "observe"
`;

let ledger: Ledger;
let app: Hono;
let admin: ReturnType<typeof caller>;
let owner: ReturnType<typeof caller>;
let member: ReturnType<typeof caller>;
let next = 1;

function verdict(
  rule: string,
  mode: "observe" | "enforce",
  verdict: "block" | "ask",
  overrides: Partial<LedgerEvent> & { toolEvent?: string } = {},
): LedgerEvent {
  const n = next++;
  const { toolEvent, ...rest } = overrides;
  return {
    id: `01930c4e-2f1a-7b2c-9d3e-${n.toString(16).padStart(12, "0")}`,
    schema: "selfhost.event/v1",
    ts: "2026-11-07T10:00:00.000Z",
    source: "hook",
    kind: "policy.evaluated",
    actor: { kind: "system", id: "selfhost-policy" },
    session_id: `s-${n}`,
    tool: { name: "Bash", input_summary: "git push --force origin main" },
    decision: { verdict, by: "selfhost-policy", rule_id: rule, mode },
    data: { tool_event_id: toolEvent ?? `tool-${n}` },
    ...rest,
  };
}

const read = async (as: ReturnType<typeof caller>, path: string) => {
  const res = await as(path);
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as PolicyObservedResponse;
  const valid = createValidator(PolicyObservedResponseSchema).validate(body);
  expect(valid.ok ? [] : valid.errors).toEqual([]);
  return body;
};

beforeAll(async () => {
  ledger = await openLedger({ dataDir: "memory://" });
  app = createApp({ version: "1.2.3", ledger, token: TOKEN, now: () => NOW });
  admin = caller(app, TOKEN);
  const join = async (invite: string, person: string) =>
    ((await (await admin("/v1/join", "POST", { invite, person })).json()) as JoinResponse).token;

  const web = (await (await admin("/v1/teams", "POST", { name: "Web" })).json()) as {
    invite: string;
  };
  owner = caller(app, await join(web.invite, "ada@example.com"));
  member = caller(app, await join(web.invite, "mia@example.com"));
  expect((await owner("/v1/policy", "PUT", { text: TOML })).status).toBe(200);

  const data = (await (await admin("/v1/teams", "POST", { name: "Data" })).json()) as {
    invite: string;
  };
  const dan = caller(app, await join(data.invite, "dan@example.com"));

  const same = "tool-repeated";
  const written = await owner("/v1/events", "POST", {
    events: [
      verdict("no-force-push", "observe", "block", { toolEvent: same, session_id: "s-a" }),
      // The same call evaluated again counts once.
      verdict("no-force-push", "observe", "block", { toolEvent: same, session_id: "s-a" }),
      verdict("no-force-push", "observe", "block", {
        session_id: "s-b",
        tool: { name: "Bash", input_summary: 'echo "git push --force"' },
      }),
      verdict("ask-migrations", "enforce", "ask", {
        tool: { name: "Edit" },
        target: { type: "file", value: "db/migrations/001.sql" },
      }),
      verdict("guard.force_push", "observe", "block"),
      // Older than the default window.
      verdict("no-force-push", "observe", "block", { ts: "2026-10-20T10:00:00.000Z" }),
    ],
  });
  expect(written.status, await written.clone().text()).toBe(200);
  const other = await dan("/v1/events", "POST", {
    events: [verdict("no-force-push", "enforce", "block")],
  });
  expect(other.status).toBe(200);
});

afterAll(async () => {
  await ledger.close();
});

describe("GET /v1/policy/observed", () => {
  it("counts what each rule and guardrail would have done and did, in the last 7 days", async () => {
    const body = await read(owner, "/v1/policy/observed");
    expect(body).toMatchObject({
      schema: "selfhost.policy_observed/v1",
      team: "web",
      from: "2026-11-01T12:00:00.000Z",
      to: "2026-11-08T12:00:00.000Z",
      totals: { would_block: 3, would_ask: 0, blocked: 0, asked: 1 },
    });
    expect(body.rules.map((rule) => rule.rule_id)).toEqual([
      "no-force-push",
      "ask-migrations",
      "guard.force_push",
    ]);
    expect(body.rules[0]).toMatchObject({
      mode: "observe",
      would_block: 2,
      blocked: 0,
      sessions: 2,
      likely_false_positives: 1,
    });
    expect(body.rules[0]?.examples).toHaveLength(2);
    expect(body.rules[1]).toMatchObject({ mode: "enforce", asked: 1, would_block: 0 });
    expect(body.rules[2]).toMatchObject({ mode: "observe", would_block: 1 });
  });

  it("keeps other teams' verdicts out and takes a window", async () => {
    const wide = await read(
      admin,
      "/v1/policy/observed?team=web&from=2026-10-01T00:00:00.000Z&to=2026-11-08T00:00:00.000Z",
    );
    expect(wide.totals).toEqual({ would_block: 4, would_ask: 0, blocked: 0, asked: 1 });
    const data = await read(admin, "/v1/policy/observed?team=data");
    expect(data.totals.blocked).toBe(1);
    expect(data.rules[0]).toMatchObject({ rule_id: "no-force-push", mode: null });
  });

  it("is read by every member, and refuses bad queries and other teams", async () => {
    expect((await read(member, "/v1/policy/observed?team=web")).team).toBe("web");
    expect((await member("/v1/policy/observed?team=data")).status).toBe(403);
    expect((await admin("/v1/policy/observed")).status).toBe(400);
    expect((await admin("/v1/policy/observed?team=nope")).status).toBe(404);
    expect((await admin("/v1/policy/observed?team=web&from=yesterday")).status).toBe(400);
    expect((await admin("/v1/policy/observed?team=web&color=red")).status).toBe(400);
    const backwards = await admin(
      "/v1/policy/observed?team=web&from=2026-11-08T00:00:00.000Z&to=2026-11-01T00:00:00.000Z",
    );
    expect(backwards.status).toBe(400);
  });
});

describe("policyObservedReport", () => {
  it("counts an observe rule that fired next to an enforced guardrail", () => {
    // The hook blocked under guard.force_push; no-force-push only recorded, in data.hits.
    const blocked = verdict("guard.force_push", "enforce", "block", {
      data: {
        tool_event_id: "tool-both",
        hits: [
          { rule_id: "no-force-push", mode: "observe", verdict: "block" },
          { rule_id: "guard.force_push", mode: "enforce", verdict: "block" },
        ],
      },
    });
    const report = policyObservedReport([blocked], {
      team: "web",
      from: new Date("2026-11-01T00:00:00.000Z"),
      to: NOW,
      modes: new Map([["no-force-push", "observe"]]),
    });
    expect(report.totals).toEqual({ would_block: 1, would_ask: 0, blocked: 1, asked: 0 });
    expect(report.rules.map((rule) => [rule.rule_id, rule.would_block, rule.blocked])).toEqual([
      ["guard.force_push", 0, 1],
      ["no-force-push", 1, 0],
    ]);
  });
});

import {
  EVENT_SCHEMA,
  type LedgerEvent,
  namedAgentActor,
  parseConfig,
  type ResolvedSelfhostConfig,
} from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { newItem } from "../src/build.js";
import { draftFor, routeByNamedAgent } from "../src/index.js";

const config = (() => {
  const parsed = parseConfig(`version = 1
[review]
fallback = ["lead@example.com"]
[review.owners]
"deps/**" = ["team-lead@example.com"]
[[review.routes]]
id = "all-blocks"
kinds = ["blocked_action"]
to = ["security@example.com"]

[agents.janitor]
owner = "bo@example.com"
paths = ["deps/**"]
`);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.config;
})();

let n = 0;
const event = (fields: Partial<LedgerEvent> & Pick<LedgerEvent, "kind">): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: EVENT_SCHEMA,
  ts: "2026-11-12T10:00:00.000Z",
  source: "hook",
  actor: { kind: "person", id: "ada@example.com" },
  agent: { vendor: "claude_code" },
  session_id: "s1",
  ...fields,
});

const block = (fields: Partial<LedgerEvent>) =>
  event({
    kind: "policy.evaluated",
    tool: { name: "Bash", input_summary: "rm -rf build" },
    target: { type: "command", value: "rm -rf build" },
    decision: { verdict: "block", rule_id: "no-rm", mode: "enforce" },
    ...fields,
  });

function build(signal: LedgerEvent, cfg: ResolvedSelfhostConfig = config) {
  const draft = draftFor(signal);
  if (!draft) throw new Error("no draft");
  return newItem(draft, signal, { config: cfg, now: new Date("2026-11-12T10:01:00Z"), team: null });
}

describe("named agents in routing", () => {
  it("sends a named agent's items to its owner before the team's routes", () => {
    const item = build(block({ actor: namedAgentActor("janitor") }));
    expect(item.owners).toEqual(["bo@example.com"]);
    expect(item.route).toEqual({ step: "owner", from: "[agents.janitor] owner" });
  });

  it("sends an item on a path a named agent owns to its owner, whoever raised it", () => {
    const item = build(
      block({
        tool: { name: "Edit" },
        target: { type: "file", value: "deps/lock.json" },
      }),
    );
    expect(item.owners).toEqual(["bo@example.com"]);
    expect(item.route).toEqual({ step: "owner", from: '[agents.janitor] paths "deps/**"' });
    expect(routeByNamedAgent(config, { paths: ["src/a.ts"] })).toBeUndefined();
  });

  it("leaves other items to the team's routing", () => {
    expect(build(block({})).owners).toEqual(["security@example.com"]);
  });

  it("sends a named agent's budget alert to its owner", () => {
    const item = build(
      event({
        kind: "alert.raised",
        source: "server",
        actor: { kind: "system", id: "selfhost" },
        session_id: undefined,
        data: {
          alert: "budget",
          owner: "bo@example.com",
          named_agent: "janitor",
          cap: "agents.janitor",
          window: "day",
          message: "Agent janitor spent $6.00 of its $5.00 daily budget",
        },
      }),
    );
    expect(item).toMatchObject({
      kind: "budget",
      owners: ["bo@example.com"],
      title: "Agent janitor spent $6.00 of its $5.00 daily budget",
    });
  });
});

describe("overlap items", () => {
  it("go to the one owner each names, whatever the routes and path owners say", () => {
    const overlap = (owner: string) =>
      build(
        event({
          kind: "alert.raised",
          source: "server",
          actor: { kind: "system", id: "selfhost" },
          session_id: undefined,
          repo: "acme/web",
          data: {
            alert: "edit_overlap",
            owner,
            file: "deps/lock.json",
            runs: ["s-1", "s-2"],
            message: "2 active runs are editing deps/lock.json in acme/web",
          },
        }),
      );
    const ada = overlap("ada@example.com");
    expect(ada).toMatchObject({
      kind: "overlap",
      owners: ["ada@example.com"],
      route: { step: "owner", from: "the owner of the run" },
      title: "2 active runs are editing deps/lock.json in acme/web",
    });
    const bo = overlap("bo@example.com");
    expect(bo.owners).toEqual(["bo@example.com"]);
    expect(bo.id).not.toBe(ada.id);
  });
});

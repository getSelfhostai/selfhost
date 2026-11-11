import { REVIEW_ITEM_SCHEMA, type ReviewItem } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { decisionRefusal, waitingRefusal } from "../src/authorize.js";
import { handedOverItem, handoffRefusal, takeoverRefusal } from "../src/handoff.js";
import { defaultConfig } from "../src/list.js";

const RUN = { team: "web", owner: "ana@example.com" };
const BEN = { id: "ben@example.com", role: "member" as const };
const NOW = new Date("2026-11-11T12:00:00Z");

describe("who may hand a run over", () => {
  it.each([
    ["the owner, a member", { by: "Ana@example.com", role: "member" as const }, undefined],
    ["a team admin", { by: "adam@example.com", role: "admin" as const }, undefined],
    ["a team owner", { by: "olga@example.com", role: "owner" as const }, undefined],
    ["the admin token", { by: "admin", trusted: true }, undefined],
    ["another member", { by: "mia@example.com", role: "member" as const }, "caller"],
    ["someone outside the team", { by: "dora@example.com" }, "caller"],
  ])("%s", (_name, decider, refusedBy) => {
    expect(handoffRefusal(RUN, BEN, decider)?.by).toBe(refusedBy);
  });

  it("refuses a new owner outside the team, and the owner themselves", () => {
    const owner = { by: "ana@example.com", role: "member" as const };
    expect(handoffRefusal(RUN, { id: "dora@example.com" }, owner)).toMatchObject({
      by: "target",
      message: expect.stringMatching(/dora@example.com is not in team web/),
    });
    expect(handoffRefusal(RUN, { id: "ANA@example.com", role: "member" }, owner)?.message).toBe(
      "ANA@example.com already holds this run.",
    );
  });
});

describe("answers from someone no longer in the item's team", () => {
  const approval = { kind: "approval" as const, owners: ["eve@example.com"] };

  it("refuses them even for an item routed to them, and lets members and the admin token answer", () => {
    const config = defaultConfig();
    expect(waitingRefusal(approval, "web", { by: "eve@example.com" })).toBe(
      "You are not in team web.",
    );
    expect(decisionRefusal(approval, "web", "approve", { by: "eve@example.com" }, config)).toBe(
      "You are not in team web.",
    );
    // Denying an exception needs the team too.
    const exception = { kind: "exception" as const, requested_by: "ana@example.com" };
    expect(decisionRefusal(exception, "web", "deny", { by: "eve@example.com" }, config)).toBe(
      "You are not in team web.",
    );
    expect(
      decisionRefusal(
        approval,
        "web",
        "approve",
        { by: "eve@example.com", role: "member" },
        config,
      ),
    ).toBeUndefined();
    expect(
      decisionRefusal(approval, "web", "approve", { by: "admin", trusted: true }, config),
    ).toBeUndefined();
  });
});

describe("who may take a run over", () => {
  const handoff = { to: "ben@example.com", team: "web" };

  it("is the new owner alone, in the team, never the admin token", () => {
    expect(takeoverRefusal(handoff, { by: "Ben@example.com", role: "member" })).toBeUndefined();
    expect(takeoverRefusal(handoff, { by: "mia@example.com", role: "owner" })).toMatch(
      /only they can take it over/,
    );
    expect(takeoverRefusal(handoff, { by: "ben@example.com" })).toMatch(/no longer in team web/);
    expect(takeoverRefusal(handoff, { by: "admin", trusted: true })).toMatch(/own login/);
  });
});

describe("a run's open items after a handoff", () => {
  const item = (fields: Partial<ReviewItem>): ReviewItem => ({
    id: "01930c4e-2f1a-7b2c-9d3e-000000000001",
    schema: REVIEW_ITEM_SCHEMA,
    kind: "approval",
    title: "Claude Code asks to use Bash",
    created_at: "2026-11-11T10:00:00.000Z",
    updated_at: "2026-11-11T10:00:00.000Z",
    state: "open",
    blocking: true,
    risk: { score: 50, reasons: [] },
    owners: ["ana@example.com"],
    source_event_ids: [],
    why: { signal: "approval.requested", text: "Waiting." },
    actions: ["approve", "deny"],
    route: { step: "owner", from: "the session's person" },
    ...fields,
  });
  const handoff = { owner: "ben@example.com", previous_owner: "ana@example.com" };

  it("moves items routed to the run's person to the new owner", () => {
    expect(handedOverItem(item({}), handoff, NOW)).toMatchObject({
      owners: ["ben@example.com"],
      route: { step: "owner", from: "the run's owner", why: "handed over from ana@example.com" },
      updated_at: NOW.toISOString(),
    });
  });

  it("adds the new owner to items a route picked, and leaves exceptions with the approvers", () => {
    const routed = item({
      owners: ["dba@example.com"],
      route: { step: "route", from: "db", id: "db" },
    });
    expect(handedOverItem(routed, handoff, NOW)?.owners).toEqual([
      "dba@example.com",
      "ben@example.com",
    ]);
    expect(handedOverItem(item({ kind: "exception" }), handoff, NOW)).toBeUndefined();
    expect(handedOverItem(item({ state: "answered" }), handoff, NOW)).toBeUndefined();
  });
});

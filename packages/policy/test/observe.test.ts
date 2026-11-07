import { join } from "node:path";
import { importAll } from "@selfhost/importers";
import { type Ledger, openLedger } from "@selfhost/ledger";
import { type LedgerEvent, validateEvent } from "@selfhost/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { observeLedger, type PolicySource } from "../src/index.js";
import { config, FIXTURES, sessionStarted, toolEvent } from "./helpers.js";

const REPO = "/home/dev/acme-api";
const NOW = new Date("2026-11-08T10:00:00.000Z");
const SOURCE: PolicySource = {
  path: `${REPO}/selfhost.toml`,
  hash: "9b2d4c6e8f0a1b3c5d7e9f1a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c",
  commit: "4f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39",
  dirty: false,
};

// Rules written against the 29 tool calls in fixtures/claude-code and fixtures/codex, all run in
// /home/dev/acme-api: 6 git commits, 3 calls on files under src/routes, and 6 calls on models
// outside the allow list (claude-fable-5-1 twice, gpt-5.4 four times).
const POLICY = config(`version = 1

[[rules]]
id = "no-agent-commits"
match = { command = "git\\\\s+commit" }
action = "ask"
message = "Agents open a PR instead of committing."

[[rules]]
id = "protect-routes"
match = { path = "src/routes/**" }
action = "block"
message = "Routes need a review."
irreversible = true

[[rules]]
id = "no-npm-version"
mode = "off"
match = { command = "npm\\\\s+version" }
action = "block"
message = "Releases go through CI."

[[rules]]
id = "no-force-push"
mode = "enforce"
match = { command = "git\\\\s+push\\\\s+.*--force" }
action = "block"
message = "Force pushes are blocked."

[mcp]
allow = ["github"]

[models]
allow = ["claude-opus-*", "gpt-5.5"]

[teams.growth.rules.no-agent-commits]
mode = "off"
`);

let ledger: Ledger;

async function policyEvents(): Promise<LedgerEvent[]> {
  const { events } = await ledger.query({ kind: "policy.evaluated", limit: 1000 });
  return events;
}

const countBy = (events: LedgerEvent[]) => {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const id = event.decision?.rule_id ?? "";
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
};

beforeEach(async () => {
  ledger = await openLedger({ dataDir: "memory://" });
  await importAll(ledger, {
    claudeDir: join(FIXTURES, "claude-code"),
    codexDir: join(FIXTURES, "codex"),
    since: new Date("2026-10-01"),
    actorId: "dev@example.com",
    logPrompts: false,
  });
  // A session in the repository with calls the fixture logs do not have, and one elsewhere.
  await ledger.append([
    sessionStarted("hand-1", "2026-10-10T09:00:00.000Z", REPO),
    toolEvent({
      session: "hand-1",
      ts: "2026-10-10T09:01:00.000Z",
      tool: "mcp__slack__post_message",
      model: "claude-opus-5-5",
    }),
    toolEvent({
      session: "hand-1",
      ts: "2026-10-10T09:02:00.000Z",
      tool: "Bash",
      model: "claude-opus-5-5",
      target: { type: "command", value: "git push --force origin main" },
    }),
    sessionStarted("hand-2", "2026-10-10T10:00:00.000Z", "/home/dev/other"),
    toolEvent({
      session: "hand-2",
      ts: "2026-10-10T10:01:00.000Z",
      tool: "Bash",
      model: "o3",
      target: { type: "command", value: "git commit -m wip" },
    }),
  ]);
});

afterEach(async () => {
  await ledger.close();
});

describe("observeLedger", () => {
  it("writes one would-block event per hit, for tool calls in the repository only", async () => {
    const result = await observeLedger(ledger, POLICY, SOURCE, { repoRoot: REPO, now: NOW });
    expect(result).toMatchObject({ tool_calls: 32, evaluated: 31, recorded: 17, duplicates: 0 });
    const expected = {
      "no-agent-commits": 6,
      "protect-routes": 3,
      "no-force-push": 1,
      "mcp.allow": 1,
      "models.allow": 6,
    };
    expect(countBy(await policyEvents())).toEqual(expected);
    expect(result.rules).toEqual([
      { rule_id: "no-agent-commits", mode: "observe", action: "ask", recorded: 6, duplicates: 0 },
      { rule_id: "protect-routes", mode: "observe", action: "block", recorded: 3, duplicates: 0 },
      { rule_id: "no-npm-version", mode: "off", action: "block", recorded: 0, duplicates: 0 },
      { rule_id: "no-force-push", mode: "enforce", action: "block", recorded: 1, duplicates: 0 },
      { rule_id: "mcp.allow", mode: "observe", action: "block", recorded: 1, duplicates: 0 },
      { rule_id: "models.allow", mode: "observe", action: "block", recorded: 6, duplicates: 0 },
    ]);
  });

  it("copies the tool call onto a valid policy.evaluated event", async () => {
    await observeLedger(ledger, POLICY, SOURCE, { repoRoot: REPO, now: NOW });
    const { events } = await ledger.query({ kind: "tool.called", session: "hand-1" });
    const push = events.find((event) => event.tool?.name === "Bash") as LedgerEvent;
    const [recorded] = (await policyEvents()).filter(
      (event) => event.data?.tool_event_id === push.id,
    );
    expect(validateEvent(recorded).ok).toBe(true);
    expect(recorded).toEqual({
      id: recorded?.id,
      schema: "selfhost.event/v1",
      ts: push.ts,
      source: "cli",
      kind: "policy.evaluated",
      actor: { kind: "system", id: "selfhost-policy" },
      agent: push.agent,
      model: "claude-opus-5-5",
      session_id: "hand-1",
      tool: push.tool,
      target: push.target,
      decision: {
        verdict: "block",
        by: "selfhost-policy",
        reason: "Force pushes are blocked.",
        rule_id: "no-force-push",
        mode: "enforce",
        policy_commit: SOURCE.commit,
        policy_hash: SOURCE.hash,
      },
      data: { tool_event_id: push.id, evaluated_at: NOW.toISOString() },
    });
  });

  it("marks irreversible hits and records the team", async () => {
    await observeLedger(ledger, POLICY, SOURCE, { repoRoot: REPO, now: NOW, team: "growth" });
    const events = await policyEvents();
    expect(events.every((event) => event.team === "growth")).toBe(true);
    const routes = events.filter((event) => event.decision?.rule_id === "protect-routes");
    expect(routes.map((event) => event.data?.irreversible)).toEqual([true, true, true]);
  });

  it("writes nothing new on a second run with the same policy file", async () => {
    const first = await observeLedger(ledger, POLICY, SOURCE, { repoRoot: REPO, now: NOW });
    const later = new Date("2026-11-09T10:00:00.000Z");
    const second = await observeLedger(ledger, POLICY, SOURCE, { repoRoot: REPO, now: later });
    expect(second).toMatchObject({ recorded: 0, duplicates: first.recorded });
    expect(second.rules.find((rule) => rule.rule_id === "models.allow")).toMatchObject({
      recorded: 0,
      duplicates: 6,
    });
    expect(await policyEvents()).toHaveLength(first.recorded);
  });

  it("records again when the policy file changes", async () => {
    await observeLedger(ledger, POLICY, SOURCE, { repoRoot: REPO, now: NOW });
    const edited = { ...SOURCE, hash: "0".repeat(64), commit: undefined, dirty: true };
    const second = await observeLedger(ledger, POLICY, edited, { repoRoot: REPO, now: NOW });
    expect(second.recorded).toBe(17);
    const latest = (await policyEvents()).filter(
      (event) => event.decision?.policy_hash === edited.hash,
    );
    expect(latest.every((event) => event.decision?.policy_commit === undefined)).toBe(true);
  });

  it("writes nothing for rules in mode off, from the file or the team", async () => {
    const result = await observeLedger(ledger, POLICY, SOURCE, {
      repoRoot: REPO,
      now: NOW,
      team: "growth",
    });
    const counts = countBy(await policyEvents());
    expect(counts["no-npm-version"]).toBeUndefined();
    expect(counts["no-agent-commits"]).toBeUndefined();
    expect(result.rules.find((rule) => rule.rule_id === "no-agent-commits")?.mode).toBe("off");
  });

  it("reads tool calls from since on, and none from another repository", async () => {
    const since = new Date("2026-10-09T00:00:00.000Z");
    const recent = await observeLedger(ledger, POLICY, SOURCE, { repoRoot: REPO, since, now: NOW });
    expect(recent.tool_calls).toBeLessThan(32);
    expect(recent.tool_calls).toBeGreaterThan(0);
    const elsewhere = await observeLedger(ledger, POLICY, SOURCE, {
      repoRoot: "/home/dev/other-repo",
      now: NOW,
    });
    expect(elsewhere).toMatchObject({ evaluated: 0, recorded: 0 });
  });
});

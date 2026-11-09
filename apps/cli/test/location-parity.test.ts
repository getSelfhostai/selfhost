import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "@selfhost/ledger";
import type { LedgerEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { drainSpool } from "../src/hooks/drain.js";
import { type GuardRecord, runHook, type SpoolLine } from "../src/hooks/receive.js";
import { tempDir } from "./run.js";

/**
 * F95: the shared fixture cases (fixtures/guardrails) give the same verdict, rule and ledger
 * decision on a bare laptop, in each local sandbox and in a remote runtime. Only where the call
 * ran differs, and each policy.evaluated event records it. selfhost writes SELFHOST_LOCATION into
 * every sandbox spec and local sandbox config it produces; a laptop has none.
 */

interface Case {
  id: string;
  shell?: string;
  read?: string;
  write?: string;
  mcp?: { server: string; tool: string };
  verdict: "allow" | "block" | "ask";
  rule_id?: string;
}

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures", "guardrails");
const cases = (JSON.parse(readFileSync(join(fixtures, "cases.json"), "utf8")) as { cases: Case[] })
  .cases;
const POLICY = readFileSync(join(fixtures, "selfhost.toml"), "utf8");

const LOCATIONS = [
  { name: "laptop", env: {} },
  { name: "local:sandbox-runtime", env: { SELFHOST_LOCATION: "local:sandbox-runtime" } },
  { name: "local:docker-sandboxes", env: { SELFHOST_LOCATION: "local:docker-sandboxes" } },
  { name: "local:devcontainer", env: { REMOTE_CONTAINERS: "true" } },
  { name: "runtime:e2b", env: { SELFHOST_LOCATION: "runtime:e2b" } },
] as const;

/** One place an agent runs: its own workspace and home, as a sandbox would have. */
function place(env: Record<string, string>) {
  const workspace = tempDir("parity-ws");
  workspace.write(".git/HEAD", "ref: refs/heads/main\n");
  workspace.write("selfhost.toml", POLICY);
  const home = tempDir("parity-home");
  return { workspace, home, env: { ...env, HOME: home.root } };
}

function payload(c: Case, ws: string, home: string) {
  const fill = (text: string) => text.replaceAll("{workspace}", ws).replaceAll("{home}", home);
  const file = (value: string) => {
    const path = fill(value);
    if (path.startsWith("~/")) return join(home, path.slice(2));
    return path.startsWith("/") ? path : join(ws, path);
  };
  const [tool, input] =
    c.shell !== undefined
      ? ["Bash", { command: fill(c.shell) }]
      : c.read !== undefined
        ? ["Read", { file_path: file(c.read) }]
        : c.write !== undefined
          ? ["Write", { file_path: file(c.write), content: "select 1;" }]
          : [`mcp__${c.mcp?.server}__${c.mcp?.tool}`, {}];
  return {
    session_id: `sess-${c.id}`,
    cwd: ws,
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: input,
    tool_use_id: `toolu_${c.id}`,
  };
}

async function hook(body: unknown, env: Record<string, string>) {
  let stdout = "";
  await runHook(["claude"], {
    env,
    readStdin: async () => JSON.stringify(body),
    writeOutput: (text) => {
      stdout += text;
    },
    writeError: () => {},
    now: new Date("2026-11-09T10:00:00Z"),
  });
  return stdout === "" ? "allow" : JSON.parse(stdout).hookSpecificOutput.permissionDecision;
}

const lastGuard = (home: string): GuardRecord | undefined => {
  const dir = join(home, ".selfhost", "spool");
  const lines = readdirSync(dir).flatMap((name) =>
    readFileSync(join(dir, name), "utf8").trimEnd().split("\n"),
  );
  return (JSON.parse(lines.at(-1) as string) as SpoolLine).guard;
};

describe("the same rules on a laptop, in local sandboxes and in a runtime", () => {
  it.each(cases.map((c) => [c.id, c] as const))("%s", async (_, c) => {
    const seen: { answer: string; rule?: string; verdict?: string; location?: string }[] = [];
    for (const location of LOCATIONS) {
      const at = place(location.env);
      const answer = await hook(payload(c, at.workspace.root, at.home.root), at.env);
      const guard = lastGuard(at.home.root);
      seen.push({
        answer,
        ...(guard?.hit ? { rule: guard.hit.rule_id, verdict: guard.hit.verdict } : {}),
        ...(guard?.location ? { location: guard.location } : {}),
      });
    }
    const decisions = seen.map(({ location: _location, ...decision }) => decision);
    for (const decision of decisions) expect(decision).toEqual(decisions[0]);
    expect(decisions[0]?.rule).toBe(c.rule_id);
    expect(seen.map((s) => s.location)).toEqual(LOCATIONS.map((l) => l.name));
  });
});

describe("ledger events by location", () => {
  it("records the same decisions and egress blocks everywhere, each with where it ran", async () => {
    const picked = ["force-push", "egress-blocked-host", "egress-allowed-host", "write-migration"];
    const byLocation = new Map<string, LedgerEvent[]>();
    for (const location of LOCATIONS) {
      const at = place(location.env);
      for (const id of picked) {
        const c = cases.find((x) => x.id === id) as Case;
        await hook(payload(c, at.workspace.root, at.home.root), at.env);
      }
      const ledger = await openLedger({ dataDir: "memory://" });
      try {
        await drainSpool(ledger, join(at.home.root, ".selfhost", "spool"), {
          person: "dev@example.com",
          now: new Date("2026-11-09T10:05:00Z"),
        });
        const { events } = await ledger.query({ limit: 500 });
        byLocation.set(location.name, events);
      } finally {
        await ledger.close();
      }
    }
    const summary = (events: LedgerEvent[]) =>
      events
        .filter((e) => e.kind === "policy.evaluated" || e.kind === "egress.blocked")
        .map((e) => [
          e.kind,
          e.session_id,
          e.decision?.verdict,
          e.decision?.rule_id,
          e.target?.value,
        ])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const laptop = byLocation.get("laptop") ?? [];
    expect(summary(laptop)).toContainEqual([
      "egress.blocked",
      "sess-egress-blocked-host",
      "block",
      "egress.allow",
      "exfil.test",
    ]);
    for (const [name, events] of byLocation) {
      expect(summary(events), name).toEqual(summary(laptop));
      const located = events.filter(
        (e) => e.kind === "policy.evaluated" || e.kind === "egress.blocked",
      );
      expect(located.length, name).toBeGreaterThan(0);
      for (const event of located) expect(event.data?.location, name).toBe(name);
    }
  });
});

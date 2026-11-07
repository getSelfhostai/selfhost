import { mkdirSync } from "node:fs";
import { deterministicUuidv7 } from "@selfhost/importers";
import { type Ledger, openLedger } from "@selfhost/ledger";
import { type LedgerEvent, parseConfig, type Rule, validateReviewItem } from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseSince } from "../src/import.js";
import { runPolicyReport } from "../src/policy/editing.js";
import {
  buildPolicyReport,
  falsePositiveReason,
  matchesOnlyInertText,
  observedRules,
  reportWindow,
} from "../src/policy/report.js";
import { run, tempDir } from "./run.js";

const POLICY = `version = 1

[[rules]]
id = "no-force-push"
match = { command = "git\\\\s+push\\\\s+.*--force" }
action = "block"
message = "Force pushes are blocked."

[[rules]]
id = "protect-migrations"
match = { path = "db/migrations/**" }
action = "ask"
message = "Migrations need a human review."

[[rules]]
id = "env-reads"
match = { tool = "Read", path = "**/.env" }
action = "block"
message = "Agents do not read .env files."

[[rules]]
id = "no-rm-rf"
mode = "enforce"
match = { command = "rm\\\\s+-rf" }
action = "block"
message = "No recursive deletes."
`;

function policyRules(): Rule[] {
  const result = parseConfig(POLICY);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.config.rules;
}

const rules = policyRules();
const rule = (id: string) => rules.find((r) => r.id === id);

type Call = { tool: string; input: string; type?: "command" | "file" };

const bash = (input: string): Call => ({ tool: "Bash", input, type: "command" });
const file = (tool: string, input: string): Call => ({ tool, input, type: "file" });

/** A tool.called event and the policy.evaluated event observe writes for it. */
function observed(
  key: string,
  ts: string,
  session: string,
  call: Call,
  ruleId: string,
  extra: { verdict?: "block" | "ask" | "allow"; mode?: "observe" | "enforce"; at?: string } = {},
): [LedgerEvent, LedgerEvent] {
  const toolEvent: LedgerEvent = {
    id: deterministicUuidv7(`tool:${key}`, Date.parse(ts)),
    schema: "selfhost.event/v1",
    ts,
    source: "local_log",
    kind: "tool.called",
    actor: { kind: "person", id: "dev@example.com" },
    repo: "acme/api",
    agent: { vendor: "claude_code", version: "2.1.270" },
    model: "claude-opus-4",
    session_id: session,
    tool: call.input ? { name: call.tool, input_summary: call.input } : { name: call.tool },
    ...(call.type ? { target: { type: call.type, value: call.input } } : {}),
  };
  const at = extra.at ?? ts;
  const evaluated: LedgerEvent = {
    id: deterministicUuidv7(`policy:${key}:${ruleId}:${at}`, Date.parse(at)),
    schema: "selfhost.event/v1",
    ts,
    source: "cli",
    kind: "policy.evaluated",
    actor: { kind: "system", id: "selfhost-policy" },
    repo: "acme/api",
    agent: toolEvent.agent,
    model: toolEvent.model,
    session_id: session,
    tool: toolEvent.tool,
    ...(toolEvent.target ? { target: toolEvent.target } : {}),
    decision: {
      verdict: extra.verdict ?? "block",
      rule_id: ruleId,
      mode: extra.mode ?? "observe",
      by: "selfhost-policy",
      reason: "fixture",
    },
    data: { tool_event_id: toolEvent.id },
  };
  return [toolEvent, evaluated];
}

const day = (n: number, hour = 10) => `2026-11-0${n}T${String(hour).padStart(2, "0")}:00:00.000Z`;

const pairs = [
  observed("push-1", day(2), "s1", bash("git push --force origin main"), "no-force-push"),
  observed("push-2", day(3), "s1", bash("git push --force origin main"), "no-force-push"),
  observed(
    "commit",
    day(3, 11),
    "s2",
    bash('git commit -m "never git push --force"'),
    "no-force-push",
  ),
  observed("echo", day(4), "s2", bash("echo git push --force"), "no-force-push"),
  observed("grep", day(4, 11), "s3", bash("grep -rn 'git push  --force' docs"), "no-force-push"),
  observed("bash-c", day(5), "s3", bash('bash -c "git push --force"'), "no-force-push"),
  observed(
    "read-mig",
    day(5, 11),
    "s1",
    file("Read", "db/migrations/0042.sql"),
    "protect-migrations",
    {
      verdict: "ask",
    },
  ),
  observed("edit-mig", day(6), "s2", file("Edit", "db/migrations/0042.sql"), "protect-migrations", {
    verdict: "ask",
  }),
  observed("read-env", day(6, 11), "s4", file("Read", ".env"), "env-reads"),
  observed("mcp", day(7), "s4", { tool: "mcp__github__create_issue", input: "" }, "mcp.allow"),
];

// Left out: enforce mode, an allow verdict, outside the window, and a second evaluation of a
// tool call already counted.
const [pushTool] = pairs[0] as [LedgerEvent, LedgerEvent];
const ignored = [
  observed("rm", day(5), "s1", bash("rm -rf build"), "no-rm-rf", { mode: "enforce" })[1],
  observed("allow", day(5), "s1", bash("git push origin main"), "no-force-push", {
    verdict: "allow",
  })[1],
  observed("old", "2026-10-20T10:00:00.000Z", "s9", bash("git push --force"), "no-force-push")[1],
  {
    ...observed("push-1", day(2), "s1", bash("git push --force origin main"), "no-force-push", {
      at: day(8),
    })[1],
    data: { tool_event_id: pushTool.id },
  },
];

const events = [...pairs.flat(), ...ignored];
const window = { since: new Date("2026-11-01T00:00:00Z"), until: new Date("2026-11-09T00:00:00Z") };
const now = new Date("2026-11-08T15:00:00Z");

describe("likely false positives", () => {
  it.each([
    ["echo git push --force", true],
    ['echo "git push --force"', true],
    ["FOO=1 echo git push --force", true],
    ['git commit -m "never git push --force"', true],
    ["git status # git push --force later", true],
    ["grep -rn 'git push --force' docs", true],
    ["rg git push --force src", true],
    ["git push --force origin main", false],
    ["git push --force # on purpose", false],
    ["echo done && git push --force", false],
    ["echo done > log; git push --force", false],
    ['bash -c "git push --force"', false],
    ["echo 'git push --force' | sh", false],
    ["echo $(git push --force)", false],
    ['echo "`git push --force`"', false],
    ["git pull origin main", false],
  ])("%s -> %s", (command, expected) => {
    expect(matchesOnlyInertText("git\\s+push\\s+.*--force", command)).toBe(expected);
  });

  it("finds a real match behind an inert one", () => {
    expect(matchesOnlyInertText("rm\\s+-rf", 'git commit -m "stop rm -rf" && rm -rf build')).toBe(
      false,
    );
    expect(matchesOnlyInertText("^rm", "rm -rf build")).toBe(false);
    expect(matchesOnlyInertText("[", "echo [")).toBe(false);
  });

  it("marks reads on a path rule that names no tool", () => {
    const [read, edit, env] = [6, 7, 8].map((i) => (pairs[i] as [LedgerEvent, LedgerEvent])[1]);
    expect(falsePositiveReason(read as LedgerEvent, rule("protect-migrations"))).toBe(
      "Read only reads, and the rule matches a path for any tool",
    );
    expect(falsePositiveReason(edit as LedgerEvent, rule("protect-migrations"))).toBeNull();
    expect(falsePositiveReason(env as LedgerEvent, rule("env-reads"))).toBeNull();
    expect(falsePositiveReason(read as LedgerEvent, undefined)).toBeNull();
  });
});

describe("observedRules", () => {
  it("counts hits, sessions and likely false positives per rule", () => {
    const observedNow = observedRules(
      events.filter((event) => event.ts >= "2026-11-01"),
      rules,
    );
    expect(
      observedNow.map((r) => [r.rule_id, r.verdicts, r.hits, r.sessions, r.likely_false_positives]),
    ).toEqual([
      ["no-force-push", ["block"], 6, 3, 3],
      ["protect-migrations", ["ask"], 2, 2, 1],
      ["env-reads", ["block"], 1, 1, 0],
      ["mcp.allow", ["block"], 1, 1, 0],
    ]);
    const push = observedNow[0];
    expect(push?.examples).toEqual([
      {
        tool: "Bash",
        input: "git push --force origin main",
        hits: 2,
        likely_false_positive: null,
      },
      { tool: "Bash", input: 'bash -c "git push --force"', hits: 1, likely_false_positive: null },
      {
        tool: "Bash",
        input: "echo git push --force",
        hits: 1,
        likely_false_positive:
          "the command matched only inside quotes, a comment or the arguments of echo, grep or rg",
      },
    ]);
    expect(push?.more_examples).toBe(2);
    expect(push?.mode).toBe("observe");
    expect(observedNow.find((r) => r.rule_id === "mcp.allow")?.mode).toBeNull();
  });
});

describe("buildPolicyReport", () => {
  const item = buildPolicyReport(events, { ...window, now, rules, policyPath: "selfhost.toml" });

  it("is a valid open policy_report review item", () => {
    expect(validateReviewItem(item)).toMatchObject({ ok: true });
    expect(item).toMatchObject({
      schema: "selfhost.review_item/v1",
      kind: "policy_report",
      title: "Observed rules would have stopped 10 tool calls (2026-11-01 to 2026-11-08)",
      state: "open",
      blocking: false,
      repo: "acme/api",
      owners: [],
      created_at: "2026-11-08T15:00:00.000Z",
      updated_at: "2026-11-08T15:00:00.000Z",
      risk: {
        score: 10,
        reasons: [
          "Observe mode only: no agent was stopped",
          "Likely false positives: 4 of 10 hits",
        ],
      },
    });
    const counted = pairs.map(([, evaluated]) => evaluated.id).sort();
    expect(item.source_event_ids).toEqual(counted);
  });

  it("lists each rule with examples, false positives and how to promote it", () => {
    expect(item.brief?.split("\n")).toEqual([
      "Rules in observe mode record what they would have done and never stop an agent.",
      "",
      "From 2026-11-01 to 2026-11-08 (UTC) they would have stopped 10 tool calls in 4 sessions. Likely false positives: 4.",
      "",
      "Likely false positives are checked against the rules in `selfhost.toml`.",
      "",
      "### no-force-push",
      "",
      "Would block: 6 hits in 3 sessions, 3 likely false positives.",
      "",
      "- Bash: `git push --force origin main` (2 hits)",
      '- Bash: `bash -c "git push --force"` (1 hit)',
      "- Bash: `echo git push --force` (1 hit). Likely false positive: the command matched only inside quotes, a comment or the arguments of echo, grep or rg.",
      "- and 2 other calls",
      "",
      "Promote with `selfhost policy promote no-force-push`.",
      "",
      "### protect-migrations",
      "",
      "Would ask: 2 hits in 2 sessions, 1 likely false positive.",
      "",
      "- Edit: `db/migrations/0042.sql` (1 hit)",
      "- Read: `db/migrations/0042.sql` (1 hit). Likely false positive: Read only reads, and the rule matches a path for any tool.",
      "",
      "Promote with `selfhost policy promote protect-migrations`.",
      "",
      "### env-reads",
      "",
      "Would block: 1 hit in 1 session, 0 likely false positives.",
      "",
      "- Read: `.env` (1 hit)",
      "",
      "Promote with `selfhost policy promote env-reads`.",
      "",
      "### mcp.allow (MCP allowlist)",
      "",
      "Would block: 1 hit in 1 session, 0 likely false positives.",
      "",
      "- mcp__github__create_issue: no input recorded (1 hit)",
    ]);
  });

  it("gives the same id for the same window, and a new one for the next week", () => {
    const again = buildPolicyReport(events.slice(0, 5), {
      ...window,
      now: new Date("2026-11-09T08:00:00Z"),
    });
    expect(again.id).toBe(item.id);
    const next = buildPolicyReport(events, {
      since: new Date("2026-11-08T00:00:00Z"),
      until: new Date("2026-11-16T00:00:00Z"),
      now,
    });
    expect(next.id).not.toBe(item.id);
    expect(validateReviewItem(next)).toMatchObject({ ok: true });
  });

  it("marks nothing without the rules, and says so", () => {
    const bare = buildPolicyReport(events, { ...window, now });
    expect(bare.risk.reasons).toContain("Likely false positives: 0 of 10 hits");
    expect(bare.brief).toContain(
      "No selfhost.toml was read, so likely false positives are not marked.",
    );
  });

  it("reports an empty window and notes rules that moved on", () => {
    const empty = buildPolicyReport([], { ...window, now, rules });
    expect(validateReviewItem(empty)).toMatchObject({ ok: true });
    expect(empty).toMatchObject({
      title: "No observed rule fired (2026-11-01 to 2026-11-08)",
      risk: { score: 0 },
      source_event_ids: [],
    });
    expect(empty.repo).toBeUndefined();

    const promoted = rules.map((r) => (r.id === "no-force-push" ? { ...r, mode: "enforce" } : r));
    const later = buildPolicyReport(events, {
      ...window,
      now,
      rules: promoted.filter((r) => r.id !== "env-reads") as Rule[],
    });
    expect(later.brief).toContain("Now in enforce mode in selfhost.toml.");
    expect(later.brief).toContain("No longer in selfhost.toml.");
  });

  it("covers whole UTC days from --since through today", () => {
    expect(reportWindow(parseSince("7d", now) as Date, now)).toEqual(window);
  });
});

describe("selfhost policy report", () => {
  let ledger: Ledger;

  beforeAll(async () => {
    ledger = await openLedger({ dataDir: "memory://" });
    await ledger.append(events);
  });

  afterAll(async () => {
    await ledger.close();
  });

  it("reads observed hits from the ledger and prints the review item as JSON", async () => {
    const repo = tempDir("report");
    repo.write("selfhost.toml", POLICY);
    const lines: string[] = [];
    const io = { env: {}, cwd: repo.root, write: (line: string) => lines.push(line), now };
    const item = await runPolicyReport({ json: true }, io, ledger);
    expect(JSON.parse(lines.join("\n"))).toEqual(item);
    expect(item).toEqual(
      buildPolicyReport(events, { ...window, now, rules, policyPath: "selfhost.toml" }),
    );

    lines.length = 0;
    await runPolicyReport({ since: "2026-11-05" }, io, ledger);
    expect(lines[0]).toBe(
      "Observed rules would have stopped 5 tool calls (2026-11-05 to 2026-11-08)",
    );
    expect(lines).toContain("### protect-migrations");
  });

  it("fails on an invalid selfhost.toml", async () => {
    const repo = tempDir("report-invalid");
    repo.write("selfhost.toml", "version = 2\n");
    const io = { env: {}, cwd: repo.root, write: () => {}, now };
    await expect(runPolicyReport({}, io, ledger)).rejects.toThrow(/selfhost.toml is not valid/);
  });

  it("runs from the command line on an empty ledger", async () => {
    const dir = tempDir("report-cli");
    mkdirSync(dir.path(".git"));
    const result = await run(["policy", "report", "--json", "--data-dir", "memory://"], {
      cwd: dir.root,
      now,
    });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    const item = JSON.parse(result.out);
    expect(validateReviewItem(item)).toMatchObject({ ok: true });
    expect(item.title).toBe("No observed rule fired (2026-11-01 to 2026-11-08)");
  });
});

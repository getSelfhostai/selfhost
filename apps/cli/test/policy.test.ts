import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import { type Ledger, openLedger, stableEventId } from "@selfhost/ledger";
import { EVENT_SCHEMA, type LedgerEvent } from "@selfhost/schema";
import { Command } from "commander";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseAgent, policyObserve, policyReplay, registerPolicy } from "../src/policy/commands.js";
import { createProgram } from "../src/program.js";
import { run, tempDir } from "./run.js";

const CATEGORIES = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "packages",
    "schema",
    "fixtures",
    "config",
    "valid",
    "policy-categories.toml",
  ),
  "utf8",
);
/**
 * The same policy with the built-in guardrails off, so these tests see only its rules. The
 * guardrails have their own test below and in guardrails.test.ts.
 */
const RULES_ONLY = `${CATEGORIES}\n[guardrails]\nmode = "off"\n`;

function repo(files: Record<string, string>) {
  const dir = tempDir("policy");
  mkdirSync(dir.path(".git"));
  for (const [name, content] of Object.entries(files)) dir.write(name, content);
  return dir;
}

describe("selfhost policy", () => {
  it("adds check, test and observe to a policy group another module already created", () => {
    const program = new Command();
    program.command("policy").description("existing").command("promote");
    registerPolicy(
      program,
      () => ({ env: {}, cwd: "/", write: () => {}, setExitCode: () => {} }),
      () => {},
    );
    const groups = program.commands.filter((command) => command.name() === "policy");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.commands.map((command) => command.name())).toEqual([
      "promote",
      "check",
      "test",
      "observe",
    ]);
  });

  it("is registered on the program", () => {
    const policy = createProgram().commands.find((command) => command.name() === "policy");
    expect(policy?.commands.map((command) => command.name())).toEqual([
      "check",
      "test",
      "observe",
      "promote",
      "report",
    ]);
  });
});

describe("selfhost policy check", () => {
  it("lists every check with its mode when the file is valid", async () => {
    const dir = repo({ "selfhost.toml": RULES_ONLY, "src/.keep": "" });
    const result = await run(["policy", "check"], { cwd: dir.path("src") });
    expect(result.code).toBe(0);
    expect(result.out).toContain("valid, 8 checks (1 enforce, 6 observe, 1 off)");
    expect(result.out).toMatch(/mcp\.allow\s+observe\s+block/);
  });

  it("exits 1 and names file:line: field for every error", async () => {
    const dir = repo({
      "selfhost.toml": 'version = 1\n\n[mcp]\nmode = "strict"\n\n[models]\nallow = [""]\n',
    });
    const result = await run(["policy", "check"], { cwd: dir.root });
    expect(result.code).toBe(1);
    expect(result.out.split("\n")).toEqual([
      "selfhost.toml: invalid, 2 errors",
      "selfhost.toml:4: mcp.mode: Expected one of: observe, enforce, off",
      "selfhost.toml:7: models.allow[0]: Expected string length greater or equal to 1",
    ]);
  });

  it("prints the same facts as JSON", async () => {
    const dir = repo({ "conf/team.toml": 'version = 1\n[mcp]\nmode = "strict"\n' });
    const result = await run(["policy", "check", "--json", "--config", "conf/team.toml"], {
      cwd: dir.root,
    });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({
      schema: "selfhost.policy_check/v1",
      path: dir.path("conf", "team.toml"),
      from: "flag",
      team_policy: null,
      valid: false,
      errors: [{ field: "mcp.mode", line: 3, message: "Expected one of: observe, enforce, off" }],
      checks: [],
    });
  });

  it("fails with a JSON error when there is no selfhost.toml", async () => {
    const result = await run(["policy", "check", "--json"], { cwd: repo({}).root });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({ schema: "selfhost.error/v1" });
    expect(JSON.parse(result.out).error).toMatch(/No selfhost.toml found/);
  });
});

describe("selfhost policy test", () => {
  it("prints the rules that fire on one call", async () => {
    const dir = repo({ "selfhost.toml": RULES_ONLY });
    const args = ["policy", "test", "--tool", "Bash", "--command", "git push --force"];
    const result = await run([...args, "--model", "o3", "--agent", "claude"], { cwd: dir.root });
    expect(result.code).toBe(0);
    expect(result.out).toContain("2 rules fire:");
    expect(result.out).toMatch(/no-force-push\s+observe\s+block\s+Force pushes are blocked/);
    expect(result.out).toMatch(/models\.allow\s+observe\s+block\s+Model "o3" is not/);
    expect(result.out).toContain("Decision: block (observe): recorded only, nothing is stopped.");
    const none = await run(["policy", "test", "--tool", "Read", "--path", "src/a.ts"], {
      cwd: dir.root,
    });
    expect(none.out).toBe("No rule fires.");
  });

  it("includes the built-in guardrails, which are enforced unless [guardrails] says otherwise", async () => {
    const dir = repo({ "selfhost.toml": CATEGORIES });
    const args = ["policy", "test", "--tool", "Bash", "--command", "git push --force"];
    const result = await run([...args, "--json"], { cwd: dir.root });
    expect(JSON.parse(result.out)).toMatchObject({
      decision: "block",
      mode: "enforce",
      hits: expect.arrayContaining([
        expect.objectContaining({ rule_id: "no-force-push", mode: "observe" }),
        expect.objectContaining({ rule_id: "guard.force_push", mode: "enforce" }),
      ]),
    });
  });

  it("applies a team's overrides and reads the MCP server from the tool name", async () => {
    const dir = repo({ "selfhost.toml": RULES_ONLY });
    const result = await run(
      ["policy", "test", "--tool", "mcp__slack__post_message", "--team", "platform", "--json"],
      { cwd: dir.root },
    );
    expect(JSON.parse(result.out)).toEqual({
      schema: "selfhost.policy_test/v1",
      config: dir.path("selfhost.toml"),
      team: "platform",
      call: { tool: "mcp__slack__post_message", mcpServer: "slack" },
      hits: [
        {
          rule_id: "mcp.allow",
          mode: "enforce",
          verdict: "block",
          message: "Platform agents only use the github and acme MCP servers.",
          irreversible: false,
        },
      ],
      decision: "block",
      mode: "enforce",
    });
  });

  it("normalizes the path and rejects unknown agents and teams", async () => {
    const dir = repo({ "selfhost.toml": RULES_ONLY });
    const path = await run(
      ["policy", "test", "--tool", "Edit", "--path", "./db/migrations/001.sql", "--json"],
      { cwd: dir.root },
    );
    expect(JSON.parse(path.out).hits.map((hit: { rule_id: string }) => hit.rule_id)).toEqual([
      "protect-migrations",
    ]);
    const agent = await run(["policy", "test", "--tool", "Bash", "--agent", "vim"], {
      cwd: dir.root,
    });
    expect(agent.code).toBe(1);
    expect(agent.err).toMatch(/--agent/);
    const team = await run(["policy", "test", "--tool", "Bash", "--team", "nope"], {
      cwd: dir.root,
    });
    expect(team.err).toMatch(/--team: "nope" has no \[teams.nope\] table/);
  });

  it("refuses an invalid policy with its errors", async () => {
    const dir = repo({ "selfhost.toml": 'version = 1\n[mcp]\nmode = "strict"\n' });
    const result = await run(["policy", "test", "--tool", "Bash"], { cwd: dir.root });
    expect(result.code).toBe(1);
    expect(result.err).toContain("selfhost.toml:3: mcp.mode: Expected one of");
  });
});

describe("selfhost policy test with test files", () => {
  const CASES = `[[cases]]
name = "force push is recorded"
command = "git push --force origin main"
decision = "block"
mode = "observe"
rules = ["no-force-push"]

[[cases]]
name = "migrations wait for a person"
tool = "Edit"
path = "./db/migrations/002.sql"
decision = "ask"
mode = "enforce"

[[cases]]
name = "platform force push is enforced"
command = "git push --force"
team = "platform"
decision = "block"
mode = "enforce"
rules = ["no-force-push"]

[[cases]]
name = "reading source is fine"
tool = "Read"
path = "src/app.ts"
decision = "allow"
rules = []
`;

  it("runs selfhost.test.toml next to selfhost.toml when given no paths", async () => {
    const dir = repo({
      "selfhost.toml": RULES_ONLY,
      "selfhost.test.toml": CASES,
      "src/.keep": "",
    });
    const result = await run(["policy", "test"], { cwd: dir.path("src") });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out.split("\n")).toEqual([
      "../selfhost.test.toml (../selfhost.toml): 4 passed",
      "PASS: 4 of 4 cases passed in 1 file.",
    ]);
  });

  it("exits 1 and shows expected and actual for each mismatch", async () => {
    const dir = repo({
      "selfhost.toml": RULES_ONLY,
      "policy/edge.test.toml": `config = "../selfhost.toml"

[[cases]]
name = "force push"
command = "git push --force"
decision = "block"
mode = "enforce"
rules = ["no-force-push"]

[[cases]]
name = "paste site"
tool = "WebFetch"
url = "https://pastebin.com/raw/x"
decision = "allow"

[[cases]]
name = "unknown team"
command = "ls"
team = "nope"
decision = "allow"
`,
    });
    const result = await run(["policy", "test", "policy"], { cwd: dir.root });
    expect(result.code).toBe(1);
    expect(result.out.split("\n")).toEqual([
      "policy/edge.test.toml (selfhost.toml): 0 passed, 3 failed",
      "  FAIL force push (policy/edge.test.toml:3)",
      "    expected block (enforce), rules no-force-push",
      "    got      block (observe), rules no-force-push",
      "  FAIL paste site (policy/edge.test.toml:10)",
      "    expected allow",
      "    got      block (observe), rules no-paste-sites",
      "  FAIL unknown team (policy/edge.test.toml:16)",
      '    team: "nope" has no [teams.nope] table in the policy',
      "FAIL: 0 of 3 cases passed in 1 file.",
    ]);
    const json = await run(["policy", "test", "policy/edge.test.toml", "--json"], {
      cwd: dir.root,
    });
    const report = JSON.parse(json.out);
    expect(json.code).toBe(1);
    expect(report).toMatchObject({
      schema: "selfhost.policy_tests/v1",
      passed: 0,
      failed: 3,
      invalid_files: 0,
    });
    expect(report.files[0].cases[0]).toMatchObject({
      name: "force push",
      line: 3,
      passed: false,
      call: { tool: "Bash", command: "git push --force" },
      expected: { decision: "block", mode: "enforce", rules: ["no-force-push"] },
      actual: { decision: "block", mode: "observe", rules: ["no-force-push"] },
      problems: ["mode: expected enforce, got observe"],
    });
    expect(report.files[0].cases[1].problems).toEqual([
      "decision: expected allow, got block (observe)",
    ]);
  });

  it("names the file, line and field when a test file or its policy is invalid", async () => {
    const dir = repo({
      "selfhost.toml": RULES_ONLY,
      "bad.test.toml": '[[cases]]\nname = "x"\ndecision = "maybe"\n',
      "broken.toml": 'version = 1\n[mcp]\nmode = "strict"\n',
      "broken.test.toml": '[[cases]]\nname = "x"\ndecision = "allow"\n',
    });
    const result = await run(["policy", "test", "bad.test.toml", "broken.test.toml"], {
      cwd: dir.root,
    });
    expect(result.code).toBe(1);
    expect(result.out.split("\n")).toEqual([
      "bad.test.toml: not run, 1 error",
      "  bad.test.toml:3: cases[0].decision: Expected one of: allow, ask, block",
      "broken.test.toml: not run, 1 error",
      "  broken.toml:3: mcp.mode: Expected one of: observe, enforce, off",
      "FAIL: 0 of 0 cases passed in 2 files, 2 files not run.",
    ]);
  });

  it("runs every file in a folder against the policy each one names, or --config", async () => {
    const dir = repo({
      "selfhost.toml": RULES_ONLY,
      "tests/a.test.toml": `config = "../selfhost.toml"\n${CASES}`,
      "tests/b.test.toml": CASES,
      "tests/notes.toml": "not a test file",
    });
    const result = await run(["policy", "test", "tests", "--json"], { cwd: dir.root });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    // b has no config and no b.toml beside it, so the nearest selfhost.toml is used.
    expect(report.files.map((f: { path: string; config: string }) => [f.path, f.config])).toEqual([
      [dir.path("tests", "a.test.toml"), dir.path("selfhost.toml")],
      [dir.path("tests", "b.test.toml"), dir.path("selfhost.toml")],
    ]);
    dir.write("other.toml", "version = 1\n");
    const other = await run(["policy", "test", "tests/b.test.toml", "--config", "other.toml"], {
      cwd: dir.root,
    });
    expect(other.code).toBe(1);
    expect(other.out).toContain("b.test.toml (other.toml): 1 passed, 3 failed");
  });

  it("explains what is missing or contradictory", async () => {
    const dir = repo({ "selfhost.toml": RULES_ONLY, "a.test.toml": CASES });
    const cases: [string[], RegExp][] = [
      [[], /No test files given and no selfhost\.test\.toml/],
      [["missing.test.toml"], /missing\.test\.toml does not exist/],
      [["a.test.toml", "--tool", "Bash"], /--tool checks one call/],
      [["--command", "ls"], /--command needs --tool <name>/],
      [["--replay", "x.json", "--from-ledger"], /not both/],
      [["a.test.toml", "--team", "platform"], /test cases set team themselves/],
    ];
    for (const [args, message] of cases) {
      const result = await run(["policy", "test", ...args], { cwd: dir.root });
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.err).toMatch(message);
    }
  });
});

describe("selfhost policy test --replay", () => {
  it("runs recorded calls from JSON Lines and JSON, ledger events included", async () => {
    const dir = repo({ "selfhost.toml": RULES_ONLY });
    const lines = [
      { tool: "Bash", command: "git push --force origin main" },
      { tool: "Read", path: "src/app.ts" },
      {
        id: "0190f5a0-0000-7000-8000-000000000001",
        schema: "selfhost.event/v1",
        ts: "2026-11-01T09:01:00.000Z",
        source: "hook",
        kind: "tool.called",
        actor: { kind: "agent", id: "codex:session:s1" },
        agent: { vendor: "codex" },
        model: "o3",
        tool: { name: "apply_patch" },
        target: { type: "file", value: "db/migrations/003.sql" },
      },
      { kind: "session.started", ts: "2026-11-01T09:00:00.000Z" },
    ];
    dir.write("calls.jsonl", `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const text = await run(["policy", "test", "--replay", "calls.jsonl"], { cwd: dir.root });
    expect(text.err).toBe("");
    expect(text.code).toBe(0);
    const out = text.out.split("\n");
    expect(out[0]).toBe(
      "Replayed 3 tool calls from calls.jsonl against selfhost.toml (1 skipped).",
    );
    expect(text.out).toMatch(/^ {2}ask \(enforce\) +1$/m);
    expect(text.out).toMatch(/^ {2}block \(observe\) +1$/m);
    expect(text.out).toMatch(/^ {2}allow +1$/m);
    expect(text.out).toMatch(
      /^ {2}2026-11-01 09:01 +ask \(enforce\) +protect-migrations,models\.allow +apply_patch +db\/migrations\/003\.sql$/m,
    );

    dir.write("calls.json", JSON.stringify(lines.slice(0, 2)));
    const json = await run(["policy", "test", "--replay", "calls.json", "--json"], {
      cwd: dir.root,
    });
    expect(JSON.parse(json.out)).toMatchObject({
      schema: "selfhost.policy_replay/v1",
      source: { kind: "file", path: dir.path("calls.json") },
      calls: 2,
      skipped: 0,
      decisions: [
        { decision: "block", mode: "observe", calls: 1 },
        { decision: "allow", mode: null, calls: 1 },
      ],
      rules: [{ rule_id: "no-force-push", calls: 1 }],
    });
  });

  it("refuses entries that are not tool calls", async () => {
    const dir = repo({ "selfhost.toml": RULES_ONLY, "calls.json": '[{"command": "ls"}]' });
    const result = await run(["policy", "test", "--replay", "calls.json"], { cwd: dir.root });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/entry 1: expected a tool call with a tool name/);
  });
});

describe("parseAgent", () => {
  it("maps the names people type", () => {
    expect(parseAgent("claude")).toBe("claude_code");
    expect(parseAgent("Claude-Code")).toBe("claude_code");
    expect(parseAgent("codex")).toBe("codex");
    expect(parseAgent(undefined)).toBeUndefined();
    expect(() => parseAgent("vim")).toThrow(/--agent/);
  });
});

describe("selfhost policy observe", () => {
  const POLICY = `version = 1

[[rules]]
id = "no-force-push"
match = { command = "git\\\\s+push\\\\s+.*--force" }
action = "block"
message = "Force pushes are blocked."

[models]
allow = ["claude-opus-*"]
`;
  let ledger: Ledger;

  beforeAll(() => {
    // No global or system git config, so signing or hooks on this machine do not leak in.
    process.env.GIT_CONFIG_GLOBAL = devNull;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
  });

  beforeEach(async () => {
    ledger = await openLedger({ dataDir: "memory://" });
  });

  afterEach(async () => {
    await ledger.close();
  });

  function event(ts: string, fields: Partial<LedgerEvent>): LedgerEvent {
    return {
      id: stableEventId(ts, `cli-test:${ts}`),
      schema: EVENT_SCHEMA,
      ts,
      source: "hook",
      kind: "tool.called",
      actor: { kind: "agent", id: "claude_code:session:s1" },
      agent: { vendor: "claude_code" },
      session_id: "s1",
      ...fields,
    };
  }

  /** A committed repository with the policy, and one session in it in the ledger. */
  async function seeded() {
    const dir = tempDir("policy-git");
    execFileSync("git", ["-C", dir.root, "init", "-q", "-b", "main"]);
    dir.write("selfhost.toml", POLICY);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Dev",
      GIT_AUTHOR_EMAIL: "dev@example.com",
      GIT_COMMITTER_NAME: "Dev",
      GIT_COMMITTER_EMAIL: "dev@example.com",
    };
    execFileSync("git", ["-C", dir.root, "add", "selfhost.toml"], { env });
    execFileSync("git", ["-C", dir.root, "commit", "-q", "-m", "Add policy"], { env });
    const commit = execFileSync("git", ["-C", dir.root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    await ledger.append([
      event("2026-11-01T09:00:00.000Z", {
        kind: "session.started",
        actor: { kind: "person", id: "dev@example.com" },
        data: { cwd: dir.path("src") },
      }),
      event("2026-11-01T09:01:00.000Z", {
        model: "claude-opus-5-5",
        tool: { name: "Bash", input_summary: "git push --force origin main" },
        target: { type: "command", value: "git push --force origin main" },
      }),
      event("2026-11-01T09:02:00.000Z", {
        model: "gpt-5.4",
        tool: { name: "Edit", input_summary: "app.ts" },
        target: { type: "file", value: "app.ts" },
      }),
    ]);
    return { dir, commit };
  }

  const io = (cwd: string, lines: string[]) => ({
    env: {},
    cwd,
    write: (line: string) => lines.push(line),
    setExitCode: () => {},
    now: new Date("2026-11-08T00:00:00.000Z"),
  });

  it("records what each rule would have blocked, then only duplicates", async () => {
    const { dir, commit } = await seeded();
    const lines: string[] = [];
    const first = await policyObserve({ dataDir: "memory://" }, io(dir.root, lines), ledger);
    expect(first).toMatchObject({
      schema: "selfhost.policy_observe/v1",
      config: dir.path("selfhost.toml"),
      repo: dir.root,
      since: "2026-10-09T00:00:00.000Z",
      team: null,
      policy: { commit, dirty: false },
      tool_calls: 2,
      evaluated: 2,
      recorded: 2,
      duplicates: 0,
      rules: [
        { rule_id: "no-force-push", mode: "observe", action: "block", recorded: 1, duplicates: 0 },
        { rule_id: "models.allow", mode: "observe", action: "block", recorded: 1, duplicates: 0 },
      ],
    });
    expect(lines[0]).toBe(
      `Evaluated 2 tool calls from ${dir.root} (2 in the ledger since 2026-10-09) ` +
        `against selfhost.toml (commit ${commit.slice(0, 12)}).`,
    );
    expect(lines).toContain("Recorded 2 new policy.evaluated events (0 already in the ledger).");

    const second = await policyObserve({ json: true }, io(dir.root, []), ledger);
    expect(second).toMatchObject({ recorded: 0, duplicates: 2 });
    const { events } = await ledger.query({ kind: "policy.evaluated" });
    expect(events.map((e) => e.decision?.policy_commit)).toEqual([commit, commit]);
  });

  it("evaluates nothing for a repository the sessions did not run in", async () => {
    await seeded();
    const other = repo({ "selfhost.toml": POLICY });
    const lines: string[] = [];
    const report = await policyObserve({ json: true }, io(other.root, lines), ledger);
    expect(report).toMatchObject({ tool_calls: 2, evaluated: 0, recorded: 0 });
    expect(report.policy.commit).toBeNull();
    expect(JSON.parse(lines.join("\n")).schema).toBe("selfhost.policy_observe/v1");
  });

  it("replays the newest tool calls of this repository with --from-ledger", async () => {
    const { dir } = await seeded();
    const lines: string[] = [];
    const report = await policyReplay({ fromLedger: true }, io(dir.root, lines), ledger);
    expect(report).toMatchObject({
      schema: "selfhost.policy_replay/v1",
      source: { kind: "ledger", repo: dir.root, since: "2026-11-01T00:00:00.000Z" },
      calls: 2,
      skipped: 0,
      rules: [
        { rule_id: "guard.force_push", calls: 1 },
        { rule_id: "models.allow", calls: 1 },
        { rule_id: "no-force-push", calls: 1 },
      ],
    });
    // Newest first, as the ledger returns them. The force push also trips the built-in guardrail,
    // which is enforced by default.
    expect(report.results.map((r) => [r.ts, r.decision, r.mode, r.rules])).toEqual([
      ["2026-11-01T09:02:00.000Z", "block", "observe", ["models.allow"]],
      ["2026-11-01T09:01:00.000Z", "block", "enforce", ["no-force-push", "guard.force_push"]],
    ]);
    expect(lines[0]).toMatch(/^Replayed 2 tool calls from the ledger \(.+ since 2026-11-01\)/);
    expect(await ledger.query({ kind: "policy.evaluated" })).toMatchObject({ events: [] });

    const one = await policyReplay({ fromLedger: true, limit: "1" }, io(dir.root, []), ledger);
    expect(one.calls).toBe(1);
    const elsewhere = repo({ "selfhost.toml": POLICY });
    const none = await policyReplay({ fromLedger: true }, io(elsewhere.root, []), ledger);
    expect(none).toMatchObject({ calls: 0, skipped: 2 });
  });

  it("works through the command line on an empty embedded ledger", async () => {
    const dir = repo({ "selfhost.toml": POLICY });
    const result = await run(["policy", "observe", "--data-dir", "memory://", "--json"], {
      cwd: dir.root,
    });
    expect(result.err).toBe("");
    expect(JSON.parse(result.out)).toMatchObject({ ledger: "memory://", tool_calls: 0 });
  });
});

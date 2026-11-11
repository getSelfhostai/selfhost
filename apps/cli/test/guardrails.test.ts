import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "@selfhost/ledger";
import type { LedgerEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { packageGuardChecker } from "../src/hooks/checkers.js";
import { drainSpool } from "../src/hooks/drain.js";
import { checkPreToolCall } from "../src/hooks/pretool.js";
import { type GuardRecord, runHook, type SpoolLine } from "../src/hooks/receive.js";
import { canAsk, type HookAgent } from "../src/hooks/vendors.js";
import { tempDir } from "./run.js";

/**
 * The shared fixture cases (fixtures/guardrails) replayed through each agent's own pre-tool
 * payload and `selfhost hook`, end to end: the answer printed in the agent's format, the record
 * on the spool line, and the policy.evaluated event the drain writes to the ledger.
 */

interface Case {
  id: string;
  shell?: string;
  read?: string;
  write?: string;
  mcp?: { server: string; tool: string };
  verdict: "allow" | "block" | "ask";
  rule_id?: string;
  mode?: "observe" | "enforce";
}

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures", "guardrails");
const cases = (JSON.parse(readFileSync(join(fixtures, "cases.json"), "utf8")) as { cases: Case[] })
  .cases;
const POLICY = readFileSync(join(fixtures, "selfhost.toml"), "utf8");

interface Replay {
  agent: HookAgent;
  event: string;
  payload: Record<string, unknown>;
  /** Cursor's preToolUse for a call its own hook decides: only a block is answered there. */
  deferred?: boolean;
}

function setup() {
  const workspace = tempDir("guard-ws");
  workspace.write(".git/HEAD", "ref: refs/heads/main\n");
  workspace.write("selfhost.toml", POLICY);
  const home = tempDir("guard-home");
  const fill = (text: string) =>
    text.replaceAll("{workspace}", workspace.root).replaceAll("{home}", home.root);
  const file = (value: string) => {
    const path = fill(value);
    if (path.startsWith("~/")) return home.path(path.slice(2));
    return path.startsWith("/") ? path : workspace.path(path);
  };
  return { workspace, home, fill, file };
}

/** The payload each agent sends for a fixture case, from the vendors' hook docs. */
function replays(c: Case, ws: string, fill: (t: string) => string, file: (v: string) => string) {
  const out: Replay[] = [];
  const claude = (tool: string, input: Record<string, unknown>) => ({
    session_id: "sess-claude",
    cwd: ws,
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: input,
    tool_use_id: `toolu_${c.id}`,
  });
  const codex = (tool: string, input: Record<string, unknown>) => ({
    session_id: "sess-codex",
    turn_id: "turn-1",
    cwd: ws,
    hook_event_name: "PreToolUse",
    model: "gpt-5.5",
    tool_name: tool,
    tool_input: input,
    tool_use_id: `call_${c.id}`,
  });
  const cursor = (event: string, fields: Record<string, unknown>) => ({
    conversation_id: "conv-cursor",
    generation_id: "gen-1",
    hook_event_name: event,
    workspace_roots: [ws],
    ...fields,
  });
  const opencode = (tool: string, input: Record<string, unknown>) => ({
    hook_event_name: "tool.execute.before",
    session_id: "sess-opencode",
    call_id: `call-${c.id}`,
    cwd: ws,
    tool_name: tool,
    tool_input: input,
  });
  if (c.shell !== undefined) {
    const command = fill(c.shell);
    out.push(
      { agent: "claude", event: "PreToolUse", payload: claude("Bash", { command }) },
      { agent: "codex", event: "PreToolUse", payload: codex("Bash", { command }) },
      {
        agent: "cursor",
        event: "beforeShellExecution",
        payload: cursor("beforeShellExecution", { command, cwd: ws }),
      },
      {
        agent: "cursor",
        event: "preToolUse",
        payload: cursor("preToolUse", {
          tool_name: "Shell",
          tool_input: { command, working_directory: ws },
          tool_use_id: `cursor-${c.id}`,
          cwd: ws,
        }),
        deferred: true,
      },
      { agent: "opencode", event: "tool.execute.before", payload: opencode("bash", { command }) },
    );
  } else if (c.read !== undefined) {
    const path = file(c.read);
    out.push(
      { agent: "claude", event: "PreToolUse", payload: claude("Read", { file_path: path }) },
      {
        agent: "cursor",
        event: "beforeReadFile",
        payload: cursor("beforeReadFile", { file_path: path, content: "x" }),
      },
      {
        agent: "cursor",
        event: "preToolUse",
        payload: cursor("preToolUse", { tool_name: "Read", tool_input: { file_path: path } }),
        deferred: true,
      },
      {
        agent: "opencode",
        event: "tool.execute.before",
        payload: opencode("read", { filePath: path }),
      },
    );
  } else if (c.write !== undefined) {
    const path = file(c.write);
    const patch = `*** Begin Patch\n*** Add File: ${fill(c.write)}\n+select 1;\n*** End Patch\n`;
    out.push(
      {
        agent: "claude",
        event: "PreToolUse",
        payload: claude("Write", { file_path: path, content: "select 1;" }),
      },
      { agent: "codex", event: "PreToolUse", payload: codex("apply_patch", { command: patch }) },
      {
        agent: "cursor",
        event: "preToolUse",
        payload: cursor("preToolUse", { tool_name: "Write", tool_input: { file_path: path } }),
      },
      {
        agent: "opencode",
        event: "tool.execute.before",
        payload: opencode("write", { filePath: path, content: "select 1;" }),
      },
    );
  } else if (c.mcp) {
    const tool = `mcp__${c.mcp.server}__${c.mcp.tool}`;
    out.push(
      { agent: "claude", event: "PreToolUse", payload: claude(tool, {}) },
      { agent: "codex", event: "PreToolUse", payload: codex(tool, {}) },
      {
        agent: "cursor",
        event: "beforeMCPExecution",
        payload: cursor("beforeMCPExecution", {
          tool_name: c.mcp.tool,
          tool_input: {},
          mcp_server_name: c.mcp.server,
        }),
      },
    );
  }
  return out;
}

/** The answer an agent reads from the hook's stdout. */
function answerOf(agent: HookAgent, stdout: string): string {
  if (agent === "claude" || agent === "codex") {
    if (stdout === "") return "allow";
    return JSON.parse(stdout).hookSpecificOutput.permissionDecision;
  }
  if (agent === "cursor") return JSON.parse(stdout).permission;
  return JSON.parse(stdout).decision;
}

function expectedAnswer(c: Case, replay: Replay): string {
  if (c.verdict === "allow") return "allow";
  if (replay.deferred) return c.verdict === "block" ? "deny" : "allow";
  if (c.verdict === "block") return "deny";
  return canAsk(replay.agent, replay.event, undefined, { CLAUDE_CODE_ENTRYPOINT: "cli" })
    ? "ask"
    : "deny";
}

const spoolLines = (home: string): SpoolLine[] => {
  const dir = join(home, ".selfhost", "spool");
  return readdirSync(dir).flatMap((name) =>
    readFileSync(join(dir, name), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as SpoolLine),
  );
};

async function hook(replay: Replay, home: string) {
  let stdout = "";
  const errors: string[] = [];
  const code = await runHook([replay.agent], {
    env: { HOME: home, CLAUDE_CODE_ENTRYPOINT: "cli" },
    readStdin: async () => JSON.stringify(replay.payload),
    writeOutput: (text) => {
      stdout += text;
    },
    writeError: (line) => errors.push(line),
    now: new Date("2026-11-08T10:00:00Z"),
  });
  return { code, stdout, errors };
}

describe("the shared fixture cases in every agent", () => {
  it.each(cases.map((c) => [c.id, c] as const))("%s", async (_, c) => {
    const { workspace, home, fill, file } = setup();
    const all = replays(c, workspace.root, fill, file);
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const replay of all) {
      const result = await hook(replay, home.root);
      const where = `${replay.agent} ${replay.event}`;
      expect(result.code, where).toBe(0);
      expect(result.errors, where).toEqual([]);
      expect(answerOf(replay.agent, result.stdout), where).toBe(expectedAnswer(c, replay));
      const line = spoolLines(home.root).at(-1);
      const guard = line?.guard as GuardRecord | undefined;
      if (replay.deferred && c.verdict !== "block") {
        expect(guard, where).toBeUndefined();
        continue;
      }
      expect(guard?.hit?.rule_id, where).toBe(c.rule_id);
      if (c.mode) expect(guard?.hit?.mode, where).toBe(c.mode);
      expect(guard?.policy?.path, where).toBe(workspace.path("selfhost.toml"));
    }
  });
});

describe("audit events", () => {
  it("writes one policy.evaluated event per checked call, allow included", async () => {
    const { workspace, home, fill, file } = setup();
    const picked = ["force-push", "plain-push", "write-migration", "observe-rule-only"].map(
      (id) => cases.find((c) => c.id === id) as Case,
    );
    let checked = 0;
    for (const c of picked) {
      for (const replay of replays(c, workspace.root, fill, file)) {
        await hook(replay, home.root);
        if (!replay.deferred || c.verdict === "block") checked++;
      }
    }
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      const report = await drainSpool(ledger, join(home.root, ".selfhost", "spool"), {
        person: "dev@example.com",
        now: new Date("2026-11-08T10:05:00Z"),
      });
      expect(report.malformed).toBe(0);
      const { events } = await ledger.query({ kind: "policy.evaluated", limit: 500 });
      expect(events).toHaveLength(checked);
      const by = (agent: string, rule?: string) =>
        events.filter(
          (event: LedgerEvent) => event.agent?.vendor === agent && event.decision?.rule_id === rule,
        );

      const [claudePush] = by("claude_code", "guard.force_push");
      expect(claudePush?.decision).toMatchObject({
        verdict: "block",
        by: "selfhost-policy",
        rule_id: "guard.force_push",
        mode: "enforce",
      });
      expect(claudePush?.decision?.policy_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(claudePush?.tool).toEqual({
        name: "Bash",
        input_summary: "git push --force origin main",
      });
      expect(claudePush?.data).toMatchObject({
        hook_event: "PreToolUse",
        answer: "deny",
        irreversible: true,
        hits: [{ rule_id: "guard.force_push", mode: "enforce", verdict: "block" }],
      });
      // The decision points at the tool.called event mapped from the same payload.
      const tools = await ledger.query({ kind: "tool.called", limit: 500 });
      const toolIds = new Set(tools.events.map((event) => event.id));
      expect(toolIds.has(claudePush?.data?.tool_event_id as string)).toBe(true);

      // Cursor and OpenCode have no tool.called mapping; the decision carries the call itself.
      const [cursorPush] = by("cursor", "guard.force_push");
      expect(cursorPush?.tool?.name).toBe("Shell");
      expect(cursorPush?.target).toEqual({
        type: "command",
        value: "git push --force origin main",
      });
      expect(cursorPush?.session_id).toBe("conv-cursor");

      // An ask Codex cannot put to a person is applied as a block.
      const [codexMigration] = by("codex", "ask-before-migrations");
      expect(codexMigration?.decision?.verdict).toBe("block");
      expect(codexMigration?.data?.answer).toBe("deny");
      const [claudeMigration] = by("claude_code", "ask-before-migrations");
      expect(claudeMigration?.decision?.verdict).toBe("ask");

      // Allowed calls are recorded too, with no rule; observe hits say what enforce would do.
      expect(by("claude_code", undefined).map((event) => event.decision?.verdict)).toEqual([
        "allow",
      ]);
      const [observed] = by("claude_code", "observe-curl");
      expect(observed?.decision).toMatchObject({ verdict: "block", mode: "observe" });
      expect(observed?.data?.answer).toBe("allow");
    } finally {
      await ledger.close();
    }
  });

  it("masks a secret in the command before it reaches the ledger", async () => {
    const { workspace, home } = setup();
    const token = ["ghp", "_", "a".repeat(36)].join("");
    await hook(
      {
        agent: "claude",
        event: "PreToolUse",
        payload: {
          session_id: "s",
          cwd: workspace.root,
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: `GH_TOKEN=${token} git push --force` },
        },
      },
      home.root,
    );
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      await drainSpool(ledger, join(home.root, ".selfhost", "spool"), {
        person: "dev@example.com",
      });
      const { events } = await ledger.query({ kind: "policy.evaluated" });
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain(token);
      expect(events[0]?.redacted).toContain("target.value");
    } finally {
      await ledger.close();
    }
  });
});

describe("failure policy", () => {
  const push = (cwd: string) => ({
    agent: "claude" as const,
    event: "PreToolUse",
    payload: {
      session_id: "s",
      cwd,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push --force" },
    },
  });

  it("runs the built-in guardrails when selfhost.toml is invalid, and says so", async () => {
    const { workspace, home } = setup();
    workspace.write("selfhost.toml", "version = 1\n[guardrails]\nmode = 'sometimes'\n");
    const result = await hook(push(workspace.root), home.root);
    expect(answerOf("claude", result.stdout)).toBe("deny");
    expect(result.errors.join("\n")).toMatch(/selfhost\.toml is invalid, so only the built-in/);
    const guard = spoolLines(home.root).at(-1)?.guard;
    expect(guard?.failures?.[0]).toMatch(/guardrails\.mode/);
    expect(guard?.policy?.path).toBe(workspace.path("selfhost.toml"));
  });

  it("uses the built-in guardrails when there is no selfhost.toml", async () => {
    const empty = tempDir("guard-no-policy");
    const home = tempDir("guard-home");
    const result = await hook(push(empty.root), home.root);
    expect(answerOf("claude", result.stdout)).toBe("deny");
    expect(spoolLines(home.root).at(-1)?.guard?.policy).toBeUndefined();
  });

  it("fails open on an internal error, in each agent's format, and records it", async () => {
    const home = tempDir("guard-home");
    const broken = async () => {
      throw new Error("boom");
    };
    for (const [agent, payload, expected] of [
      ["claude", push("/x").payload, ""],
      [
        "cursor",
        { hook_event_name: "beforeShellExecution", command: "ls" },
        '{"permission":"allow"}',
      ],
      [
        "opencode",
        { hook_event_name: "tool.execute.before", tool_name: "bash" },
        '{"decision":"allow"}',
      ],
    ] as const) {
      let stdout = "";
      const errors: string[] = [];
      const code = await runHook([agent], {
        env: { HOME: home.root },
        readStdin: async () => JSON.stringify(payload),
        writeOutput: (text) => {
          stdout += text;
        },
        writeError: (line) => errors.push(line),
        checkPreTool: broken,
      });
      expect(code).toBe(0);
      expect(stdout).toBe(expected);
      expect(errors).toEqual([
        "selfhost hook: boom",
        "selfhost hook: the call was allowed without a check (fail open)",
      ]);
      expect(spoolLines(home.root).at(-1)?.guard).toMatchObject({
        answer: "allow",
        fail_open: true,
        failures: ["internal: boom"],
      });
    }
  });

  it("lets a call through when an extra checker fails or runs out of time, and records it", async () => {
    const { workspace, home } = setup();
    async function registry(): Promise<never> {
      throw new Error("registry unreachable");
    }
    async function slow() {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return [];
    }
    const errors: string[] = [];
    let stdout = "";
    await runHook(["claude"], {
      env: { HOME: home.root },
      readStdin: async () => JSON.stringify(push(workspace.root).payload).replace("--force", ""),
      writeOutput: (text) => {
        stdout += text;
      },
      writeError: (line) => errors.push(line),
      checkPreTool: (agent, payload, io) =>
        checkPreToolCall(agent, payload, io, { checkers: [registry, slow], budgetMs: 20 }),
    });
    expect(stdout).toBe("");
    expect(errors).toEqual([
      "selfhost hook: registry failed: registry unreachable; the call was not held up for it",
      "selfhost hook: slow timed out: no answer within 20 ms; the call was not held up for it",
    ]);
    expect(spoolLines(home.root).at(-1)?.guard).toMatchObject({
      answer: "allow",
      failures: ["registry failed: registry unreachable", "slow timed out: no answer within 20 ms"],
    });
  });

  it("blocks an install of a package the registry does not have, through the package guard", async () => {
    const { workspace, home } = setup();
    workspace.write("selfhost.toml", 'version = 1\n\n[packages]\nmode = "enforce"\n');
    const requested: string[] = [];
    const missing: typeof fetch = async (input) => {
      requested.push(String(input instanceof Request ? input.url : input));
      return new Response("not found", { status: 404 });
    };
    const payload = {
      session_id: "s",
      cwd: workspace.root,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm install react-hooks-form-validator-pro" },
    };
    let stdout = "";
    await runHook(["claude"], {
      env: { HOME: home.root },
      readStdin: async () => JSON.stringify(payload),
      writeOutput: (text) => {
        stdout += text;
      },
      writeError: () => {},
      checkPreTool: (agent, body, io) =>
        checkPreToolCall(agent, body, io, {
          checkers: [packageGuardChecker({ env: {}, home: home.root, fetch: missing })],
        }),
    });
    expect(answerOf("claude", stdout)).toBe("deny");
    expect(requested.length).toBeGreaterThan(0);
    expect(spoolLines(home.root).at(-1)?.guard).toMatchObject({
      answer: "deny",
      hits: expect.arrayContaining([
        expect.objectContaining({ rule_id: "packages.not_found", mode: "enforce" }),
      ]),
    });
  });

  it("skips the package guard for commands that name no package manager", async () => {
    let called = false;
    const checker = packageGuardChecker({
      env: {},
      fetch: async () => {
        called = true;
        return new Response("{}");
      },
    });
    const { validateConfig } = await import("@selfhost/schema");
    const result = validateConfig({ version: 1, packages: { mode: "enforce" } });
    if (!result.ok) throw new Error("invalid test policy");
    const signal = new AbortController().signal;
    expect(await checker({ tool: "Bash", command: "ls -la" }, result.config, { signal })).toEqual(
      [],
    );
    expect(called).toBe(false);
  });

  it("answers Cursor's prompt hook so a silent hook never blocks the prompt", async () => {
    const home = tempDir("guard-home");
    let stdout = "";
    await runHook(["cursor"], {
      env: { HOME: home.root },
      readStdin: async () =>
        JSON.stringify({ hook_event_name: "beforeSubmitPrompt", prompt: "hi" }),
      writeOutput: (text) => {
        stdout += text;
      },
      writeError: () => {},
    });
    expect(stdout).toBe('{"continue":true}');
  });

  it("never spools file contents or tool output", async () => {
    const { workspace, home } = setup();
    await hook(
      {
        agent: "cursor",
        event: "beforeReadFile",
        payload: {
          hook_event_name: "beforeReadFile",
          file_path: workspace.path("src/app.ts"),
          content: "the file's text",
          workspace_roots: [workspace.root],
        },
      },
      home.root,
    );
    const line = spoolLines(home.root).at(-1);
    expect(line?.payload).toMatchObject({ content: null });
    expect(line?.guard?.answer).toBe("allow");
  });
});

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttributionResult } from "../src/scan/attribution.js";

/** Writes synthetic Claude Code and Codex logs in the ~/.claude and ~/.codex layouts. */

const CWD = "/home/dev/acme-api";
const HOUR = 3_600_000;

export interface SessionSpec {
  vendor: "claude_code" | "codex";
  id: string;
  start: Date;
  requests: number;
  model?: string;
  prompt?: string;
  /** Tokens per request. */
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  /** Requests (by index) that follow an API error; Claude Code only. */
  retries?: number[];
  /** Run the same command this many times in a row, from the first request. */
  repeat?: number;
  /** Files edited, one per request after the repeats. */
  edits?: string[];
  commit?: boolean;
  /** Codex thread source, for background threads such as guardian reviews. */
  threadSource?: string;
}

export interface LogDirs {
  claudeDir: string;
  codexDir: string;
}

const pad = (n: number, width = 12) => n.toString(16).padStart(width, "0");

/** A UUID derived from a number, stable across runs. */
export function uuid(n: number, version: 4 | 7 = 4): string {
  const hex = pad(n, 12);
  return version === 7
    ? `01a2${hex.slice(0, 4)}-${hex.slice(4, 8)}-7${hex.slice(8, 11)}-8000-${pad(n * 7, 12)}`
    : `00000000-0000-4000-8000-${hex}`;
}

interface Step {
  name: string;
  input: Record<string, unknown>;
  output: string;
}

function steps(spec: SessionSpec): Step[] {
  const out: Step[] = [];
  const edits = spec.edits ?? [];
  for (let index = 0; index < spec.requests; index++) {
    const isLast = index === spec.requests - 1;
    if (isLast && spec.commit) {
      out.push({
        name: "Bash",
        input: { command: `git commit -am "Update ${index}"` },
        output: `[main ${pad(index + spec.requests * 977, 7).slice(0, 7)}] Update ${index}\n 1 file changed`,
      });
    } else if (index < (spec.repeat ?? 0)) {
      out.push({ name: "Bash", input: { command: "gh pr checks 42" }, output: "pending" });
    } else if (edits.length > 0 && index - (spec.repeat ?? 0) < edits.length) {
      const file = edits[index - (spec.repeat ?? 0)] as string;
      out.push({
        name: "Edit",
        input: { file_path: join(CWD, file), old_string: "a", new_string: "b" },
        output: "ok",
      });
    } else {
      out.push({
        name: "Read",
        input: { file_path: join(CWD, `src/file-${index}.ts`) },
        output: "x",
      });
    }
  }
  return out;
}

const iso = (ms: number) => new Date(ms).toISOString();

function claudeLines(spec: SessionSpec): string[] {
  const base = {
    sessionId: spec.id,
    cwd: CWD,
    version: "2.1.309",
    gitBranch: "main",
    userType: "external",
    isSidechain: false,
  };
  let t = spec.start.getTime();
  const lines: Record<string, unknown>[] = [
    {
      ...base,
      type: "user",
      uuid: `${spec.id.slice(0, 24)}${pad(0)}`,
      timestamp: iso(t),
      message: { role: "user", content: spec.prompt ?? "Fix the failing test." },
    },
  ];
  const tag = spec.id.slice(-8);
  steps(spec).forEach((step, index) => {
    t += 20_000;
    if (spec.retries?.includes(index)) {
      lines.push({ ...base, type: "system", subtype: "api_error", timestamp: iso(t - 5000) });
    }
    const toolId = `toolu_${tag}${pad(index, 6)}`;
    lines.push({
      ...base,
      type: "assistant",
      uuid: `${spec.id.slice(0, 24)}${pad(index * 2 + 1)}`,
      timestamp: iso(t),
      requestId: `req_${tag}${pad(index, 6)}`,
      message: {
        model: spec.model ?? "claude-opus-5-5",
        id: `msg_${tag}${pad(index, 6)}`,
        type: "message",
        role: "assistant",
        content: [{ type: "tool_use", id: toolId, name: step.name, input: step.input }],
        usage: {
          input_tokens: spec.input ?? 40,
          cache_creation_input_tokens: index === 0 ? 20_000 : (spec.cacheWrite ?? 800),
          cache_read_input_tokens: index === 0 ? 0 : (spec.cacheRead ?? 30_000),
          output_tokens: spec.output ?? 300,
        },
      },
    });
    lines.push({
      ...base,
      type: "user",
      uuid: `${spec.id.slice(0, 24)}${pad(index * 2 + 2)}`,
      timestamp: iso(t + 2000),
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolId, content: step.output }],
      },
      toolUseResult: { stdout: step.output, stderr: "" },
    });
  });
  return lines.map((line) => JSON.stringify(line));
}

function codexLines(spec: SessionSpec): string[] {
  let t = spec.start.getTime();
  const turn = `${spec.id.slice(0, 18)}0000-${spec.id.slice(-12)}`;
  const lines: Record<string, unknown>[] = [
    {
      timestamp: iso(t),
      type: "session_meta",
      payload: {
        id: spec.id,
        session_id: spec.id,
        timestamp: iso(t),
        cwd: CWD,
        originator: "Codex Desktop",
        cli_version: "0.142.5",
        source: "vscode",
        thread_source: spec.threadSource ?? "user",
        model_provider: "openai",
      },
    },
    {
      timestamp: iso(t + 10),
      type: "turn_context",
      payload: { turn_id: turn, cwd: CWD, model: spec.model ?? "gpt-5.5" },
    },
    {
      timestamp: iso(t + 20),
      type: "event_msg",
      payload: { type: "user_message", message: spec.prompt ?? "Fix the failing test." },
    },
  ];
  const total = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const tag = spec.id.slice(-8);
  steps(spec).forEach((step, index) => {
    t += 15_000;
    const callId = `call_${tag}${pad(index, 6)}`;
    const cached = index === 0 ? 0 : (spec.cacheRead ?? 30_000);
    const input = cached + (spec.input ?? 2000);
    const last = {
      input_tokens: input,
      cached_input_tokens: cached,
      output_tokens: spec.output ?? 300,
      reasoning_output_tokens: 0,
      total_tokens: input + (spec.output ?? 300),
    };
    total.input_tokens += last.input_tokens;
    total.cached_input_tokens += last.cached_input_tokens;
    total.output_tokens += last.output_tokens;
    total.total_tokens += last.total_tokens;
    if (step.name === "Edit") {
      const file = String(step.input.file_path).slice(CWD.length + 1);
      lines.push({
        timestamp: iso(t),
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: callId,
          name: "apply_patch",
          input: `*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch`,
        },
      });
      lines.push({
        timestamp: iso(t + 100),
        type: "response_item",
        payload: { type: "custom_tool_call_output", call_id: callId, output: "Exit code: 0" },
      });
    } else {
      const cmd =
        step.name === "Bash" ? String(step.input.command) : `cat ${String(step.input.file_path)}`;
      lines.push({
        timestamp: iso(t),
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({ cmd, workdir: CWD }),
          call_id: callId,
        },
      });
      lines.push({
        timestamp: iso(t + 100),
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: callId,
          output: `Process exited with code 0\nOutput:\n${step.output}\n`,
        },
      });
    }
    lines.push({
      timestamp: iso(t + 200),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { ...total, reasoning_output_tokens: 0 },
          last_token_usage: last,
        },
      },
    });
  });
  return lines.map((line) => JSON.stringify(line));
}

export function writeSessions(root: string, specs: SessionSpec[]): LogDirs {
  const dirs = { claudeDir: join(root, "claude"), codexDir: join(root, "codex") };
  for (const spec of specs) {
    if (spec.vendor === "claude_code") {
      const dir = join(dirs.claudeDir, "projects", "-home-dev-acme-api");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${spec.id}.jsonl`), `${claudeLines(spec).join("\n")}\n`);
    } else {
      const day = spec.start.toISOString().slice(0, 10);
      const dir = join(dirs.codexDir, "sessions", ...day.split("-"));
      mkdirSync(dir, { recursive: true });
      const stamp = spec.start.toISOString().slice(0, 19).replaceAll(":", "-");
      writeFileSync(
        join(dir, `rollout-${stamp}-${spec.id}.jsonl`),
        `${codexLines(spec).join("\n")}\n`,
      );
    }
  }
  return dirs;
}

/** About 50 sessions over the 30 days before `now`, Claude Code and Codex, some with commits. */
export function monthOfSessions(now: Date, count = 50): SessionSpec[] {
  return Array.from({ length: count }, (_, n): SessionSpec => {
    const vendor = n % 4 === 3 ? "codex" : "claude_code";
    return {
      vendor,
      id: uuid(1000 + n, vendor === "codex" ? 7 : 4),
      start: new Date(now.getTime() - (count - n) * 14 * HOUR),
      requests: 60 + ((n * 37) % 140),
      edits: [`src/module-${n % 9}.ts`, `test/module-${n % 9}.test.ts`],
      commit: n % 3 !== 0,
    };
  });
}

/** One session per leak rule, plus a clean one. */
export function leakySessions(start: Date): SessionSpec[] {
  const at = (hours: number) => new Date(start.getTime() + hours * HOUR);
  return [
    { vendor: "claude_code", id: uuid(1), start: at(0), requests: 12, commit: true },
    { vendor: "claude_code", id: uuid(2), start: at(2), requests: 10, repeat: 8 },
    {
      vendor: "claude_code",
      id: uuid(3),
      start: at(4),
      requests: 8,
      cacheRead: 2000,
      input: 30_000,
    },
    { vendor: "claude_code", id: uuid(4), start: at(6), requests: 8, retries: [2, 3, 5] },
    { vendor: "claude_code", id: uuid(5), start: at(8), requests: 6, cacheRead: 180_000 },
    {
      vendor: "codex",
      id: uuid(6, 7),
      start: at(10),
      requests: 12,
      threadSource: "guardian_review",
      model: "gpt-5.5",
    },
  ];
}

/** An attribution result as packages/attribution would return it for these sessions. */
export function attributionFor(sessionsWithoutCommits: string[]): AttributionResult {
  return {
    repo: "acme/api",
    commits: [
      {
        sha: "a1b2c3d",
        agent: { vendor: "claude_code" },
        signal: "trailer",
        additions: 40,
        deletions: 2,
      },
      {
        sha: "b2c3d4e",
        agent: { vendor: "claude_code" },
        signal: "session",
        additions: 12,
        deletions: 0,
      },
      { sha: "c3d4e5f", agent: { vendor: "codex" }, signal: "files", additions: 8, deletions: 8 },
      { sha: "d4e5f6a", additions: 3, deletions: 1 },
    ],
    pulls: [
      {
        number: 41,
        url: "https://github.com/acme/api/pull/41",
        agent: { vendor: "claude_code" },
        unreviewedMerge: true,
        additions: 52,
        deletions: 2,
      },
      {
        number: 42,
        url: "https://github.com/acme/api/pull/42",
        agent: { vendor: "codex" },
        unreviewedMerge: false,
        additions: 8,
        deletions: 8,
      },
      {
        number: 43,
        url: "https://github.com/acme/api/pull/43",
        unreviewedMerge: false,
        additions: 3,
        deletions: 1,
      },
    ],
    stats: {
      byAgent: [
        {
          agent: { vendor: "claude_code" },
          commits: 2,
          commitShare: 0.5,
          prs: 1,
          merged: 1,
          closed: 0,
          mergedRate: 1,
          medianHoursToMerge: 3,
          reviewCommentsPerPr: 0,
          unreviewedMerges: 1,
        },
        {
          agent: { vendor: "codex" },
          commits: 1,
          commitShare: 0.25,
          prs: 1,
          merged: 1,
          closed: 0,
          mergedRate: 1,
          medianHoursToMerge: 20,
          reviewCommentsPerPr: 2,
          unreviewedMerges: 0,
        },
        {
          agent: "unattributed",
          commits: 1,
          commitShare: 0.25,
          prs: 1,
          merged: 1,
          closed: 0,
          mergedRate: 1,
          reviewCommentsPerPr: 1,
          unreviewedMerges: 0,
        },
      ],
    },
    sessionsWithoutCommits,
  };
}

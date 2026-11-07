import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stableEventId } from "@selfhost/ledger";
import {
  EVENT_SCHEMA,
  type LedgerEvent,
  parseConfig,
  type ResolvedSelfhostConfig,
} from "@selfhost/schema";
import type { RiskInputs, RiskLevel } from "../src/index.js";

export const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");
export const RISK_FIXTURES = join(FIXTURES, "risk");
export const GITHUB_FIXTURES = join(FIXTURES, "github");

export function config(text: string): ResolvedSelfhostConfig {
  const result = parseConfig(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.config;
}

export const FIXTURE_TOML = readFileSync(join(RISK_FIXTURES, "selfhost.toml"), "utf8");

export interface RiskCase {
  name: string;
  criterion: number;
  description: string;
  inputs: RiskInputs;
  expect: { level: RiskLevel; score: number; missing: string[] };
}

export const CASES = JSON.parse(readFileSync(join(RISK_FIXTURES, "cases.json"), "utf8")) as {
  cases: RiskCase[];
  ordering: [string, string][];
};

/** Keeps git hermetic: no global or system config, so signing or hooks on this machine stay out. */
function isolateGit() {
  process.env.GIT_CONFIG_GLOBAL = devNull;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
}

/** A git repository in a temp dir, built commit by commit with fixed authors and dates. */
export class TempRepo {
  readonly dir = mkdtempSync(join(tmpdir(), "selfhost-risk-"));

  constructor() {
    isolateGit();
    this.git("init", "-q", "-b", "main");
  }

  git(...args: string[]): string {
    return execFileSync("git", ["-C", this.dir, ...args], { encoding: "utf8" }).trim();
  }

  commit(input: {
    message: string;
    at: string;
    files?: Record<string, string>;
    email?: string;
  }): string {
    for (const [path, content] of Object.entries(input.files ?? {})) {
      const full = join(this.dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      this.git("add", path);
    }
    const email = input.email ?? "alice@example.com";
    execFileSync("git", ["-C", this.dir, "commit", "-q", "--allow-empty", "-F", "-"], {
      input: input.message,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Alice Example",
        GIT_AUTHOR_EMAIL: email,
        GIT_AUTHOR_DATE: input.at,
        GIT_COMMITTER_NAME: "Alice Example",
        GIT_COMMITTER_EMAIL: email,
        GIT_COMMITTER_DATE: input.at,
      },
    });
    return this.git("rev-parse", "HEAD");
  }

  /** `git revert` of a commit, at a fixed time. */
  revert(sha: string, at: string): string {
    execFileSync("git", ["-C", this.dir, "revert", "--no-edit", sha], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Bob Example",
        GIT_AUTHOR_EMAIL: "bob@example.com",
        GIT_AUTHOR_DATE: at,
        GIT_COMMITTER_NAME: "Bob Example",
        GIT_COMMITTER_EMAIL: "bob@example.com",
        GIT_COMMITTER_DATE: at,
      },
      stdio: "ignore",
    });
    return this.git("rev-parse", "HEAD");
  }

  remove() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export const lines = (n: number, prefix = "line") =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join("");

export const CLAUDE_SONNET = "Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>";

let counter = 0;

function base(kind: LedgerEvent["kind"], session: string, ts: string): LedgerEvent {
  counter += 1;
  return {
    id: stableEventId(ts, `test:${kind}:${session}:${counter}`),
    schema: EVENT_SCHEMA,
    ts,
    source: "hook",
    kind,
    actor: { kind: "agent", id: `claude_code:session:${session}` },
    agent: { vendor: "claude_code" },
    model: "claude-sonnet-4-5",
    session_id: session,
  };
}

export function sessionStarted(session: string, ts: string, cwd: string): LedgerEvent {
  return { ...base("session.started", session, ts), data: { cwd } };
}

export function toolCalled(
  session: string,
  ts: string,
  tool: string,
  target: LedgerEvent["target"],
): LedgerEvent {
  return {
    ...base("tool.called", session, ts),
    tool: { name: tool, ...(target ? { input_summary: target.value } : {}) },
    ...(target ? { target } : {}),
  };
}

export function commitCreated(session: string, ts: string, sha: string): LedgerEvent {
  return {
    ...base("commit.created", session, ts),
    tool: { name: "Bash", input_summary: "git commit" },
    links: { commit_sha: sha },
  };
}

export function policyEvaluated(
  session: string,
  ts: string,
  toolEvent: LedgerEvent,
  decision: { rule_id: string; verdict: "block" | "ask"; mode: "observe" | "enforce" },
  irreversible = false,
): LedgerEvent {
  return {
    ...base("policy.evaluated", session, ts),
    source: "cli",
    actor: { kind: "system", id: "selfhost-policy" },
    decision: { ...decision, by: "selfhost-policy" },
    data: { tool_event_id: toolEvent.id, ...(irreversible ? { irreversible: true } : {}) },
  };
}

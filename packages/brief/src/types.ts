import type { AgentRef } from "@selfhost/attribution";
import type { ChangedFile, FileStatus, NewDependency } from "@selfhost/pr";
import type { LedgerEvent, TracerTool } from "@selfhost/schema";

export const BRIEF_SCHEMA = "selfhost.review_brief/v1";

/**
 * The first line of every brief comment. The GitHub delivery finds the comment it posted before
 * by this marker and edits it in place instead of posting another.
 */
export const BRIEF_MARKER = "<!-- selfhost:brief v1 -->";

/** The sections of a brief, in the order the comment shows them. Every one is always present. */
export const BRIEF_SECTIONS = [
  "task",
  "plan",
  "risky_lines",
  "files",
  "commands",
  "tests",
  "blocked",
  "cost",
  "trace",
] as const;

export type BriefSection = (typeof BRIEF_SECTIONS)[number];

export interface BriefTarget {
  /** owner/name on GitHub, when known. */
  repo?: string;
  pr?: { number: number; url: string };
  base: string;
  head: string;
  /** Commit SHAs in the change, oldest first. */
  commits: string[];
}

/** Everything `buildBrief` reads. `gatherBrief` reads it from git, gh and the ledger. */
export interface BriefInputs {
  target: BriefTarget;
  /** The pull request's title and description. */
  pull?: { title: string; body?: string };
  /** Commit subjects, oldest first; the task's title when there is no pull request. */
  subjects?: string[];
  agent?: AgentRef;
  files: ChangedFile[];
  /** New dependencies. Undefined when a manifest could not be read. */
  dependencies?: NewDependency[];
  /** Why the manifests could not be read. */
  dependenciesMissing?: string;
  /** The agent sessions behind the change and every event they recorded, oldest first. */
  run?: { sessions: string[]; events: LedgerEvent[] };
  /** Why there is no run. */
  runMissing?: string;
  /** `[review] high_risk_paths` from selfhost.toml. */
  highRiskPaths: string[];
  /** The team server's base URL. Trace links open each run in its console when set. */
  server?: string;
  /** `[integrations.tracer]`: with a run_url, each run also links to the team's tracer. */
  tracer?: BriefTracer;
}

export interface BriefTracer {
  tool: TracerTool;
  run_url?: string;
}

export interface BriefTask {
  title?: string;
  /** Where the title came from. */
  titleFrom?: "pull_request" | "commit";
  /** The description's first paragraph. */
  description?: string;
  /** The run's first prompt, only when prompts were stored. */
  prompt?: string;
}

export interface PlanUpdate {
  tool: string;
  session: string;
  ts: string;
  /** The stored input summary, when there is one. */
  summary?: string;
}

export interface BriefPlan {
  /** Steps listed under a Plan heading in the description. */
  steps: string[];
  /** Plan tool calls in the run (TodoWrite, update_plan, ExitPlanMode). */
  updates: PlanUpdate[];
}

export type RiskyKind =
  | "protected_path"
  | "new_dependency"
  | "deleted_test_file"
  | "deleted_test"
  | "skipped_test";

/** A line a reviewer should look at, with a link to it in the diff. */
export interface RiskyLine {
  kind: RiskyKind;
  path: string;
  /** Absent when only the file is known. */
  line?: number;
  /** The side of the diff: old for a deleted line or file, new otherwise. */
  side: "new" | "old";
  /** The glob, the dependency name, the skip marker or the removed test. */
  detail: string;
  url?: string;
}

export interface BriefFile {
  path: string;
  previousPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** Under `[review] high_risk_paths`. */
  protected: boolean;
  url?: string;
}

/**
 * passed or failed from the recorded result; unknown when the result has no outcome; no_result
 * when none was recorded.
 */
export type CommandResult = "passed" | "failed" | "unknown" | "no_result";

export interface BriefCommand {
  /** The stored command: its first line, secrets masked, at most 120 characters. */
  command: string;
  tool: string;
  session: string;
  ts: string;
  result: CommandResult;
  /** The recorded error, for a failed command. */
  error?: string;
  /** Runs a test runner. */
  test: boolean;
}

export interface BriefBlock {
  rule_id: string;
  verdict: "block" | "ask";
  /** enforce: hooks stopped the call; observe: the rule would have. */
  mode: "observe" | "enforce";
  irreversible: boolean;
  tool?: string;
  /** The command, file or URL the rule matched. */
  target?: string;
  /** The rule's message. */
  reason?: string;
  session?: string;
  ts: string;
}

export interface BriefCost {
  usd: number;
  /** How much of it was computed from token counts and a price table, not reported by the vendor. */
  estimated: "none" | "some" | "all";
  /** Model requests. */
  requests: number;
  tokens: number;
  sessions: number;
  models: string[];
}

export interface BriefTraceSession {
  id: string;
  agent?: string;
  start: string;
  end: string;
  events: number;
  /** The run in the team server's console (`<server>/runs/<id>`). */
  url?: string;
  /** The run in the team's tracer, from `[integrations.tracer] run_url`. */
  tracerUrl?: string;
  /** Which tracer tracerUrl opens. */
  tracer?: TracerTool;
  /** The local command that prints them, when there is no team server. */
  command?: string;
}

export interface Brief {
  schema: typeof BRIEF_SCHEMA;
  target: BriefTarget;
  agent?: AgentRef;
  task: BriefTask;
  plan: BriefPlan;
  risky: RiskyLine[];
  files: BriefFile[];
  commands: BriefCommand[];
  /** The commands that ran tests, with their results. */
  tests: BriefCommand[];
  blocked: BriefBlock[];
  cost?: BriefCost;
  trace: BriefTraceSession[];
  /**
   * What each section could not show. Every empty section has at least one note saying why;
   * a section with data can carry notes on what was not checked.
   */
  notes: Partial<Record<BriefSection, string[]>>;
}

import type { AgentRef } from "@selfhost/attribution";
import type { ToolCall } from "@selfhost/policy";

export type RiskLevel = "low" | "medium" | "high";

/** The inputs a risk level is built from, in the order the check result lists them. */
export const RISK_INPUTS = [
  "irreversible_rules",
  "outside_effects",
  "protected_paths",
  "size",
  "dependencies",
  "tests",
  "guardrails",
  "reverts",
] as const;

export type RiskInput = (typeof RISK_INPUTS)[number];

export interface ChangedFile {
  /** Path relative to the repository root with `/` separators; the new path of a rename. */
  path: string;
  /** The old path of a rename. */
  previousPath?: string;
  additions: number;
  deletions: number;
}

export interface NewDependency {
  /** The manifest that added it, relative to the repository root. */
  manifest: string;
  name: string;
}

/** What the sandbox reported: tests passed, failed, or did not run. */
export type TestStatus = "passed" | "failed" | "not_run";

/** A `policy.evaluated` event recorded for one of the run's tool calls. */
export interface GuardrailHit {
  rule_id: string;
  verdict: "block" | "ask";
  /** observe: the rule would have blocked; enforce: hooks blocked it. */
  mode: "observe" | "enforce";
  /** An irreversible rule fired on a command, URL or tool (not on a file path). */
  irreversible: boolean;
}

/** The agent sessions that produced the pull request, from the ledger. */
export interface RunInput {
  /** Session ids, sorted. */
  sessions: string[];
  toolCalls: ToolCall[];
  guardrails: GuardrailHit[];
}

/** Commits by the pull request's agent and model on this repository, and how many were reverted. */
export interface RevertHistory {
  agent: AgentRef;
  commits: number;
  reverted: number;
  /** The window the commits were read from. */
  days: number;
}

/**
 * Everything `scoreRisk` reads besides selfhost.toml. An input left undefined is missing: the
 * score uses the rest and the result names it, with the reason from `unavailable` when given.
 */
export interface RiskInputs {
  files: ChangedFile[];
  dependencies?: NewDependency[];
  tests?: TestStatus;
  run?: RunInput;
  reverts?: RevertHistory;
  /** The agent and model the pull request is attributed to. */
  agent?: AgentRef;
  /** Why an input is missing, for the check result. */
  unavailable?: Partial<Record<RiskInput, string>>;
}

/** One input's part in the score. */
export interface RiskFactor {
  input: RiskInput;
  /** Points added to the score. */
  points: number;
  /** true when this input alone makes the level high. */
  forcesHigh: boolean;
  /** One line for the check result. */
  detail: string;
}

export interface MissingInput {
  input: RiskInput;
  reason: string;
}

export interface RiskResult {
  level: RiskLevel;
  /** 0 to 100. Irreversible changes and outside effects score 90 or more; nothing else does. */
  score: number;
  /** The factors that raised the score or forced the level, most important first. */
  reasons: string[];
  /** Inputs the score could not use. */
  missing: MissingInput[];
  /** Every input that was present, in RISK_INPUTS order, including those that added nothing. */
  factors: RiskFactor[];
}

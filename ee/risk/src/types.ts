import type { AgentRef } from "@selfhost/attribution";
import type { ToolCall } from "@selfhost/policy";
import type { ChangedFile, GuardrailHit, NewDependency } from "@selfhost/pr";
import type { FindingSeverity, ReviewerTool, SecondOpinionVerdict } from "@selfhost/schema";

export type { ChangedFile, GuardrailHit, NewDependency };

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
  "module_reverts",
  "second_opinion",
] as const;

export type RiskInput = (typeof RISK_INPUTS)[number];

/** What the sandbox reported: tests passed, failed, or did not run. */
export type TestStatus = "passed" | "failed" | "not_run";

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

/** One module the change touches, with how its agent-written lines fared after merge. */
export interface ModuleRevertRate {
  module: string;
  /** Agent-written lines merged into the module in the look-back window. */
  agentLines: number;
  /** Share of them reverted or reworked within [review] revert_window_days; null with none. */
  rate: number | null;
}

/** Revert and rework rates of the modules the change touches, from `@selfhost/provenance`. */
export interface ModuleReverts {
  /** Days of merges the rates were read from. */
  days: number;
  /** Every module the change touches, by name. */
  modules: ModuleRevertRate[];
}

/** What the team's AI reviewer said about the pull request: the newest review from one tool. */
export interface SecondOpinionInput {
  tool: ReviewerTool;
  verdict: SecondOpinionVerdict;
  findings?: number;
  severity?: FindingSeverity;
  /** The commit it reviewed, when known; the check notes a review of an earlier commit. */
  head_sha?: string;
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
  modules?: ModuleReverts;
  /**
   * The newest review from each AI reviewer ([integrations.reviewer]) on the pull request. Left
   * undefined with no reason in `unavailable`, the input is not part of the score and not listed
   * as missing: a team without a reviewer has nothing missing.
   */
  secondOpinions?: SecondOpinionInput[];
  /** The pull request's head commit, to tell a review of an earlier commit. */
  headSha?: string;
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

import type { AgentRef, CommitRecord } from "@selfhost/attribution";
import type { ToolCall } from "@selfhost/policy";
import type { LedgerEvent } from "@selfhost/schema";

/** How the change treats a file, as GitHub names it. */
export type FileStatus = "added" | "removed" | "modified" | "renamed";

/** One line a hunk added or removed. */
export interface DiffLine {
  /** Line number: on the new side for an added line, on the old side for a removed one. */
  line: number;
  text: string;
}

/** One `@@` block of a unified diff, with its changed lines. Context lines are left out. */
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  removed: DiffLine[];
  added: DiffLine[];
}

export interface ChangedFile {
  /** Path relative to the repository root with `/` separators; the new path of a rename. */
  path: string;
  /** The old path of a rename. */
  previousPath?: string;
  additions: number;
  deletions: number;
  status?: FileStatus;
  /**
   * The file's hunks, empty for a pure rename or mode change. Undefined when the diff has no
   * text for it: a binary file, or a patch too large for GitHub to return.
   */
  hunks?: Hunk[];
}

export interface NewDependency {
  /** The manifest that added it, relative to the repository root. */
  manifest: string;
  name: string;
}

/** A `policy.evaluated` event with a block or ask verdict on one of the run's tool calls. */
export interface GuardrailHit {
  rule_id: string;
  verdict: "block" | "ask";
  /** observe: the rule would have blocked; enforce: hooks blocked it. */
  mode: "observe" | "enforce";
  /** An irreversible rule fired on a command, URL or tool (not on a file path). */
  irreversible: boolean;
}

/** A guardrail hit with the event it was read from. */
export interface RunGuardrail extends GuardrailHit {
  event: LedgerEvent;
}

/** The agent sessions behind a change, read from the ledger. */
export interface Run {
  /** Session ids, sorted. */
  sessions: string[];
  /** Every event of those sessions, oldest first (by time, then id). */
  events: LedgerEvent[];
  /** The tool calls, in the terms rules match on, oldest first within each session. */
  toolCalls: ToolCall[];
  /** Block and ask verdicts, once per tool call and rule. */
  guardrails: RunGuardrail[];
}

/** A pull request on GitHub, read with gh, or local commits from the merge base of `base`. */
export type ChangeTarget = { pr: number } | { base: string; head?: string };

/** What was read. */
export interface ChangeRef {
  /** The repository root. Absent for a pull request read from GitHub's API alone. */
  root?: string;
  pr?: { repo: string; number: number; url: string };
  base: string;
  head: string;
  /** Commit SHAs in the change, oldest first. */
  commits: string[];
}

/** A manifest's text before and after the change; absent before when added, after when deleted. */
export interface ManifestChange {
  path: string;
  before?: string;
  after?: string;
}

export interface Change {
  target: ChangeRef;
  /** owner/name on GitHub: the pull request's repository, else the origin remote when on GitHub. */
  repo?: string;
  /** The pull request's title and description. */
  pull?: { title: string; body?: string };
  /** Commit subjects, oldest first. */
  subjects: string[];
  files: ChangedFile[];
  manifests: ManifestChange[];
  /** Why a manifest could not be read, when one could not. */
  manifestProblem?: string;
  /** Local commits read for attribution, from `since` or a day before the change. */
  history: CommitRecord[];
  /** The change's own commits among them. */
  matched: CommitRecord[];
  /** The agent and model the change is attributed to. */
  agent?: AgentRef;
  run?: Run;
  /** Why there is no run, when the reason is known. */
  runMissing?: string;
}

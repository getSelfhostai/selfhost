import type { ProvenanceReport } from "@selfhost/schema";

/**
 * The scan's side of the git and GitHub join. `packages/attribution` builds the result; these
 * types are the port it fills, so the scan works and is tested before that package lands.
 */

export type AgentVendor =
  | "claude_code"
  | "codex"
  | "opencode"
  | "goose"
  | "cursor"
  | "copilot"
  | "other";

export interface AgentRef {
  vendor: AgentVendor;
  model?: string;
}

/** What the join needs from one local session to match it to commits. */
export interface SessionHint {
  sessionId: string;
  vendor: AgentVendor;
  /** The model that answered most of the session's main requests. */
  model?: string;
  /** First and last event of the session, ISO 8601 UTC. */
  start: string;
  end: string;
  cwd?: string;
  /** Files the session wrote or patched, as the logs name them (relative to cwd when inside it). */
  files: string[];
}

export interface AgentStats {
  agent: AgentRef | "unattributed";
  commits: number;
  /** Share of the repository's commits in the window, 0 to 1. */
  commitShare: number;
  prs: number;
  merged: number;
  closed: number;
  mergedRate: number;
  medianHoursToMerge?: number;
  reviewCommentsPerPr: number;
  unreviewedMerges: number;
}

export interface AttributionResult {
  /** owner/name when the repository has a GitHub remote. */
  repo?: string;
  commits: {
    sha: string;
    agent?: AgentRef;
    signal?: string;
    /** The session the commit came from, when the join named one. */
    sessionId?: string;
    additions: number;
    deletions: number;
  }[];
  pulls: {
    number: number;
    url: string;
    agent?: AgentRef;
    unreviewedMerge: boolean;
    additions: number;
    deletions: number;
    state?: "open" | "merged" | "closed";
    mergedAt?: string;
    closedAt?: string;
    /** SHAs of the pull request's commits. */
    commits?: string[];
  }[];
  /** Ids of the sessions given that ran in the repository. */
  sessions?: string[];
  stats: { byAgent: AgentStats[] };
  /** Ids of the sessions given that produced no commit. */
  sessionsWithoutCommits: string[];
  /** Lines merged to the main branch by agent and module, with revert and rework rates. */
  provenance?: ProvenanceReport;
}

/**
 * Joins local sessions with the git history and pull requests of the repository at `repoDir`;
 * `window` is the scan's, for the merged lines.
 */
export type CollectAttribution = (
  repoDir: string,
  sessions: SessionHint[],
  window?: { since: Date; until: Date },
) => Promise<AttributionResult | undefined>;

/** No join yet: the scan says the git numbers need a repository. */
export const noAttribution: CollectAttribution = async () => undefined;

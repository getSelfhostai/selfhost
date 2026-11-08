import type { AgentRef } from "@selfhost/attribution";

/** A file a mainline commit changed, against its first parent. */
export interface FileChange {
  /** Repository path with `/` separators; the new path of a rename. */
  path: string;
  /** The old path of a rename. */
  previousPath?: string;
  additions: number;
  deletions: number;
  /** No line counts: git saw a binary file. */
  binary: boolean;
}

/** A commit on the main branch's first-parent line, as `git log --first-parent` reads it. */
export interface MainlineCommit {
  sha: string;
  parents: string[];
  /** When it landed on the main branch: the committer date, ISO 8601 UTC. */
  committedAt: string;
  committerEmail: string;
  authorEmail: string;
  subject: string;
  /** The full message. */
  message: string;
  /** Changes against the first parent (for a merge, what the merge brought in). */
  files: FileChange[];
}

/**
 * Commits that reached the main branch together: one merge, one squash or direct commit, or the
 * commits of a rebase merge (consecutive first-parent commits with the same committer and time).
 */
export interface Landing {
  /** Mainline commits, oldest first. */
  commits: MainlineCommit[];
  /** First parent of the first commit; undefined for the root commit. */
  bottom?: string;
  /** Committer date of the last commit. */
  mergedAt: string;
  /** Pull request number from the merge or squash message, when it names one. */
  pr?: number;
}

/** One blamed line: the commit, path and line number that introduced it. */
export interface BlameLine {
  origin: string;
  /** Path in the origin commit. */
  path: string;
  line: number;
  /** The line holds only whitespace. */
  blank: boolean;
}

/** A line that landed: where it came from, and where it sits in the landing. */
export interface LandedLine {
  /** `${origin}:${path}:${line}`, the same key blame gives it while it is unchanged. */
  key: string;
  origin: string;
  /** Path at the landing. */
  path: string;
  module: string;
}

/** What happened to a landed line within the window. */
export type LineFate = "kept" | "reworked" | "reverted";

/** A landed line with its fate. */
export interface TrackedLine extends LandedLine {
  fate: LineFate;
  /** The mainline commit that changed or removed it. */
  by?: string;
}

/** A landing with every line it brought and what became of each. */
export interface TrackedLanding {
  landing: Landing;
  lines: TrackedLine[];
  /** The window after the merge had not ended by `until`, so more could still change. */
  open: boolean;
  /** Mainline commits that reverted this landing within the window. */
  revertedBy: string[];
}

/** Who wrote a commit, as far as the evidence says. */
export interface CommitAuthor {
  agent?: AgentRef;
  /** The person: git author email, lower case. */
  person: string;
  /** Ledger session behind the commit. */
  sessionId?: string;
  /** What tied it to the agent. */
  signal?: string;
}

/** A commit an agent session recorded in the ledger (commit.created with a session). */
export interface RunCommit {
  /** Full or abbreviated SHA, as the session saw it. */
  sha: string;
  agent: AgentRef;
  sessionId: string;
}

/** A merged pull request and the agent behind it, from GitHub or the ledger's pr.merged events. */
export interface MergedPull {
  number: number;
  agent?: AgentRef;
  /** GitHub login or person id. */
  person?: string;
  additions?: number;
  mergedAt?: string;
}

/** How code is grouped and judged; from `[review]` in selfhost.toml. */
export interface ProvenanceSettings {
  /** Module name to path globs; the first match wins. */
  modules: Record<string, string[]>;
  /** Leading folders that name a module when no glob matches. */
  moduleDepth: number;
  /** Days after a merge in which changes count. */
  windowDays: number;
  /** revert plus rework rate above which a module is flagged, 0 to 1. */
  threshold: number;
}

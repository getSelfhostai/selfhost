/**
 * Evidence that tied a commit or pull request to an agent, strongest first. `file_time_match` is
 * the weakest: it rests on a session editing the same files shortly before the commit.
 */
export type Signal =
  | "co_author_trailer"
  | "session_id"
  | "bot_account"
  | "branch_prefix"
  | "file_time_match";

/** The ledger's vendor list (`AGENT_VENDORS` in `@selfhost/schema`); a test keeps them equal. */
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

/** A local agent session, as the importers see it: when it ran, where, and what it edited. */
export interface SessionHint {
  sessionId: string;
  vendor: AgentVendor;
  model?: string;
  /** ISO 8601. */
  start: string;
  /** ISO 8601. */
  end: string;
  /** Working directory; required for a file and time match. */
  cwd?: string;
  /** Files the session edited, absolute or relative to `cwd`. */
  files: string[];
}

export interface CommitRecord {
  sha: string;
  /** ISO 8601 UTC. */
  authoredAt: string;
  authorEmail: string;
  subject: string;
  /** Paths relative to the repository root, new path for renames. */
  files: string[];
  additions: number;
  deletions: number;
  agent?: AgentRef;
  signal?: Signal;
  sessionId?: string;
}

export interface PullRecord {
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
  createdAt: string;
  mergedAt?: string;
  closedAt?: string;
  /** GitHub login of the account that opened it. */
  author: string;
  headRef: string;
  additions: number;
  deletions: number;
  /** SHAs of the commits on the pull request. */
  commits: string[];
  /** People (not bots) whose latest review before the merge approves it. */
  approvals: number;
  /** Inline review comments from people (not bots). */
  reviewComments: number;
  /** Conversation comments, as GitHub counts them (bots included). */
  issueComments: number;
  agent?: AgentRef;
  signal?: Signal;
  /**
   * Merged with no approval from a person, or approved with no review comments on a diff larger
   * than `largeDiffLines`.
   */
  unreviewedMerge: boolean;
}

/** GitHub account as the REST API returns it on pulls, reviews, comments and commits. */
export interface GitHubUser {
  login: string;
  /** "User", "Bot" or "Organization". */
  type?: string;
}

/** A pull request from `GET /repos/{owner}/{repo}/pulls` or `.../pulls/{number}`. */
export interface GitHubPull {
  number: number;
  html_url: string;
  state: "open" | "closed";
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  user: GitHubUser | null;
  head: { ref: string };
  body: string | null;
  /** Only on the single pull request endpoint. */
  additions?: number;
  deletions?: number;
  comments?: number;
}

/** From `GET /repos/{owner}/{repo}/pulls/{number}/reviews`. */
export interface GitHubReview {
  id: number;
  user: GitHubUser | null;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  submitted_at?: string | null;
  body?: string | null;
}

/** From `GET /repos/{owner}/{repo}/pulls/{number}/comments`. */
export interface GitHubReviewComment {
  id: number;
  user: GitHubUser | null;
  created_at: string;
}

/** From `GET /repos/{owner}/{repo}/pulls/{number}/commits`. */
export interface GitHubCommit {
  sha: string;
  commit: { message: string; author: { name?: string; email?: string; date?: string } | null };
  /** The GitHub account the author email belongs to, when GitHub knows it. */
  author: GitHubUser | null;
}

/**
 * Identifies a pull request at a point in time. `updatedAt` changes with every push, review and
 * comment, so a source can cache per-PR responses under it.
 */
export interface PullRef {
  number: number;
  updatedAt: string;
}

/**
 * Where pull request data comes from. `ghCliSource` uses the developer's own `gh` login; a GitHub
 * App source can implement the same methods with an installation token.
 */
export interface GitHubSource {
  /** Pull requests in any state updated at or after `since`, newest update first. */
  pulls(repo: string, since: Date): Promise<GitHubPull[]>;
  /** The full pull request, with `additions`, `deletions` and `comments`. */
  pull(repo: string, ref: PullRef): Promise<GitHubPull>;
  reviews(repo: string, ref: PullRef): Promise<GitHubReview[]>;
  reviewComments(repo: string, ref: PullRef): Promise<GitHubReviewComment[]>;
  commits(repo: string, ref: PullRef): Promise<GitHubCommit[]>;
}

export interface AgentStats {
  agent: AgentRef | "unattributed";
  commits: number;
  /** This group's commits over all commits, 0 to 1. */
  commitShare: number;
  prs: number;
  merged: number;
  /** Closed without merging. */
  closed: number;
  /** merged / (merged + closed); open pull requests are left out. 0 when none were decided. */
  mergedRate: number;
  medianHoursToMerge?: number;
  reviewCommentsPerPr: number;
  unreviewedMerges: number;
}

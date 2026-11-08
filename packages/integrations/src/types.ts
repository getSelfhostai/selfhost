import type { IntegrationKind, IntegrationStatus, Integrations } from "@selfhost/schema";

/** Environment variables where selfhost runs: the server's, or the laptop's in solo mode. */
export type Env = Readonly<Record<string, string | undefined>>;

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** One `[integrations.<kind>]` table without `tool`. */
export type Settings<K extends IntegrationKind> = Omit<NonNullable<Integrations[K]>, "tool">;

export interface CheckResult {
  status: IntegrationStatus;
  /** What the check found, and on error what to change. Never holds a secret. */
  detail: string;
}

export interface Description {
  kind: IntegrationKind;
  tool: string;
  /** The tool's own name, such as LiteLLM. */
  name: string;
  /** What the check does, in one sentence. */
  check: string;
  /** Where the call it makes is documented. */
  docs: string;
}

/** A workflow file of a repository, from .github/workflows. */
export interface WorkflowFile {
  /** Path in the repository, such as .github/workflows/review.yml. */
  path: string;
  text: string;
}

/**
 * What a reviewer check can see of the team's repositories: through the selfhost GitHub App on a
 * team server, or the checkout the CLI runs in. Each read answers undefined when it cannot see.
 */
export interface RepoView {
  /** How the repositories are read, for messages: "the selfhost GitHub App", "this checkout". */
  via: string;
  /** owner/name of each repository. */
  repos: readonly string[];
  /** Hint for when repos is empty or unreadable. */
  setup: string;
  workflows(repo: string): Promise<WorkflowFile[] | undefined>;
  /** Whether a GitHub App with this slug is installed on the repository's owner. */
  appInstalled?(repo: string, slug: string): Promise<boolean | undefined>;
  /** Logins of the bots that commented on the repository's recent pull requests and issues. */
  recentBots?(repo: string): Promise<string[] | undefined>;
}

/**
 * One tool for one job. Adding a tool is one file that exports one of these, listed in
 * registry.ts, and its name in the [integrations] schema.
 */
export interface Adapter<K extends IntegrationKind = IntegrationKind> {
  readonly kind: K;
  readonly tool: string;
  describe(): Description;
  /**
   * Checks that the tool is reachable and its credentials work, with the cheapest call its docs
   * give and nothing that changes anything. Reviewer adapters read `repos` instead of the network.
   */
  check(settings: Settings<K>, env: Env, fetch: Fetch, repos?: RepoView): Promise<CheckResult>;
}

export type AnyAdapter = { [K in IntegrationKind]: Adapter<K> }[IntegrationKind];

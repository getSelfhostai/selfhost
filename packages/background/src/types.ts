import type {
  EgressPolicy,
  RuntimeAdapter,
  Sandbox,
  SandboxSpec,
  SecretRef,
} from "@selfhost/runtime";
import type {
  BackgroundRun,
  BackgroundRunState,
  KillScope,
  LedgerEvent,
  ResolvedSelfhostConfig,
  RunCredentialKind,
} from "@selfhost/schema";

/**
 * The seams a background run is built on. Each is injected, so the run lifecycle is tested with
 * the in-memory runtime, a fake GitHub and a fake clock, and the real pieces (runtime adapters,
 * credential brokering, the GitHub App, the AI gateway, notifications) plug in from outside.
 */

/** A kill switch in force. */
export interface ActiveKill {
  scope: KillScope;
  target: string;
  by: string;
  at: string;
}

/** Where runs are kept. `@selfhost/ledger`'s `ledger.backgroundRuns` is one. */
export interface RunStore {
  create(run: BackgroundRun): Promise<boolean>;
  get(id: string): Promise<BackgroundRun | undefined>;
  /** Keeps a cancel recorded since the caller read the run. */
  save(run: BackgroundRun): Promise<BackgroundRun>;
  requestCancel(id: string, cancel: NonNullable<BackgroundRun["cancel"]>): Promise<boolean>;
  list(filter?: {
    teams?: readonly string[];
    states?: readonly BackgroundRunState[];
    limit?: number;
  }): Promise<BackgroundRun[]>;
  countSince(team: string, since: Date): Promise<number>;
  countActive(team: string): Promise<number>;
  kill(switchOn: {
    scope: KillScope;
    target: string;
    by: string;
    at: string;
    reason?: string;
  }): Promise<boolean>;
  clearKill(scope: KillScope, target: string, by: string, at: Date): Promise<boolean>;
  activeKills(scope: {
    teams?: readonly string[];
    orgs?: readonly string[];
  }): Promise<ActiveKill[]>;
}

/** Where ledger events go. The ledger itself is one. */
export interface EventSink {
  append(events: LedgerEvent[]): Promise<unknown>;
}

/**
 * The runtime seam: the adapter a run's sandbox is created on. Runtime selection
 * (`pickRuntime(config, request)`) and the adapters (E2B, Daytona, Modal, Coder, OpenSandbox)
 * live outside this package. Undefined means no runtime is set up for the run's team.
 */
export type RuntimeFor = (
  run: BackgroundRun,
  config: ResolvedSelfhostConfig,
) => RuntimeAdapter | undefined | Promise<RuntimeAdapter | undefined>;

/**
 * What a run's sandbox signs in with, from the credentials seam. Values never pass through here:
 * secrets are references the runtime resolves, and `setup` places login state the broker holds.
 */
export interface RunCredentials {
  kind: RunCredentialKind;
  /** Injected as environment variables by the runtime. A GITHUB_TOKEN here is used for clone and push. */
  secrets: readonly SecretRef[];
  /** Hosts the sandbox may reach; the runtime enforces it where it can. */
  egress?: EgressPolicy;
  /** Runs once the sandbox exists, before the agent: for example writing a person's agent login. */
  setup?: (sandbox: Sandbox, home: string) => Promise<void>;
  /**
   * The sandbox spec with the run's secrets, egress and plain variables merged in. When absent the
   * runner sets `secrets` and `egress` itself. `@selfhost/credentials` gives one.
   */
  spec?: (base: SandboxSpec) => SandboxSpec;
  /** Masks the run's own secret values in text the run writes (agent output, gate output). */
  mask?: (text: string) => string;
  /** Rules the runtime cannot hold as written, logged once when the sandbox is created. */
  gaps?: readonly string[];
  /** Called once when the run ends, whatever happened, with how it ended. */
  revoke(reason?: RevokeReason): Promise<void>;
}

/** Why credentials are revoked, as `@selfhost/credentials` records it. */
export type RevokeReason = "succeeded" | "failed" | "timed_out" | "killed" | "aborted";

/** The credentials seam refuses a run: the person has no login on the runtime, for example. */
export interface RefusedCredentials {
  refused: string;
}

/**
 * The credentials seam: per-run GitHub tokens, the person's own agent login or the team's API
 * key, and the egress allow list. The default sets up nothing (kind none).
 */
export type PrepareCredentials = (
  run: BackgroundRun,
  context: { runtime: RuntimeAdapter; config: ResolvedSelfhostConfig },
) => Promise<RunCredentials | RefusedCredentials>;

export const noCredentials: PrepareCredentials = async () => ({
  kind: "none",
  secrets: [],
  revoke: async () => {},
});

/**
 * A per-run virtual key on the team's AI gateway, so no provider key enters the sandbox. The key
 * goes only into the agent process's environment; it is never written to a file or the ledger.
 */
export interface GatewayAccess {
  /** Base URL for Anthropic-style clients, without /v1. */
  anthropic: string;
  /** Base URL for OpenAI-style clients, ending in /v1. */
  openai: string;
  key: string;
}

export type IssueGatewayKey = (run: BackgroundRun) => Promise<GatewayAccess | undefined>;

/** The pull request a run opened. */
export interface OpenedPull {
  number: number;
  url: string;
  headSha?: string;
}

/** What a run needs from GitHub, through the GitHub App. */
export interface RunGitHub {
  /** The repository's default branch. */
  defaultBranch(repo: string): Promise<string>;
  openPull(input: {
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<OpenedPull>;
  /** A check run on the pull request's head commit. */
  check(input: {
    repo: string;
    headSha: string;
    name: string;
    conclusion: "success" | "failure" | "neutral" | "skipped";
    title: string;
    summary: string;
    text?: string;
  }): Promise<void>;
  /** A comment on an issue or pull request, to answer a trigger. */
  comment(repo: string, number: number, body: string): Promise<void>;
}

/** Something the person a run works for should hear about. */
export interface RunAlert {
  kind: "run_failed" | "run_stuck" | "run_timed_out";
  title: string;
  body: string;
}

export type SendAlert = (run: BackgroundRun, alert: RunAlert) => Promise<void>;

/** Time for the runner: the clock and a repeating timer, so tests can drive both. */
export interface Clock {
  now(): Date;
  /** Calls `fn` every `ms` until the returned function is called. */
  every(ms: number, fn: () => Promise<void> | void): () => void;
}

export const systemClock: Clock = {
  now: () => new Date(),
  every(ms, fn) {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      Promise.resolve(fn()).finally(() => {
        running = false;
      });
    }, ms);
    timer.unref?.();
    return () => clearInterval(timer);
  },
};

/** What the runner reads for a team: its selfhost.toml in use, and that file's text for hooks. */
export interface TeamSettings {
  config: ResolvedSelfhostConfig;
  /** The team's policy text, written into the sandbox so its hooks apply the same rules. */
  policyText?: string;
  org?: string;
  /** People in the team, for the allowed list when [background] allowed is empty. */
  people?: readonly string[];
}

export type SettingsFor = (team: string) => Promise<TeamSettings>;

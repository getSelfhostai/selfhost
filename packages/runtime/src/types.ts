/**
 * The contract every runtime adapter implements. A runtime is a place a background agent runs:
 * a hosted sandbox (E2B, Daytona, Modal), a Coder workspace, or the team's own server through
 * OpenSandbox. selfhost only drives each provider through its own SDK or API; snapshots, network
 * limits and secrets use the provider's own features.
 */

/** Every runtime selfhost can drive. `opensandbox` is the team's own server or cluster. */
export const RUNTIME_KINDS = ["e2b", "daytona", "modal", "coder", "opensandbox"] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

/** Who may reach what from inside a sandbox. Hosts are exact names or `*.example.com`. */
export interface EgressPolicy {
  allow: readonly string[];
}

/** A secret the sandbox gets as an environment variable, by reference, never by value in specs. */
export interface SecretRef {
  /** The variable name inside the sandbox, like GITHUB_TOKEN. */
  name: string;
  /** Where the value comes from: `env:NAME`, `vault:path#key`, `infisical:path#key`, `github-app:repo`. */
  from: string;
}

export interface SandboxSpec {
  /** The provider's template, image or snapshot id to start from; the adapter's default when unset. */
  image?: string;
  /** A repository to clone into the working directory before the run. */
  repo?: { url: string; ref?: string };
  /** Plain environment variables. Never secrets: those go in `secrets`. */
  env?: Readonly<Record<string, string>>;
  secrets?: readonly SecretRef[];
  egress?: EgressPolicy;
  /** vCPUs and memory in GiB; adapters round up to the nearest size they offer. */
  size?: { cpu?: number; memoryGiB?: number };
  region?: string;
  /** The sandbox is stopped after this long, whatever it is doing. */
  timeoutMinutes: number;
  /** Labels the adapter attaches where the provider supports them: run id, team, person. */
  labels?: Readonly<Record<string, string>>;
}

export interface ExecOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  /** Each chunk of output as it arrives. */
  onOutput?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the command was stopped by `timeoutMs`. */
  timedOut: boolean;
}

export type SandboxState = "starting" | "running" | "paused" | "stopped" | "failed";

export interface SandboxCost {
  /** Seconds billed so far, as the provider counts them. */
  seconds: number;
  /** Dollars so far: the provider's reported figure, or seconds times the adapter's list price. */
  usd: number;
  /** Whether `usd` came from the provider or from the list price. */
  source: "provider" | "list_price";
}

export interface Sandbox {
  readonly id: string;
  readonly runtime: RuntimeKind;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  /** The sandbox's own log lines (boot, agent output) from the start, then live until it stops. */
  logs(signal?: AbortSignal): AsyncIterable<string>;
  /** A provider snapshot a later `create` can start from via `image`. */
  snapshot(): Promise<{ id: string }>;
  status(): Promise<SandboxState>;
  cost(): Promise<SandboxCost>;
  /** Stops and deletes the sandbox. Safe to call twice. */
  stop(): Promise<void>;
}

/** Which spec fields an adapter can enforce natively; `selfhost doctor` flags the rest. */
export interface RuntimeCapabilities {
  egress: boolean;
  secrets: boolean;
  snapshot: boolean;
  regions: readonly string[];
}

export interface RuntimeAdapter {
  readonly kind: RuntimeKind;
  readonly capabilities: RuntimeCapabilities;
  create(spec: SandboxSpec): Promise<Sandbox>;
  /** Reattaches to a sandbox this adapter created, for a run that outlives the process. */
  get(id: string): Promise<Sandbox | undefined>;
  /** Sandboxes still running with the given labels, to find and stop leftovers. */
  list(
    labels?: Readonly<Record<string, string>>,
  ): Promise<readonly { id: string; state: SandboxState }[]>;
}

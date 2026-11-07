import type { AgentVendor } from "@selfhost/schema";

export const AGENT_IDS = [
  "claude_code",
  "codex",
  "opencode",
  "goose",
  "cursor",
] as const satisfies readonly AgentVendor[];

export type AgentId = (typeof AGENT_IDS)[number];

export const AGENT_NAMES: Record<AgentId, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  goose: "Goose",
  cursor: "Cursor CLI",
};

export type Env = Record<string, string | undefined>;

/** Finds an executable on PATH and returns its absolute path. */
export type Which = (name: string) => string | undefined;

/**
 * Reports whether a keychain item exists, without reading its secret. Returns undefined when
 * the check could not run.
 */
export type KeychainCheck = (service: string, account?: string) => boolean | undefined;

/** Runs `<binary> --version` and returns the first line of output, or undefined. */
export type VersionProbe = (binary: string) => string | undefined;

export interface Probes {
  which?: Which;
  keychain?: KeychainCheck;
  version?: VersionProbe;
}

export interface LocateOptions {
  home: string;
  /** Process environment, read for CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_* and similar. */
  env?: Env;
  platform?: NodeJS.Platform;
}

export type LoginStatus = "logged_in" | "logged_out" | "unknown";
export type LoginMethod = "file" | "keychain" | "env" | "settings" | "database";

export interface AgentLogin {
  status: LoginStatus;
  /** How the login was found. null when nothing was found. */
  method: LoginMethod | null;
  /** The file path, keychain service or environment variable name that showed the login. */
  source: string | null;
  /** The vendor's own sign-in command, for agents that are not signed in. */
  hint: string;
}

export interface AgentStatus {
  id: AgentId;
  name: string;
  installed: boolean;
  binary: string | null;
  version: string | null;
  /** The agent's main settings file. */
  configPath: string;
  configExists: boolean;
  login: AgentLogin;
}

import type {
  CompileVendor,
  CoverageStatus,
  RuleAction,
  RuleMatch,
  RuleMode,
  VendorCoverage,
} from "@selfhost/schema";

export const PLATFORMS = ["darwin", "linux", "win32"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** The path on each platform. A platform without one gets no copy of the file. */
export type InstallPaths = Partial<Record<Platform, string>>;

/**
 * Where a file goes. system: an admin path, which selfhost prints as a command and never writes
 * itself. mdm: a per-user file that device management delivers (`~` is the home folder).
 * dashboard: text to paste into the vendor's admin dashboard. repo: a path in the repository.
 */
export type Install =
  | { kind: "system"; paths: InstallPaths; mode: "0644" | "0755" }
  | { kind: "mdm"; paths: InstallPaths }
  | { kind: "dashboard"; where: string }
  | { kind: "repo"; path: string };

export interface OutputFile {
  /** Path inside the vendor's folder of the output directory. */
  name: string;
  content: string;
  description: string;
  install: Install;
}

/** A GitHub REST API call. `{owner}` and `{repo}` in the path are filled in when it is made. */
export interface ApiCall {
  method: "PUT";
  path: string;
  body: Record<string, unknown>;
  description: string;
  /**
   * The call replaces a repository file: read it first (GET on the same path) and send its sha,
   * or the API refuses to overwrite it.
   */
  needsSha: boolean;
}

export interface VendorOutput {
  vendor: CompileVendor;
  version: string;
  files: OutputFile[];
  calls: ApiCall[];
}

/** A rule or allow-list check after the team's overrides, as the vendor compilers see it. */
export interface Check {
  id: string;
  mode: RuleMode;
  action: RuleAction;
  message: string;
  agents: string[];
  irreversible: boolean;
  /** What a rule matches. Absent for the allow-list checks. */
  match?: RuleMatch;
  /** The [mcp] or [models] allow list behind mcp.allow or models.allow. */
  list?: { kind: "mcp" | "models"; allow: string[] };
}

/** How a vendor's native controls express one check. */
export interface Mapping<E> {
  status: CoverageStatus;
  /** Native entries; only an enforced check's entries are written. */
  entries: E[];
  /** How the entries read in the coverage list. */
  native: string[];
  /** The vendor runs selfhost's pre-tool hook on the calls the check matches. */
  hook: boolean;
  detail: string;
}

export interface VendorContext {
  version: string;
  /** Checks for this vendor in mode observe or enforce. */
  checks: Check[];
  /** The hook command for this vendor, `{agent}` already replaced. */
  hookCommand: string;
  /** The policy text for rules files and team rules. */
  rulesText: string;
}

export interface VendorResult {
  output: VendorOutput;
  mappings: Map<string, Mapping<unknown>>;
  coverage: VendorCoverage;
}

export type VendorCompiler = (context: VendorContext) => VendorResult;

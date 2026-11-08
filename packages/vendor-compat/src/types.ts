import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PACKAGE_ROOT = join(import.meta.dirname, "..");
export const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

export type VendorId = "claude_code" | "codex" | "cursor" | "opencode";

export interface Vendor {
  id: VendorId;
  name: string;
  /** npm package that ships the CLI. */
  npm?: string;
  /** Installer script whose download URL names the version, for CLIs not on npm. */
  installer?: string;
}

export const VENDORS: Vendor[] = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, "vendors.json"), "utf8"),
).vendors;

export function vendorById(id: string): Vendor {
  const vendor = VENDORS.find((v) => v.id === id);
  if (!vendor) throw new Error(`Unknown vendor ${id}. Known: ${VENDORS.map((v) => v.id)}`);
  return vendor;
}

/**
 * pass and fail are verdicts. skip means the check could not run here (no API key, no root, a
 * CLI that would not say), which never marks a version broken.
 */
export type CheckStatus = "pass" | "fail" | "skip";

export interface Check {
  id: string;
  status: CheckStatus;
  detail: string;
}

export interface VendorRun {
  vendor: VendorId;
  version: string;
  /** Where the CLI was installed, for the later steps of the same run. */
  dir?: string;
  /** The CLI executable. */
  bin?: string;
  checks: Check[];
  /** Hook events the CLI offers that selfhost has no schema for. Informational. */
  unmodeled?: string[];
  notes?: string[];
}

export interface SuiteRun {
  id: string;
  command: string;
  /** Vendors whose hooks, importers or compilers the suite exercises. */
  vendors: VendorId[];
  status: "pass" | "fail";
  detail: string;
}

export const RUN_SCHEMA = "selfhost.vendor_compat_run/v1";

/** One run's results, built up by install, probe, suites and live in turn. */
export interface RunResults {
  schema: typeof RUN_SCHEMA;
  started: string;
  vendors: VendorRun[];
  suites: SuiteRun[];
}

import { run, tail } from "./exec.js";
import { REPO_ROOT, type SuiteRun, type VendorId } from "./types.js";

export interface Suite {
  id: string;
  /** What the fixture sessions go through. */
  what: string;
  args: string[];
  vendors: VendorId[];
}

/**
 * The fixture sessions and payloads, per vendor version where the fixtures have versions, run
 * through the code that reads them. They test selfhost's side of the contract; the probe and
 * live checks test the vendor's side.
 */
export const SUITES: Suite[] = [
  {
    id: "schema",
    what: "Hook payload fixtures and frozen v1 contracts against the payload schemas, and event schema versions",
    args: ["--filter", "@selfhost/schema", "test"],
    vendors: ["claude_code", "codex"],
  },
  {
    id: "hook-mappers",
    what: "Hook payload fixtures mapped to ledger events, and ingest of older event versions",
    args: [
      "--filter",
      "@selfhost/ledger",
      "exec",
      "vitest",
      "run",
      "test/sources/hooks.test.ts",
      "test/event-versions.test.ts",
    ],
    vendors: ["claude_code", "codex"],
  },
  {
    id: "importers",
    what: "Fixture session logs through the local log importers",
    args: ["--filter", "@selfhost/importers", "test"],
    vendors: ["claude_code", "codex"],
  },
  {
    id: "hooks",
    what: "Each agent's pre-tool payloads through selfhost hook, the spool and the ledger",
    args: [
      "--filter",
      "@selfhost/cli",
      "exec",
      "vitest",
      "run",
      "test/hook.test.ts",
      "test/guardrails.test.ts",
    ],
    vendors: ["claude_code", "codex", "cursor", "opencode"],
  },
  {
    id: "compile",
    what: "Policy compile golden files per vendor config version",
    args: ["--filter", "@selfhost/compile", "test"],
    vendors: ["claude_code", "codex", "cursor"],
  },
  {
    id: "context",
    what: "Context compile golden files per agent",
    args: ["--filter", "@selfhost/context", "test"],
    vendors: ["claude_code", "codex", "cursor", "opencode"],
  },
];

export function runSuite(suite: Suite): SuiteRun {
  const out = run("pnpm", suite.args, { cwd: REPO_ROOT, timeoutMs: 900_000 });
  const command = `pnpm ${suite.args.join(" ")}`;
  const passed = out.status === 0;
  return {
    id: suite.id,
    command,
    vendors: suite.vendors,
    status: passed ? "pass" : "fail",
    detail: passed ? suite.what : `${suite.what}. ${command} failed:\n${tail(out, 30)}`,
  };
}

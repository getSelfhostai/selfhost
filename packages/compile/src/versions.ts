import type { CompileVendor } from "@selfhost/schema";

/**
 * Vendor config versions with a golden fixture in fixtures/compile/<vendor>/<version>, oldest
 * first. The last one is the default target. When a vendor ships a release that changes its
 * config, add the version here and a fixture folder for it (fixtures/README.md says how).
 *
 * - claude_code: Claude Code CLI versions. 2.1.83 added managed-settings.d/.
 * - codex: Codex CLI versions.
 * - cursor: the hooks.json format version.
 * - copilot: the GitHub REST API version the calls are written for.
 */
export const VENDOR_VERSIONS = {
  claude_code: ["2.1.83", "2.1.319"],
  codex: ["0.167.0"],
  cursor: ["1"],
  copilot: ["2026-03-10"],
} as const satisfies Record<CompileVendor, readonly string[]>;

/** The Ruler release the rules files are written with, pinned in pnpm-workspace.yaml. */
export const RULER_VERSION = "0.3.46";

function parts(version: string): string[] {
  return version.split(/[.-]/);
}

/** Orders dotted or dashed versions part by part, numbers numerically. */
export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? "0";
    const y = right[i] ?? "0";
    const nx = Number(x);
    const ny = Number(y);
    const order =
      Number.isInteger(nx) && Number.isInteger(ny) ? nx - ny : x < y ? -1 : x > y ? 1 : 0;
    if (order !== 0) return order;
  }
  return 0;
}

export function atLeast(version: string, min: string): boolean {
  return compareVersions(version, min) >= 0;
}

/** The version to compile for: the requested one, or the newest with a fixture. */
export function resolveVersion(vendor: CompileVendor, requested?: string): string {
  const known: readonly string[] = VENDOR_VERSIONS[vendor];
  const oldest = known[0] as string;
  const newest = known[known.length - 1] as string;
  if (requested === undefined) return newest;
  if (!/^[0-9][0-9A-Za-z.-]*$/.test(requested)) {
    throw new Error(`${vendor}: "${requested}" is not a version`);
  }
  if (compareVersions(requested, oldest) < 0) {
    throw new Error(
      `${vendor} ${requested} is older than the oldest version selfhost compiles for (${oldest})`,
    );
  }
  return requested;
}

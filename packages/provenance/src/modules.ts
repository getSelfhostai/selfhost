import type { ResolvedSelfhostConfig } from "@selfhost/schema";
import picomatch from "picomatch";
import type { ProvenanceSettings } from "./types.js";

/** The module of files at the top of the repository when no glob claims them. */
export const ROOT_MODULE = "(root)";

/**
 * Agent lines a module needs before its revert and rework rate can flag it, so one reverted
 * line in a quiet folder does not raise every pull request that touches it.
 */
export const MIN_MODULE_LINES = 50;

export const DEFAULT_SETTINGS: ProvenanceSettings = {
  modules: {},
  moduleDepth: 1,
  windowDays: 14,
  threshold: 0.25,
};

/** The provenance settings in `[review]` of selfhost.toml. */
export function settingsFromConfig(config: ResolvedSelfhostConfig): ProvenanceSettings {
  const review = config.review;
  return {
    modules: review.modules ?? DEFAULT_SETTINGS.modules,
    moduleDepth: review.module_depth ?? DEFAULT_SETTINGS.moduleDepth,
    windowDays: review.revert_window_days ?? DEFAULT_SETTINGS.windowDays,
    threshold: review.revert_rate_threshold ?? DEFAULT_SETTINGS.threshold,
  };
}

const matchers = new Map<string, (path: string) => boolean>();

function matches(glob: string, path: string): boolean {
  let matcher = matchers.get(glob);
  if (!matcher) {
    matcher = picomatch(glob, { dot: true });
    matchers.set(glob, matcher);
  }
  return matcher(path);
}

/**
 * The module a repository path belongs to: the first `[review] modules` entry, in file order,
 * with a glob that matches it, else its first `moduleDepth` folders, else (root) for a file at
 * the top.
 */
export function moduleOf(
  path: string,
  settings: Pick<ProvenanceSettings, "modules" | "moduleDepth">,
): string {
  for (const [name, globs] of Object.entries(settings.modules)) {
    if (globs.some((glob) => matches(glob, path))) return name;
  }
  const folders = path.split("/").slice(0, -1);
  if (folders.length === 0) return ROOT_MODULE;
  return folders.slice(0, Math.max(1, settings.moduleDepth)).join("/");
}

/** The modules a change touches, from its files' paths (old and new path of a rename), sorted. */
export function touchedModules(
  files: { path: string; previousPath?: string }[],
  settings: Pick<ProvenanceSettings, "modules" | "moduleDepth">,
): string[] {
  const modules = new Set<string>();
  for (const file of files) {
    modules.add(moduleOf(file.path, settings));
    if (file.previousPath) modules.add(moduleOf(file.previousPath, settings));
  }
  return [...modules].sort();
}

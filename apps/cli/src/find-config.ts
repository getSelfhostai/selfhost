import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_FILE_NAME } from "@selfhost/schema";

export interface ConfigLocation {
  path: string;
  /** How the path was chosen. */
  from: "flag" | "env" | "search";
}

/**
 * Finds selfhost.toml: the --config flag, then SELFHOST_CONFIG, then the nearest
 * selfhost.toml from cwd upward, stopping at the git repository root.
 */
export function findConfig(
  cwd: string,
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
): ConfigLocation | undefined {
  if (flag) return { path: resolve(cwd, flag), from: "flag" };
  if (env.SELFHOST_CONFIG) return { path: resolve(cwd, env.SELFHOST_CONFIG), from: "env" };
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE_NAME);
    if (existsSync(candidate)) return { path: candidate, from: "search" };
    const parent = dirname(dir);
    if (existsSync(join(dir, ".git")) || parent === dir) return undefined;
    dir = parent;
  }
}

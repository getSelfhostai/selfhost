import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_FILE_NAME } from "@selfhost/schema";
import { readMembership, teamPolicyPath } from "./team/config.js";

/** The team policy pulled by the last sync, on a machine that joined a team. */
export interface TeamPolicyFile {
  path: string;
  team: string;
  server: string;
}

export interface ConfigLocation {
  path: string;
  /** How the path was chosen: team when no selfhost.toml was found and the team policy is used. */
  from: "flag" | "env" | "search" | "team";
  /** The pulled team policy when there is one, also when another file is used instead. */
  teamPolicy?: TeamPolicyFile;
}

/** The pulled team policy, when the config file at configPath has a membership and one was pulled. */
export function findTeamPolicy(configPath: string | undefined): TeamPolicyFile | undefined {
  if (configPath === undefined) return undefined;
  const membership = readMembership(configPath);
  const path = teamPolicyPath(configPath);
  if (!membership || !existsSync(path)) return undefined;
  return { path, team: membership.team, server: membership.server };
}

/**
 * Finds selfhost.toml: the --config flag, then SELFHOST_CONFIG, then the nearest
 * selfhost.toml from cwd upward, stopping at the git repository root. With configPath (the
 * ~/.selfhost/config.json that holds a team membership), a machine in a team falls back to the
 * team policy pulled by its last sync when none of those is found; a repository's own file
 * always wins over it.
 */
export function findConfig(
  cwd: string,
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  configPath?: string,
): ConfigLocation | undefined {
  const teamPolicy = findTeamPolicy(configPath);
  const found = (path: string, from: ConfigLocation["from"]): ConfigLocation => ({
    path,
    from,
    ...(teamPolicy ? { teamPolicy } : {}),
  });
  if (flag) return found(resolve(cwd, flag), "flag");
  if (env.SELFHOST_CONFIG) return found(resolve(cwd, env.SELFHOST_CONFIG), "env");
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE_NAME);
    if (existsSync(candidate)) return found(candidate, "search");
    const parent = dirname(dir);
    if (existsSync(join(dir, ".git")) || parent === dir) break;
    dir = parent;
  }
  return teamPolicy ? found(teamPolicy.path, "team") : undefined;
}

/** One line saying which file a command used when a team policy is also on this machine. */
export function describeConfigSource(location: ConfigLocation, shown: string): string | undefined {
  const { teamPolicy } = location;
  if (!teamPolicy) return undefined;
  if (location.from === "team") {
    return `Using the policy of team ${teamPolicy.team} pulled from ${teamPolicy.server}: there is no selfhost.toml in this repository.`;
  }
  return `Using ${shown}; the policy of team ${teamPolicy.team} pulled from ${teamPolicy.server} (${teamPolicy.path}) is not used while it exists.`;
}

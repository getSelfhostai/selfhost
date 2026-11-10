import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_FILE_NAME, composePolicy, type LayerConflict } from "@selfhost/schema";
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
 * team policy pulled by its last sync when none of those is found. A repository's own file is
 * used on top of it: see policyText.
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

/** True when the repository's file is layered on the pulled team policy (see policyText). */
export const layeredOnTeam = (location: ConfigLocation): boolean =>
  location.from === "search" &&
  location.teamPolicy !== undefined &&
  location.teamPolicy.path !== location.path;

/** One file the policy in use is made of, to point at the line that defines a rule. */
export interface PolicySource {
  path: string;
  text: string;
  /** Which layer the file is, such as "team web's policy"; unset for a lone selfhost.toml. */
  layer?: string;
}

export interface PolicyText {
  /** The selfhost.toml in use. */
  text: string;
  /** Fields of the repository's file that would relax the team policy; the team's value is used. */
  conflicts: LayerConflict[];
  /** The files text is made of, in order: the team policy, then the repository's file. */
  sources: PolicySource[];
}

/**
 * The name of the pulled team policy as a layer. The server composes it from the org floor and
 * the team's own file when the org has one, and says so in the file's header.
 */
export function teamLayerName(team: TeamPolicyFile, text: string): string {
  const made = /^# The policy in use: (.+)\. Change those, not this file\.$/m.exec(text)?.[1];
  const layers = made?.split(", then ") ?? [];
  return layers.some((layer) => layer.startsWith("org "))
    ? `team ${team.team}'s policy, made of ${layers.join(" then ")}`
    : `team ${team.team}'s policy`;
}

/**
 * The selfhost.toml in use at a location. On a machine in a team, a repository's own file adds
 * to the team policy pulled by the last sync, as a repo layer adds to its team's on the server:
 * it can add rules and tighten the team's, and the team's rules stay the floor (a field that
 * would relax one is listed in conflicts and the team's value is used). Otherwise, or when the
 * repository's file is invalid (so its own errors are reported), the file as it is.
 */
export function policyText(location: ConfigLocation): PolicyText {
  const own = readFileSync(location.path, "utf8");
  const team = location.teamPolicy;
  if (location.from === "team" && team) {
    return {
      text: own,
      conflicts: [],
      sources: [{ path: location.path, text: own, layer: teamLayerName(team, own) }],
    };
  }
  const alone = { text: own, conflicts: [], sources: [{ path: location.path, text: own }] };
  if (!team || !layeredOnTeam(location)) return alone;
  try {
    const teamText = readFileSync(team.path, "utf8");
    const composed = composePolicy([
      { kind: "org", name: `team ${team.team}`, text: teamText },
      { kind: "repo", name: location.path, text: own },
    ]);
    return {
      text: composed.text,
      conflicts: composed.conflicts,
      sources: [
        { path: team.path, text: teamText, layer: teamLayerName(team, teamText) },
        { path: location.path, text: own, layer: "this repository's selfhost.toml" },
      ],
    };
  } catch {
    return alone;
  }
}

/** One line saying which file a command used when a team policy is also on this machine. */
export function describeConfigSource(location: ConfigLocation, shown: string): string | undefined {
  const { teamPolicy } = location;
  if (!teamPolicy) return undefined;
  if (location.from === "team") {
    return `Using the policy of team ${teamPolicy.team} pulled from ${teamPolicy.server}: there is no selfhost.toml in this repository.`;
  }
  if (layeredOnTeam(location)) {
    return `Using ${shown} on top of the policy of team ${teamPolicy.team} pulled from ${teamPolicy.server} (${teamPolicy.path}): the team's rules are the floor, and ${shown} adds to them.`;
  }
  return `Using ${shown}; the policy of team ${teamPolicy.team} pulled from ${teamPolicy.server} (${teamPolicy.path}) is not used with a file given by name.`;
}

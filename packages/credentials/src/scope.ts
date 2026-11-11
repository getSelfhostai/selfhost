import { type ResolvedSelfhostConfig, RUN_SECRET_ENV_PREFIX } from "@selfhost/schema";

/**
 * Which secrets each team of a team server may read, from the server's own environment only:
 *
 * - env: secrets: `SELFHOST_RUN_SECRET_<TEAM>__<NAME>`, TEAM the team id in upper snake case
 *   (`web-platform` reads `SELFHOST_RUN_SECRET_WEB_PLATFORM__*`), or
 *   `SELFHOST_RUN_SECRET_SHARED__<NAME>` for the teams `SELFHOST_RUN_SECRET_SHARED_TEAMS` lists.
 *   The double underscore ends the team part, so one team's names never start another's.
 * - vault: and infisical: secrets: paths under `SELFHOST_SECRET_PATH_PREFIX` with `{team}`
 *   replaced by the team id, by default `selfhost/<team>/`.
 */
export interface SecretScope {
  /** Where a team's Vault and Infisical paths sit, with {team} for the team id. */
  pathPrefix: string;
  /** Team ids that may read SELFHOST_RUN_SECRET_SHARED__* variables. */
  sharedTeams: readonly string[];
}

export const TEAM_PLACEHOLDER = "{team}";
export const DEFAULT_SECRET_PATH_PREFIX = `selfhost/${TEAM_PLACEHOLDER}/`;
export const SECRET_PATH_PREFIX_ENV = "SELFHOST_SECRET_PATH_PREFIX";
export const SHARED_TEAMS_ENV = "SELFHOST_RUN_SECRET_SHARED_TEAMS";
export const SHARED_ENV_PREFIX = `${RUN_SECRET_ENV_PREFIX}SHARED__`;

/**
 * SELFHOST_SECRET_PATH_PREFIX (default selfhost/{team}/) and SELFHOST_RUN_SECRET_SHARED_TEAMS
 * (team ids separated by commas or spaces; default none).
 */
export function secretScopeFromEnv(env: NodeJS.ProcessEnv): SecretScope {
  return {
    pathPrefix: env[SECRET_PATH_PREFIX_ENV]?.trim() || DEFAULT_SECRET_PATH_PREFIX,
    sharedTeams: (env[SHARED_TEAMS_ENV] ?? "").split(/[\s,]+/).filter((team) => team !== ""),
  };
}

/** A team id in upper snake case, as its env: secrets name it: web-platform is WEB_PLATFORM. */
export function teamSecretName(team: string): string {
  return team.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/** The start of the server variables a team's env: secrets name: SELFHOST_RUN_SECRET_<TEAM>__. */
export function teamEnvPrefix(team: string): string {
  return `${RUN_SECRET_ENV_PREFIX}${teamSecretName(team)}__`;
}

/** Where a team's Vault and Infisical paths sit, without a leading slash, ending in one. */
export function teamPathPrefix(team: string, scope: SecretScope): string {
  const prefix = scope.pathPrefix.replaceAll(TEAM_PLACEHOLDER, team).replace(/^\/+/, "");
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

/** Why `team` may not read the server variable `variable`, or undefined when it may. */
export function envSecretRefusal(
  variable: string,
  team: string,
  scope: SecretScope,
): string | undefined {
  const own = teamEnvPrefix(team);
  const allowed = `team ${team} reads only server variables named ${own}<NAME>, or ${SHARED_ENV_PREFIX}<NAME> once the server lists it in ${SHARED_TEAMS_ENV}`;
  if (variable.startsWith(SHARED_ENV_PREFIX)) {
    if (variable.length > SHARED_ENV_PREFIX.length && scope.sharedTeams.includes(team)) {
      return undefined;
    }
    return `${variable} is a shared run secret and ${SHARED_TEAMS_ENV} on the server does not list team ${team}: ${allowed}`;
  }
  // A team id with "--" would make a team part with "__" in it, which another team's names
  // could start with.
  if (teamSecretName(team).includes("__")) {
    return `team ${team} has "--" in its id, so it cannot have env: secrets of its own: use ${SHARED_ENV_PREFIX}<NAME> or a vault: or infisical: path`;
  }
  if (variable.startsWith(own) && variable.length > own.length) return undefined;
  return allowed;
}

/**
 * Why `team` may not read a Vault or Infisical reference (`path#key`, or Infisical's `key`
 * alone, in its root folder), or undefined when it may: the path must sit under the team's
 * prefix, with no empty, `.` or `..` segment and no `%`, `?` or `\`, which a store or a URL
 * could read as another path.
 */
export function storeSecretRefusal(
  source: "vault" | "infisical",
  ref: string,
  team: string,
  scope: SecretScope,
): string | undefined {
  const where = `${source}:${ref}`;
  if (!scope.pathPrefix.includes(TEAM_PLACEHOLDER)) {
    return `${where}: ${SECRET_PATH_PREFIX_ENV} on the server must contain ${TEAM_PLACEHOLDER}, so each team reads only its own paths`;
  }
  const prefix = teamPathPrefix(team, scope);
  const hash = ref.lastIndexOf("#");
  const path = (hash === -1 ? "" : ref.slice(0, hash)).replace(/^\/+/, "");
  const segments = path.split("/");
  const safe = !/[%?\\]/.test(path) && segments.every((s) => s !== "" && s !== "." && s !== "..");
  if (safe && `${path}/`.startsWith(prefix)) return undefined;
  const shown = source === "infisical" ? `/${prefix}` : prefix;
  return `${where}: team ${team} reads only ${source} paths under ${shown} (${SECRET_PATH_PREFIX_ENV} on the server)`;
}

/** Why `team` may not read the secret `from` names, or undefined when it may. */
export function secretRefusal(from: string, team: string, scope: SecretScope): string | undefined {
  const colon = from.indexOf(":");
  const scheme = from.slice(0, colon);
  const ref = from.slice(colon + 1);
  if (scheme === "env") return envSecretRefusal(ref, team, scope);
  if (scheme === "vault" || scheme === "infisical") {
    return storeSecretRefusal(scheme, ref, team, scope);
  }
  return undefined;
}

/** Every [secrets.env] entry of a team's policy the team may not read, with why. */
export function secretScopeErrors(
  config: Pick<ResolvedSelfhostConfig, "secrets">,
  team: string,
  scope: SecretScope,
): { name: string; message: string }[] {
  return Object.entries(config.secrets?.env ?? {})
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .flatMap(([name, declared]) => {
      const message = secretRefusal(
        typeof declared === "string" ? declared : declared.from,
        team,
        scope,
      );
      return message === undefined ? [] : [{ name, message }];
    });
}

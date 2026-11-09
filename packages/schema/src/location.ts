import { RUNTIME_KINDS_RECORDED } from "./credential-events.js";

/**
 * Where an agent ran, recorded on its ledger events: on a laptop with no sandbox, in a local
 * sandbox, or in a remote runtime. The same rules give the same decisions in each; the location
 * only says where the decision was made.
 */
export const LOCAL_SANDBOXES = ["docker-sandboxes", "sandbox-runtime", "devcontainer"] as const;
export type LocalSandbox = (typeof LOCAL_SANDBOXES)[number];

/** `laptop`, `local:<sandbox>` or `runtime:<kind>`. */
export type ExecutionLocation = "laptop" | `local:${LocalSandbox}` | `runtime:${string}`;

/**
 * The variable selfhost sets in every place it starts or configures an agent: the run's sandbox
 * spec (`runtime:<kind>`), and the local sandbox configs it writes (`local:<sandbox>`).
 */
export const LOCATION_ENV = "SELFHOST_LOCATION";

export const EXECUTION_LOCATION_PATTERN = `^(?:laptop|local:(?:${LOCAL_SANDBOXES.join("|")})|runtime:(?:${RUNTIME_KINDS_RECORDED.join("|")}))$`;

const LOCATION = new RegExp(EXECUTION_LOCATION_PATTERN);

/**
 * Where this process runs: SELFHOST_LOCATION when selfhost set it, a devcontainer when VS Code's
 * or the devcontainer CLI's variable says so, else a laptop.
 */
export function executionLocation(env: NodeJS.ProcessEnv): ExecutionLocation {
  const named = env[LOCATION_ENV]?.trim();
  if (named && LOCATION.test(named)) return named as ExecutionLocation;
  if (env.REMOTE_CONTAINERS === "true" || env.DEVCONTAINER === "true") {
    return "local:devcontainer";
  }
  return "laptop";
}

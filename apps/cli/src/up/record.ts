import { readConfigFile, writeConfigFile } from "../config-file.js";
import { writableConfig } from "../team/config.js";
import type { CreatedResource } from "./resources.js";
import type { Provider } from "./size.js";

/**
 * A server `selfhost up` set up, kept in ~/.selfhost/config.json under `deployments` next to any
 * team membership. The file is mode 0600, as it already holds person tokens.
 */
export interface DeploymentRecord {
  server: string;
  provider: Provider;
  created_at: string;
  ip: string | null;
  domain: string;
  region: string | null;
  size: string | null;
  ssh: string;
  stack_dir: string;
  /** The server's admin token, for selfhost team commands; null when an earlier install's was kept. */
  admin_token: string | null;
  resources: CreatedResource[];
}

function records(config: Record<string, unknown> | undefined): DeploymentRecord[] {
  const list = config?.deployments;
  return Array.isArray(list) ? (list as DeploymentRecord[]) : [];
}

/** Adds the deployment, replacing an earlier one for the same server url. */
export function saveDeployment(configPath: string, record: DeploymentRecord): void {
  const config = writableConfig(configPath);
  const others = records(config).filter((entry) => entry.server !== record.server);
  writeConfigFile(configPath, { ...config, deployments: [...others, record] });
}

/** The admin token selfhost up saved for this server, if any. */
export function deploymentToken(configPath: string, server: string): string | undefined {
  const found = records(readConfigFile(configPath)).find((entry) => entry.server === server);
  return typeof found?.admin_token === "string" && found.admin_token
    ? found.admin_token
    : undefined;
}

/** The server selfhost up saved last, the default for selfhost team init. */
export function latestDeployment(configPath: string): DeploymentRecord | undefined {
  return records(readConfigFile(configPath)).at(-1);
}

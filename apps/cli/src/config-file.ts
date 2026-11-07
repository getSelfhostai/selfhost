import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** `~/.selfhost/config.json`: one-time answers and, in team mode, the team membership. */
export type ConfigFile = Record<string, unknown>;

export function defaultConfigPath(): string {
  return join(homedir(), ".selfhost", "config.json");
}

/** The config object, {} when the file is missing, undefined when it does not parse. */
export function readConfigFile(path: string): ConfigFile | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as ConfigFile)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Writes the whole config with mode 0600, since in team mode it holds a token. */
export function writeConfigFile(path: string, config: ConfigFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

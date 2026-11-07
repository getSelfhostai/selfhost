import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { formatConfigError, parseConfig } from "@selfhost/schema";
import { findConfig } from "./find-config.js";

export interface DoctorOptions {
  cwd: string;
  config?: string;
  env: NodeJS.ProcessEnv;
  version: string;
  write: (line: string) => void;
}

function runtime(): string {
  const node = `node ${process.version}`;
  const bun = process.versions.bun ? `, bun ${process.versions.bun}` : "";
  return `${node} (${process.platform} ${process.arch}${bun})`;
}

/** Prints the local setup and returns the process exit code. */
export function doctor({ cwd, config, env, version, write }: DoctorOptions): number {
  const row = (label: string, value: string) => write(`${label.padEnd(9)}${value}`);
  write(`selfhost ${version}`);
  row("runtime", runtime());

  const location = findConfig(cwd, config, env);
  if (!location) {
    row("config", "no selfhost.toml found (searched from this directory up to the repo root)");
    return 0;
  }
  if (!existsSync(location.path)) {
    const source = location.from === "flag" ? "--config" : "SELFHOST_CONFIG";
    row("config", `${location.path} (from ${source}) does not exist`);
    return 1;
  }
  row("config", location.path);

  const result = parseConfig(readFileSync(location.path, "utf8"));
  if (result.ok) {
    const { rules } = result.config;
    const enforced = rules.filter((rule) => rule.mode === "enforce").length;
    row("status", `valid, ${rules.length} rules (${enforced} enforced)`);
    return 0;
  }
  row("status", `invalid, ${result.errors.length} error(s)`);
  const file = relative(cwd, location.path) || location.path;
  for (const error of result.errors) write(`  ${formatConfigError(error, file)}`);
  return 1;
}

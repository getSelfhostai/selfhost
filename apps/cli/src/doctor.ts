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
  json?: boolean;
}

/** `selfhost doctor --json`. */
export interface DoctorReport {
  schema: "selfhost.doctor/v1";
  version: string;
  runtime: { node: string; bun: string | null; platform: string; arch: string };
  /** null when no selfhost.toml was found. */
  config: {
    path: string;
    from: "flag" | "env" | "search";
    exists: boolean;
    /** null when the file does not exist. */
    valid: boolean | null;
    rules: number;
    enforced: number;
    errors: { field: string; line: number | null; message: string }[];
  } | null;
}

export function doctorReport({ cwd, config, env, version }: DoctorOptions): DoctorReport {
  const report: DoctorReport = {
    schema: "selfhost.doctor/v1",
    version,
    runtime: {
      node: process.version,
      bun: process.versions.bun ?? null,
      platform: process.platform,
      arch: process.arch,
    },
    config: null,
  };
  const location = findConfig(cwd, config, env);
  if (!location) return report;
  const base = { path: location.path, from: location.from };
  if (!existsSync(location.path)) {
    report.config = { ...base, exists: false, valid: null, rules: 0, enforced: 0, errors: [] };
    return report;
  }
  const result = parseConfig(readFileSync(location.path, "utf8"));
  if (result.ok) {
    const { rules } = result.config;
    const enforced = rules.filter((rule) => rule.mode === "enforce").length;
    report.config = {
      ...base,
      exists: true,
      valid: true,
      rules: rules.length,
      enforced,
      errors: [],
    };
  } else {
    const errors = result.errors.map(({ field, line, message }) => ({
      field,
      line: line ?? null,
      message,
    }));
    report.config = { ...base, exists: true, valid: false, rules: 0, enforced: 0, errors };
  }
  return report;
}

/** Prints the local setup and returns the process exit code. */
export function doctor(options: DoctorOptions): number {
  const report = doctorReport(options);
  const failed = report.config !== null && report.config.valid !== true;
  if (options.json) {
    options.write(JSON.stringify(report, null, 2));
    return failed ? 1 : 0;
  }
  const { write, cwd } = options;
  const row = (label: string, value: string) => write(`${label.padEnd(9)}${value}`);
  const { runtime, config } = report;
  write(`selfhost ${report.version}`);
  const bun = runtime.bun ? `, bun ${runtime.bun}` : "";
  row("runtime", `node ${runtime.node} (${runtime.platform} ${runtime.arch}${bun})`);
  if (!config) {
    row("config", "no selfhost.toml found (searched from this directory up to the repo root)");
    return 0;
  }
  if (!config.exists) {
    const source = config.from === "flag" ? "--config" : "SELFHOST_CONFIG";
    row("config", `${config.path} (from ${source}) does not exist`);
    return 1;
  }
  row("config", config.path);
  if (config.valid) {
    row("status", `valid, ${config.rules} rules (${config.enforced} enforced)`);
    return 0;
  }
  row("status", `invalid, ${config.errors.length} error(s)`);
  const file = relative(cwd, config.path) || config.path;
  for (const error of config.errors) {
    write(`  ${formatConfigError({ ...error, line: error.line ?? undefined }, file)}`);
  }
  return 1;
}

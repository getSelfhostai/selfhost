import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Output {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command could not start or timed out. */
  error?: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
}

export function run(command: string, args: string[], options: RunOptions = {}): Output {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input ?? "",
    timeout: options.timeoutMs ?? 120_000,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error.message } : {}),
  };
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `selfhost-compat-${prefix}-`));
}

/**
 * An environment for running a vendor CLI with nothing of the machine's: a fresh HOME and config
 * folders, no API keys, no auto-update and no telemetry.
 */
export function isolatedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = tempDir("home");
  const dirs = {
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
  };
  // Codex 0.167 and later refuse a CODEX_HOME that does not exist yet, as a fresh install would
  // have created it.
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  return {
    PATH: process.env.PATH,
    HOME: home,
    ...dirs,
    TMPDIR: tmpdir(),
    NO_COLOR: "1",
    CI: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...extra,
  };
}

/** The last lines of a command's output, for a check's detail. */
export function tail(output: Output, lines = 12): string {
  const text = [output.error, output.stderr.trim(), output.stdout.trim()]
    .filter(Boolean)
    .join("\n");
  return text.split("\n").slice(-lines).join("\n");
}

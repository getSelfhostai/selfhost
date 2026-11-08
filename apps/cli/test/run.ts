import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import { type CliDeps, createProgram } from "../src/program.js";

export interface RunResult {
  code: number;
  out: string;
  err: string;
}

/** Runs the selfhost command line in process with fixture dependencies. */
export async function run(args: string[], deps: Partial<CliDeps> = {}): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  let code = 0;
  const program = createProgram({
    env: {},
    platform: "linux",
    probes: {},
    write: (line) => out.push(line),
    writeError: (line) => err.push(line),
    setExitCode: (value) => {
      code = value;
    },
    // Never wait on the terminal: tests that prompt pass their own answer.
    ask: undefined,
    // Never read or write the real ~/.selfhost/config.json.
    configPath: tempDir("config").path("config.json"),
    // Never read the real home directory's context files.
    home: tempDir("home").root,
    ...deps,
  });
  program.exitOverride();
  await program.parseAsync(["node", "selfhost", ...args]);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), `selfhost-cli-${prefix}-`));
  dirs.push(root);
  const path = (...parts: string[]) => join(root, ...parts);
  return {
    root,
    path,
    write(relative: string, content: string, mode?: number) {
      const file = path(relative);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
      if (mode !== undefined) chmodSync(file, mode);
      return file;
    },
    link(relative: string, target: string) {
      const file = path(relative);
      mkdirSync(dirname(file), { recursive: true });
      symlinkSync(target, file);
      return file;
    },
  };
}

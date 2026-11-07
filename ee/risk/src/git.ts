import { execFile } from "node:child_process";
import type { ChangedFile } from "./types.js";

/** Runs a command with plain arguments, never through a shell, and returns its stdout. */
export type Runner = (args: string[]) => Promise<string>;

function exec(command: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile(command, args, { maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return done(stdout);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        fail(new Error(`${command} is not installed`));
      } else {
        fail(
          new Error(
            `${command} ${args.join(" ")} failed: ${String(stderr).trim() || error.message}`,
          ),
        );
      }
    });
  });
}

// Settings that would change git's output if a user turned them on.
const GIT_CONFIG = [
  "-c",
  "log.showSignature=false",
  "-c",
  "color.ui=false",
  "-c",
  "core.quotePath=false",
];

export function gitIn(dir: string): Runner {
  return (args) => exec("git", ["-C", dir, ...GIT_CONFIG, ...args]);
}

/** The developer's own `gh` login. */
export const ghCli: Runner = (args) => exec("gh", args);

const NUMSTAT = /^(\d+|-)\t(\d+|-)\t(.*)$/s;

/** `git diff --numstat -z -M` output; binary files count as zero lines. */
export function parseNumstat(out: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const match = NUMSTAT.exec(tokens[i]?.replace(/^\n/, "") ?? "");
    if (!match) continue;
    const additions = match[1] === "-" ? 0 : Number(match[1]);
    const deletions = match[2] === "-" ? 0 : Number(match[2]);
    let path = match[3] ?? "";
    let previousPath: string | undefined;
    // A rename: "added\tdeleted\t" then the old and new paths as their own tokens.
    if (path === "") {
      previousPath = tokens[i + 1];
      path = tokens[i + 2] ?? "";
      i += 2;
    }
    if (path === "") continue;
    files.push({ path, ...(previousPath ? { previousPath } : {}), additions, deletions });
  }
  return files;
}

/** owner/name from a GitHub remote url (https or ssh). */
export function githubRepo(url: string): string | undefined {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

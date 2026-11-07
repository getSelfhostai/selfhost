import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Which selfhost.toml a decision used. */
export interface PolicySource {
  /** Absolute path of the file. */
  path: string;
  /** SHA-256 of the file bytes, in hex. */
  hash: string;
  /** Last commit that changed the file. Absent when it was never committed or git is missing. */
  commit?: string;
  /**
   * true when the bytes hashed are not the file as committed at HEAD: it has uncommitted
   * changes, or it has no commit at all.
   */
  dirty: boolean;
}

/** git's stdout, trimmed, or undefined when git is missing or the command fails. */
async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["-c", "log.showSignature=false", ...args], { cwd });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * Hashes the policy file and finds the git commit it came from. Runs git in the file's folder
 * with plain arguments, never through a shell.
 */
export async function policySource(path: string): Promise<PolicySource> {
  const file = resolve(path);
  const hash = createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
  const cwd = dirname(file);
  const name = basename(file);
  const commit = await git(cwd, ["log", "-1", "--format=%H", "--", name]);
  if (!commit) return { path: file, hash, dirty: true };
  // Blob ids through git itself, so line-ending and other attributes count as git sees them.
  const [committed, working] = await Promise.all([
    git(cwd, ["rev-parse", "--verify", "--quiet", `HEAD:./${name}`]),
    git(cwd, ["hash-object", "--", name]),
  ]);
  return { path: file, hash, commit, dirty: !committed || committed !== working };
}

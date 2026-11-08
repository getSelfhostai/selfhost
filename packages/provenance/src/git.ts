import { execFile } from "node:child_process";
import type { BlameLine, FileChange, MainlineCommit } from "./types.js";

/** Runs git in the repository with plain arguments, never through a shell, and returns stdout. */
export type Git = (args: string[]) => Promise<string>;

// Settings that would change git's output if a user turned them on.
const GIT_CONFIG = [
  "-c",
  "log.showSignature=false",
  "-c",
  "color.ui=false",
  "-c",
  "core.quotePath=false",
  "-c",
  "blame.ignoreRevsFile=",
];

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** The system git, run in `dir`. */
export function systemGit(dir: string): Git {
  return (args) =>
    new Promise((done, fail) => {
      execFile(
        "git",
        ["-C", dir, ...GIT_CONFIG, ...args],
        { maxBuffer: 512 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (!error) return done(stdout);
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            fail(new Error("git is not installed"));
            return;
          }
          const text = String(stderr).trim();
          fail(new GitError(`git ${args[0]} failed in ${dir}: ${text || error.message}`, text));
        },
      );
    });
}

/**
 * The main branch: `branch` when given, else what origin/HEAD points at, else origin/main,
 * origin/master, main, master and HEAD, the first that exists.
 */
export async function mainlineRef(git: Git, branch?: string): Promise<string> {
  const exists = async (ref: string) => {
    try {
      await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  };
  if (branch !== undefined) {
    if (await exists(branch)) return branch;
    throw new Error(`No branch or commit ${branch}`);
  }
  try {
    const head = (await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]))
      .trim()
      .replace(/^refs\/remotes\//, "");
    if (head && (await exists(head))) return head;
  } catch {
    // No origin/HEAD: try the usual names.
  }
  for (const ref of ["origin/main", "origin/master", "main", "master", "HEAD"]) {
    if (await exists(ref)) return ref;
  }
  throw new Error("The repository has no commits");
}

const RECORD = "\x1e";
const FIELD = "\x1f";
const FORMAT = "%x1e%H%x1f%P%x1f%cI%x1f%ce%x1f%ae%x1f%s%x1f%B%x1f";
const NUMSTAT = /^(\d+|-)\t(\d+|-)\t(.*)$/s;

/** `--numstat -z` output after a commit's format fields. */
export function parseNumstat(text: string): FileChange[] {
  const files: FileChange[] = [];
  const tokens = text.replace(/^\0?\n?/, "").split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const match = NUMSTAT.exec(tokens[i]?.replace(/^\n/, "") ?? "");
    if (!match) continue;
    let path = match[3] ?? "";
    let previousPath: string | undefined;
    // A rename: "added\tdeleted\t" then the old and new paths as their own tokens.
    if (path === "") {
      previousPath = tokens[i + 1];
      path = tokens[i + 2] ?? "";
      i += 2;
    }
    if (path === "") continue;
    const binary = match[1] === "-";
    files.push({
      path,
      ...(previousPath && previousPath !== path ? { previousPath } : {}),
      additions: binary ? 0 : Number(match[1]),
      deletions: binary ? 0 : Number(match[2]),
      binary,
    });
  }
  return files;
}

/** `git log` records in FORMAT with numstat, oldest first. */
export function parseMainline(out: string): MainlineCommit[] {
  const commits: MainlineCommit[] = [];
  for (const record of out.split(RECORD)) {
    if (record === "") continue;
    const [sha, parents, committedAt, committerEmail, authorEmail, subject, message, rest] =
      record.split(FIELD);
    if (!sha || !committedAt || rest === undefined) continue;
    commits.push({
      sha,
      parents: (parents ?? "").split(" ").filter(Boolean),
      committedAt: new Date(committedAt).toISOString(),
      committerEmail: (committerEmail ?? "").toLowerCase(),
      authorEmail: (authorEmail ?? "").toLowerCase(),
      subject: subject ?? "",
      message: message ?? "",
      files: parseNumstat(rest),
    });
  }
  return commits.reverse();
}

/**
 * First-parent commits of `ref` committed at or after `since`, oldest first, each with what it
 * changed against its first parent (renames found with -M). A merge shows what it brought in.
 */
export async function readMainline(git: Git, ref: string, since: Date): Promise<MainlineCommit[]> {
  const out = await git([
    "log",
    "--first-parent",
    "--diff-merges=first-parent",
    `--since=${since.toISOString()}`,
    "-z",
    "-M",
    "--numstat",
    "--no-ext-diff",
    "--no-textconv",
    "--no-relative",
    `--format=${FORMAT}`,
    ref,
    "--",
  ]);
  return parseMainline(out).filter((commit) => Date.parse(commit.committedAt) >= since.getTime());
}

const BLAME_HEADER = /^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/;

/** `git blame --line-porcelain` output: every line not from the boundary, in file order. */
export function parseBlame(out: string): BlameLine[] {
  const lines: BlameLine[] = [];
  let current: { origin: string; line: number; boundary: boolean; path: string } | undefined;
  for (const row of out.split("\n")) {
    if (current === undefined) {
      const header = BLAME_HEADER.exec(row);
      if (header) {
        current = { origin: header[1] ?? "", line: Number(header[2]), boundary: false, path: "" };
      }
      continue;
    }
    if (row.startsWith("\t")) {
      if (!current.boundary) {
        lines.push({
          origin: current.origin,
          path: current.path,
          line: current.line,
          blank: row.slice(1).trim() === "",
        });
      }
      current = undefined;
    } else if (row === "boundary") {
      current.boundary = true;
    } else if (row.startsWith("filename ")) {
      current.path = row.slice("filename ".length);
    }
  }
  return lines;
}

/**
 * The lines of `path` at `top` that commits after `bottom` introduced, with the commit, path
 * and line each came from. Moves and copies within and across files (-M -C) and whitespace-only
 * changes (-w) keep the older origin, so a moved or reindented line is not new. Without
 * `bottom`, the whole history up to `top` counts. A path that does not exist at `top` has no
 * lines.
 */
export async function blameSince(
  git: Git,
  bottom: string | undefined,
  top: string,
  path: string,
): Promise<BlameLine[]> {
  const range = bottom === undefined ? ["--root", top] : [`${bottom}..${top}`];
  try {
    const out = await git(["blame", "--line-porcelain", "-w", "-M", "-C", ...range, "--", path]);
    return parseBlame(out);
  } catch (error) {
    if (error instanceof GitError && /no such path|no such file/i.test(error.stderr)) return [];
    throw error;
  }
}

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { parseRemote } from "@selfhost/schema";

/** Runs git in a folder: its stdout, trimmed, or undefined when git failed. */
export type Git = (dir: string, args: string[]) => string | undefined;

export const systemGit: Git = (dir, args) => {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // A fetch over the network can ask for credentials; never wait on a prompt.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  } catch {
    return undefined;
  }
};

/** The top of the git working tree `dir` is in, or undefined outside one. */
export function gitTop(git: Git, dir: string): string | undefined {
  return git(dir, ["rev-parse", "--show-toplevel"]) || undefined;
}

/** owner/name of the clone's origin on GitHub (or any host parseRemote reads), else undefined. */
export function originRepo(git: Git, top: string): string | undefined {
  const url = git(top, ["remote", "get-url", "origin"]);
  return url ? parseRemote(url)?.repo : undefined;
}

export interface WorkState {
  /** The checked-out branch; undefined on a detached HEAD. */
  branch?: string;
  commit?: string;
  /**
   * true when every commit is on the branch's upstream, false when some are not, undefined when
   * the branch tracks nothing. Read from what git last fetched: nothing goes over the network.
   */
  pushed?: boolean;
  /** Files with changes that are not committed, as `git status` names them. */
  uncommitted: string[];
}

/** The branch, commit and what has not left this machine, in the clone at `top`. */
export function workState(git: Git, top: string): WorkState {
  const branch = git(top, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = git(top, ["rev-parse", "HEAD"]);
  const upstream = git(top, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const ahead = upstream ? git(top, ["rev-list", "--count", "@{u}..HEAD"]) : undefined;
  const status = git(top, ["status", "--porcelain", "--untracked-files=normal"]) ?? "";
  return {
    ...(branch && branch !== "HEAD" ? { branch } : {}),
    ...(commit && /^[0-9a-f]{7,64}$/.test(commit) ? { commit } : {}),
    ...(ahead !== undefined ? { pushed: ahead === "0" } : {}),
    uncommitted: status
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.slice(3).replace(/^.* -> /, ""))
      .filter((path) => !path.startsWith(".selfhost/handoff/")),
  };
}

export type CheckoutResult =
  | { fetched: false; error: string }
  | { fetched: true; switched: true }
  | { fetched: true; switched: false; why: string };

/**
 * Fetches the branch from origin and switches to it when the working tree is clean. A tree with
 * changes is left alone: switching could carry them onto the branch, or fail half way.
 */
export function checkoutBranch(git: Git, top: string, branch: string): CheckoutResult {
  if (git(top, ["fetch", "origin", branch]) === undefined) {
    return { fetched: false, error: `git fetch origin ${branch} failed` };
  }
  if (git(top, ["rev-parse", "--abbrev-ref", "HEAD"]) === branch) {
    const merged = git(top, ["merge", "--ff-only", `origin/${branch}`]);
    return merged === undefined
      ? {
          fetched: true,
          switched: false,
          why: `already on ${branch}, which has commits origin/${branch} does not; merge it yourself`,
        }
      : { fetched: true, switched: true };
  }
  const dirty = (git(top, ["status", "--porcelain"]) ?? "")
    .split("\n")
    .some((line) => line.trim() !== "" && !line.slice(3).startsWith(".selfhost/handoff/"));
  if (dirty) {
    return {
      fetched: true,
      switched: false,
      why: "the working tree has changes; commit or stash them, then switch",
    };
  }
  const exists = git(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const switched = exists
    ? git(top, ["switch", branch]) !== undefined &&
      git(top, ["merge", "--ff-only", `origin/${branch}`]) !== undefined
    : git(top, ["switch", "--track", "-c", branch, `origin/${branch}`]) !== undefined;
  return switched
    ? { fetched: true, switched: true }
    : { fetched: true, switched: false, why: `git switch ${branch} failed` };
}

/** Keeps a path out of commits through .git/info/exclude, which is never shared. */
export function excludeLocally(git: Git, top: string, pattern: string): void {
  const found = git(top, ["rev-parse", "--git-path", "info/exclude"]);
  if (!found) return;
  const file = isAbsolute(found) ? found : join(top, found);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (text.split("\n").some((line) => line.trim() === pattern)) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${text === "" || text.endsWith("\n") ? "" : "\n"}${pattern}\n`);
}

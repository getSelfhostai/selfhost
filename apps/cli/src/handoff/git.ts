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

/** A remote URL without the user name or password git may keep in it. */
export function withoutUserInfo(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
}

/** One form for the ways a remote URL can be written: https or ssh, with or without .git. */
function remoteKey(url: string): string {
  const bare = withoutUserInfo(url.trim());
  return (
    parseRemote(bare)?.remote ??
    bare
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "")
      .toLowerCase()
  );
}

/** The clone's remotes and their fetch URLs, origin first. */
export function remotes(git: Git, top: string): { name: string; url: string }[] {
  const names = (git(top, ["remote"]) ?? "").split("\n").filter((name) => name.trim() !== "");
  const found = names.flatMap((name) => {
    const url = git(top, ["config", "--get", `remote.${name}.url`]);
    return url ? [{ name, url }] : [];
  });
  return found.sort((a, b) => Number(b.name === "origin") - Number(a.name === "origin"));
}

/** Where a branch was pushed: its upstream's remote URL and branch, when it tracks one. */
export function upstreamOf(
  git: Git,
  top: string,
  branch: string,
): { url: string; branch: string } | undefined {
  const name = git(top, ["config", "--get", `branch.${branch}.remote`]);
  const merge = git(top, ["config", "--get", `branch.${branch}.merge`]);
  if (!name || name === "." || !merge) return undefined;
  const url = git(top, ["config", "--get", `remote.${name}.url`]);
  if (!url) return undefined;
  return { url: withoutUserInfo(url), branch: merge.replace(/^refs\/heads\//, "") };
}

export interface WorkState {
  /** The checked-out branch; undefined on a detached HEAD. */
  branch?: string;
  /** The remote the branch tracks, as upstreamOf reads it. */
  remote?: { url: string; branch: string };
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
  const named = branch && branch !== "HEAD" ? branch : undefined;
  const remote = named ? upstreamOf(git, top, named) : undefined;
  return {
    ...(named ? { branch: named } : {}),
    ...(remote ? { remote } : {}),
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
  | { fetched: true; remote: string; switched: true }
  | { fetched: true; remote: string; switched: false; why: string };

const shellWord = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;

/**
 * Fetches the branch and switches to it when the working tree is clean. It fetches from the
 * remote whose URL is the one the branch was pushed to, whatever this clone names it, else from
 * each remote in turn, origin first. A tree with changes is left alone: switching could carry
 * them onto the branch, or fail half way.
 */
export function checkoutBranch(
  git: Git,
  top: string,
  branch: string,
  pushedTo?: { url: string; branch: string } | null,
): CheckoutResult {
  const from = pushedTo?.branch ?? branch;
  // The names come from the server: only what git takes as a branch name goes on a command line.
  for (const name of new Set([branch, from])) {
    if (name.startsWith("-") || git(top, ["check-ref-format", "--branch", name]) === undefined) {
      return {
        fetched: false,
        error: `the handoff names ${JSON.stringify(name)}, which is not a branch name; nothing was fetched`,
      };
    }
  }
  const all = remotes(git, top);
  const want = pushedTo ? remoteKey(pushedTo.url) : undefined;
  const same = all.filter((remote) => remoteKey(remote.url) === want);
  const order = [...same, ...all.filter((remote) => !same.includes(remote))];
  const remote = order.find(
    ({ name }) =>
      git(top, ["fetch", name, `+refs/heads/${from}:refs/remotes/${name}/${from}`]) !== undefined,
  )?.name;
  if (remote === undefined) {
    const tried = all.length > 0 ? all.map((r) => r.name).join(", ") : "none";
    const command = pushedTo
      ? `git fetch ${shellWord(pushedTo.url)} ${shellWord(`${from}:${branch}`)} && git switch ${shellWord(branch)}`
      : undefined;
    return {
      fetched: false,
      error: command
        ? `${branch} was pushed to ${pushedTo?.url}, which no remote of this clone (${tried}) could fetch it from. Fetch it with: ${command}`
        : `no remote of this clone (${tried}) has ${branch}, and the handoff does not say where it was pushed. Ask the previous owner where, then run: git fetch <remote> ${shellWord(branch)}`,
    };
  }
  const tracking = `${remote}/${from}`;
  if (git(top, ["rev-parse", "--abbrev-ref", "HEAD"]) === branch) {
    const merged = git(top, ["merge", "--ff-only", tracking]);
    return merged === undefined
      ? {
          fetched: true,
          remote,
          switched: false,
          why: `already on ${branch}, which has commits ${tracking} does not; merge it yourself`,
        }
      : { fetched: true, remote, switched: true };
  }
  const dirty = (git(top, ["status", "--porcelain"]) ?? "")
    .split("\n")
    .some((line) => line.trim() !== "" && !line.slice(3).startsWith(".selfhost/handoff/"));
  if (dirty) {
    return {
      fetched: true,
      remote,
      switched: false,
      why: "the working tree has changes; commit or stash them, then switch",
    };
  }
  const exists = git(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const switched = exists
    ? git(top, ["switch", branch]) !== undefined &&
      git(top, ["merge", "--ff-only", tracking]) !== undefined
    : git(top, ["switch", "--track", "-c", branch, tracking]) !== undefined;
  return switched
    ? { fetched: true, remote, switched: true }
    : { fetched: true, remote, switched: false, why: `git switch ${branch} failed` };
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

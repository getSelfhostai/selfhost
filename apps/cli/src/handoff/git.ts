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

/**
 * Whether a remote takes pushes. A remote whose push URL is a placeholder rather than a URL or
 * a path (`git remote set-url --push origin no_push`, a common way to keep pushes off a remote)
 * does not.
 */
function pushes(git: Git, top: string, name: string): boolean {
  const push = git(top, ["config", "--get", `remote.${name}.pushurl`]);
  return push === undefined || push === "" || /[:/\\]/.test(push);
}

/**
 * Where a branch's commit already is when the branch tracks nothing, as `git push <remote>
 * <branch>` without -u leaves it: a remote-tracking ref that contains the commit, the one named
 * like the branch first, origin first among remotes. Read from what git last fetched or pushed.
 */
export function remoteHolding(
  git: Git,
  top: string,
  branch: string,
  commit: string,
): { name: string; url: string; branch: string } | undefined {
  const refs = (
    git(top, ["for-each-ref", "--contains", commit, "--format=%(refname)", "refs/remotes"]) ?? ""
  )
    .split("\n")
    .filter((ref) => ref !== "" && !ref.endsWith("/HEAD"));
  if (refs.length === 0) return undefined;
  const all = remotes(git, top);
  const found = all.flatMap(({ name, url }) =>
    refs
      .filter((ref) => ref.startsWith(`refs/remotes/${name}/`))
      .map((ref) => ({ name, url, branch: ref.slice(`refs/remotes/${name}/`.length) })),
  );
  const best = found.find((ref) => ref.branch === branch) ?? found[0];
  return best ? { ...best, url: withoutUserInfo(best.url) } : undefined;
}

export interface WorkState {
  /** The checked-out branch; undefined on a detached HEAD. */
  branch?: string;
  /**
   * Where the branch was pushed: the remote it tracks, as upstreamOf reads it, else a remote
   * that already has its commit (remoteHolding).
   */
  remote?: { url: string; branch: string };
  commit?: string;
  /**
   * true when every commit is on the branch's upstream (or, for a branch that tracks nothing,
   * when a remote already has its commit), false when some are not, undefined when no remote
   * has it. Read from what git last fetched: nothing goes over the network.
   */
  pushed?: boolean;
  /** For a branch no remote has: the remote to push it to, the first that takes pushes. */
  pushTo?: string;
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
  const sha = commit && /^[0-9a-f]{7,64}$/.test(commit) ? commit : undefined;
  const tracked = named ? upstreamOf(git, top, named) : undefined;
  const held = !upstream && named && sha ? remoteHolding(git, top, named, sha) : undefined;
  const remote = tracked ?? (held ? { url: held.url, branch: held.branch } : undefined);
  const pushed = ahead !== undefined ? ahead === "0" : held ? true : undefined;
  const pushTo =
    named && pushed === undefined
      ? remotes(git, top).find(({ name }) => pushes(git, top, name))?.name
      : undefined;
  return {
    ...(named ? { branch: named } : {}),
    ...(remote ? { remote } : {}),
    ...(sha ? { commit: sha } : {}),
    ...(pushed !== undefined ? { pushed } : {}),
    ...(pushTo ? { pushTo } : {}),
    uncommitted: status
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.slice(3).replace(/^.* -> /, ""))
      .filter((path) => !path.startsWith(".selfhost/handoff/")),
  };
}

/** The branch work is based on: origin's default branch, else main or master. */
function baseRef(git: Git, top: string): string | undefined {
  const head = git(top, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  const candidates = [
    ...(head ? [head] : []),
    "refs/remotes/origin/main",
    "refs/remotes/origin/master",
    "refs/heads/main",
    "refs/heads/master",
  ];
  return candidates.find(
    (ref) => git(top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) !== undefined,
  );
}

/**
 * The files the work on this branch changed, from git: what the branch changed since it left
 * its base (the merge base with the default branch) plus what is not committed. It counts
 * changes made through shell commands and leaves out edits that failed, which the run's tool
 * calls cannot tell. Undefined when there is no base to compare with, such as on the default
 * branch itself; the server then lists the files from the run's tool calls.
 */
export function changedFiles(
  git: Git,
  top: string,
  exclude: readonly string[] = [],
): string[] | undefined {
  const base = baseRef(git, top);
  if (base === undefined) return undefined;
  const current = git(top, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const tip = git(top, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  if (current === undefined || current === tip) return undefined;
  const fork = git(top, ["merge-base", base, "HEAD"]);
  if (fork === undefined) return undefined;
  const lines = (args: string[]) =>
    (git(top, args) ?? "").split("\n").filter((path) => path !== "");
  return [
    ...new Set([
      // Committed on the branch, then changed since, then new files one by one.
      ...lines(["diff", "--name-only", "--no-renames", fork, "HEAD"]),
      ...lines(["diff", "--name-only", "--no-renames", "HEAD"]),
      ...lines(["ls-files", "--others", "--exclude-standard"]),
    ]),
  ].filter((path) => !path.startsWith(".selfhost/handoff/") && !exclude.includes(path));
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
 * each remote in turn, origin first. A tree with changes to tracked files is left alone:
 * switching could carry them onto the branch, or fail half way. Untracked files do not count.
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
  // Only changes to tracked files block the switch. Untracked files (selfhost.toml right after
  // `selfhost init`) go along with it, and git itself refuses when the branch has one of them.
  const status = (git(top, ["status", "--porcelain", "--untracked-files=normal"]) ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.slice(3).startsWith(".selfhost/handoff/"));
  if (status.some((line) => !line.startsWith("??"))) {
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
  if (switched) return { fetched: true, remote, switched: true };
  const untracked = status.map((line) => line.slice(3));
  const inTheWay =
    untracked.length > 0
      ? (git(top, ["ls-tree", "-r", "--name-only", tracking, "--", ...untracked]) ?? "")
          .split("\n")
          .filter((path) => path !== "")
      : [];
  return {
    fetched: true,
    remote,
    switched: false,
    why:
      inTheWay.length > 0
        ? `${branch} has files this clone holds untracked (${inTheWay.join(", ")}); move them aside, then switch`
        : `git switch ${branch} failed`,
  };
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

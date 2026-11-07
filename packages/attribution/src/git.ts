import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import {
  type Attribution,
  botMatch,
  branchVendor,
  type KnownSessions,
  type Match,
  resolve,
  sessionMatches,
  trailerMatches,
} from "./match.js";
import type { AgentVendor, CommitRecord, SessionHint } from "./types.js";

/** A commit this long after a session's last activity can still come from that session. */
export const FILE_TIME_SLACK_MS = 30 * 60 * 1000;

// Settings that would change git's output if a user turned them on.
const GIT_CONFIG = [
  "-c",
  "log.showSignature=false",
  "-c",
  "log.showRoot=true",
  "-c",
  "color.ui=false",
];

/** Runs git and hands stdout to `onData` as it arrives. */
function git(
  cwd: string,
  args: string[],
  onData: (chunk: string) => void,
  stdin?: string,
): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn("git", ["-C", cwd, ...GIT_CONFIG, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (code === 0) done();
      else fail(new Error(`git ${args[0]} failed in ${cwd}: ${stderr.trim() || `exit ${code}`}`));
    });
    // git can exit before reading its input; the exit code reports why.
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

async function gitText(cwd: string, args: string[], stdin?: string): Promise<string> {
  let out = "";
  await git(
    cwd,
    args,
    (chunk) => {
      out += chunk;
    },
    stdin,
  );
  return out;
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Commits only agent branches reach: reachable from a branch with an agent prefix and from no
 * other branch. A commit that was merged into main, or that two agents' branches share, gets no
 * branch signal.
 */
async function agentBranchCommits(root: string, since: Date): Promise<Map<string, AgentVendor>> {
  const refs = (
    await gitText(root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"])
  )
    .split("\n")
    .filter((ref) => ref !== "" && !ref.endsWith("/HEAD"));
  const byVendor = new Map<AgentVendor, string[]>();
  const others: string[] = [];
  for (const ref of refs) {
    const vendor = branchVendor(ref);
    if (!vendor) others.push(ref);
    else if (byVendor.has(vendor)) byVendor.get(vendor)?.push(ref);
    else byVendor.set(vendor, [ref]);
  }
  // With no other branch, nothing tells agent work apart from the rest of the history.
  if (others.length === 0) return new Map();
  const owner = new Map<string, AgentVendor | null>();
  for (const [vendor, agentRefs] of byVendor) {
    const revs = `${[...agentRefs, ...others.map((ref) => `^${ref}`)].join("\n")}\n`;
    const shas = await gitText(
      root,
      ["rev-list", `--since=${since.toISOString()}`, "--stdin"],
      revs,
    );
    for (const sha of shas.split("\n")) {
      if (sha === "") continue;
      const current = owner.get(sha);
      owner.set(sha, current === undefined || current === vendor ? vendor : null);
    }
  }
  return new Map([...owner].filter((entry): entry is [string, AgentVendor] => entry[1] !== null));
}

interface PreparedSession {
  hint: SessionHint;
  start: number;
  end: number;
  files: Set<string>;
}

/**
 * `path` relative to the repository root, or undefined when it is outside. `links` maps a
 * directory to its real path, so /tmp/x and /private/tmp/x are the same place.
 */
function underRoot(path: string, bases: string[], links: [string, string][]): string | undefined {
  const spellings = [path];
  for (const [from, to] of links) {
    if (from !== to && (path === from || path.startsWith(`${from}${sep}`))) {
      spellings.push(to + path.slice(from.length));
    }
  }
  for (const spelling of spellings) {
    for (const base of bases) {
      const rel = relative(base, spelling);
      if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return rel;
    }
  }
  return undefined;
}

/** Sessions that ran in this repository, with their files as repository paths. */
function prepareSessions(root: string, sessions: SessionHint[]): PreparedSession[] {
  const bases = [...new Set([root, realpath(root)])];
  const prepared: PreparedSession[] = [];
  for (const hint of sessions) {
    if (!hint.cwd || !isAbsolute(hint.cwd)) continue;
    const cwd = resolvePath(hint.cwd);
    const links: [string, string][] = [[cwd, realpath(cwd)]];
    if (underRoot(cwd, bases, links) === undefined) continue;
    const start = Date.parse(hint.start);
    const end = Date.parse(hint.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const files = new Set<string>();
    for (const file of hint.files) {
      const rel = underRoot(isAbsolute(file) ? file : join(cwd, file), bases, links);
      if (rel) files.add(rel.split(sep).join("/"));
    }
    if (files.size > 0) prepared.push({ hint, start, end, files });
  }
  return prepared;
}

/**
 * The session that edited this commit's files shortly before it: the commit time falls in the
 * session's window plus FILE_TIME_SLACK_MS, and at least one file overlaps. The session with the
 * most overlapping files wins; equal overlap across vendors gives no match.
 */
function fileTimeMatch(commit: CommitRecord, sessions: PreparedSession[]): Match | undefined {
  const at = Date.parse(commit.authoredAt);
  let best: { session: PreparedSession; overlap: number }[] = [];
  for (const session of sessions) {
    if (at < session.start || at > session.end + FILE_TIME_SLACK_MS) continue;
    const overlap = commit.files.filter((file) => session.files.has(file)).length;
    if (overlap === 0) continue;
    if (best.length === 0 || overlap > (best[0]?.overlap ?? 0)) best = [{ session, overlap }];
    else if (overlap === best[0]?.overlap) best.push({ session, overlap });
  }
  if (best.length === 0) return undefined;
  if (new Set(best.map((b) => b.session.hint.vendor)).size > 1) return undefined;
  const chosen = best.reduce((a, b) => (b.session.start > a.session.start ? b : a)).session.hint;
  return {
    signal: "file_time_match",
    vendor: chosen.vendor,
    sessionId: chosen.sessionId,
    ...(chosen.model ? { model: chosen.model } : {}),
  };
}

const RECORD = "\x1e";
const FIELD = "\x1f";
const FORMAT = "%x1e%H%x1f%aI%x1f%ae%x1f%s%x1f%B%x1f";
const NUMSTAT = /^(\d+|-)\t(\d+|-)\t(.*)$/s;

interface RawCommit {
  record: CommitRecord;
  message: string;
}

function parseRecord(text: string): RawCommit | undefined {
  const [sha, date, email, subject, message, rest] = text.split(FIELD);
  if (!sha || !date || rest === undefined) return undefined;
  const files: string[] = [];
  let additions = 0;
  let deletions = 0;
  const tokens = rest.replace(/^\0?\n?/, "").split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const match = NUMSTAT.exec(tokens[i] ?? "");
    if (!match) continue;
    let path = match[3] ?? "";
    // A rename: "added\tdeleted\t" then the old and new paths as their own tokens.
    if (path === "") {
      path = tokens[i + 2] ?? "";
      i += 2;
    }
    if (path === "") continue;
    files.push(path);
    if (match[1] !== "-") additions += Number(match[1]);
    if (match[2] !== "-") deletions += Number(match[2]);
  }
  return {
    record: {
      sha,
      authoredAt: new Date(date).toISOString(),
      authorEmail: email ?? "",
      subject: subject ?? "",
      files,
      additions,
      deletions,
    },
    message: message ?? "",
  };
}

/**
 * Commits on every local and remote-tracking branch since `since` (committer date), newest
 * first, each attributed from the strongest signal it carries. Merge commits are left out.
 * git's output is parsed as it streams, so memory stays flat on large repositories.
 */
export async function readCommits(
  repoDir: string,
  opts: { since: Date; sessions?: SessionHint[] },
): Promise<CommitRecord[]> {
  const root = (await gitText(repoDir, ["rev-parse", "--show-toplevel"])).trim();
  const known: KnownSessions = new Map(
    (opts.sessions ?? []).map((hint) => [hint.sessionId, hint] as const),
  );
  const sessions = prepareSessions(root, opts.sessions ?? []);
  const branches = await agentBranchCommits(root, opts.since);

  const commits: CommitRecord[] = [];
  const add = (text: string) => {
    const raw = parseRecord(text);
    if (!raw) return;
    const { record, message } = raw;
    const matches: Match[] = [...trailerMatches(message), ...sessionMatches(message, known)];
    const bot = botMatch({ email: record.authorEmail });
    if (bot) matches.push(bot);
    const branch = branches.get(record.sha);
    if (branch) matches.push({ signal: "branch_prefix", vendor: branch });
    const fileTime = fileTimeMatch(record, sessions);
    if (fileTime) matches.push(fileTime);
    commits.push(withAttribution(record, resolve(matches)));
  };

  let buffer = "";
  await git(
    root,
    [
      "log",
      "--branches",
      "--remotes",
      "--no-merges",
      `--since=${opts.since.toISOString()}`,
      "-z",
      "-M",
      "--numstat",
      "--no-ext-diff",
      "--no-textconv",
      "--no-relative",
      `--format=${FORMAT}`,
    ],
    (chunk) => {
      buffer += chunk;
      const records = buffer.split(RECORD);
      buffer = records.pop() ?? "";
      for (const record of records) if (record !== "") add(record);
    },
  );
  if (buffer !== "") add(buffer);
  return commits;
}

function withAttribution(record: CommitRecord, found: Attribution | undefined): CommitRecord {
  if (!found) return record;
  return {
    ...record,
    agent: found.agent,
    signal: found.signal,
    ...(found.sessionId ? { sessionId: found.sessionId } : {}),
  };
}

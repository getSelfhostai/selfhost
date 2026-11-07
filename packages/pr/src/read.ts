import {
  type AgentRef,
  type CommitRecord,
  type GitHubCommit,
  type GitHubPull,
  type GitHubSource,
  ghCliSource,
  readCommits,
  readPulls,
} from "@selfhost/attribution";
import type { Ledger } from "@selfhost/ledger";
import { compare, isManifest } from "./dependencies.js";
import { parseDiff } from "./diff.js";
import { ghCli, githubRepo, gitIn, parseNumstat, type Runner } from "./git.js";
import { commitTimes, type PullRequestFile, readPullFiles } from "./pull.js";
import { commitWindow, readRun, runAgent, sessionHints } from "./run.js";
import type { Change, ChangedFile, ChangeRef, ChangeTarget, ManifestChange, Run } from "./types.js";

export interface ReadChangeOptions {
  /** Any folder inside the repository. */
  repoDir: string;
  target: ChangeTarget;
  /** owner/name. Default: the origin remote. */
  repo?: string;
  /** Where the agent runs are. Without it, there is no run. */
  ledger?: Pick<Ledger, "query">;
  /** Read local commits from at least this far back too, for history beyond the change. */
  since?: Date;
  /** Runs gh. Default: the developer's own gh login. */
  gh?: Runner;
  /** Where gh responses are cached. Default: ~/.selfhost/cache/github. */
  ghCacheDir?: string;
}

/**
 * The target from command line arguments: a pull request number, or `base` with an optional
 * `head`, never both.
 */
export function parseChangeTarget(args: {
  pr?: string;
  base?: string;
  head?: string;
}): ChangeTarget {
  if ((args.pr === undefined) === (args.base === undefined)) {
    throw new Error("Pass a pull request number or --base <ref>, not both and not neither");
  }
  if (args.pr !== undefined) {
    if (!/^\d+$/.test(args.pr) || Number(args.pr) < 1) {
      throw new Error(`Expected a pull request number, got "${args.pr}"`);
    }
    if (args.head !== undefined) throw new Error("--head goes with --base");
    return { pr: Number(args.pr) };
  }
  return { base: args.base as string, ...(args.head ? { head: args.head } : {}) };
}

/** The diff and commits, before attribution and the run are added. */
interface Diff {
  target: ChangeRef & { root: string };
  pull?: { title: string; body?: string };
  subjects: string[];
  files: ChangedFile[];
  /** Commit times, ISO 8601. */
  times: string[];
  manifests: ManifestChange[];
  manifestProblem?: string;
  /** The agent attribution found on GitHub. */
  pullAgent?: AgentRef;
}

async function show(git: Runner, ref: string, path: string): Promise<string | undefined> {
  try {
    return await git(["show", `${ref}:${path}`]);
  } catch {
    return undefined;
  }
}

/** Local commits from the merge base of `base` up to `head`, diffed like a pull request. */
async function localDiff(root: string, base: string, head: string): Promise<Diff> {
  const git = gitIn(root);
  const mergeBase = (await git(["merge-base", base, head])).trim();
  const log = (await git(["log", "--reverse", "--format=%H%x1f%aI%x1f%s", `${mergeBase}..${head}`]))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\x1f"));
  if (log.length === 0) throw new Error(`No commits on ${head} since ${base}`);
  const flags = ["-M", "--no-ext-diff", "--no-textconv", mergeBase, head];
  const [numstat, patch] = await Promise.all([
    git(["diff", "-z", "--numstat", ...flags]),
    // Explicit prefixes, whatever diff.noprefix or diff.mnemonicPrefix say.
    git(["diff", "-U0", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", ...flags]),
  ]);
  const diffs = new Map(parseDiff(patch).map((file) => [file.path, file] as const));
  const files = parseNumstat(numstat).map((file): ChangedFile => {
    const diff = diffs.get(file.path);
    return {
      ...file,
      status: diff?.status ?? "modified",
      ...(diff?.hunks ? { hunks: diff.hunks } : {}),
    };
  });
  const manifests: ManifestChange[] = [];
  let manifestProblem: string | undefined;
  for (const file of files.filter((f) => isManifest(f.path))) {
    const [before, after] = await Promise.all([
      show(git, mergeBase, file.previousPath ?? file.path),
      show(git, head, file.path),
    ]);
    if (after === undefined && before === undefined) {
      manifestProblem = `could not read ${file.path}`;
    }
    manifests.push({
      path: file.path,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    });
  }
  return {
    target: {
      root,
      base: mergeBase,
      head: (await git(["rev-parse", head])).trim(),
      commits: log.map(([sha]) => sha ?? ""),
    },
    subjects: log.map(([, , subject]) => subject ?? ""),
    files,
    times: log.map(([, time]) => time ?? ""),
    manifests,
    ...(manifestProblem ? { manifestProblem } : {}),
  };
}

interface PullDetail extends GitHubPull {
  title: string;
  base: { sha: string };
  head: { ref: string; sha: string };
}

const api = (gh: Runner, path: string, accept = "application/vnd.github+json") =>
  gh(["api", "-H", `Accept: ${accept}`, "-H", "X-GitHub-Api-Version: 2022-11-28", path]);

/** A pull request through gh (read-only GET requests), with its manifests at base and head. */
async function pullDiff(
  root: string,
  repo: string,
  pull: PullDetail,
  apiCommits: GitHubCommit[],
  gh: Runner,
  source: GitHubSource,
  local: () => Promise<CommitRecord[]>,
): Promise<Diff> {
  const number = pull.number;
  const { files, manifests, manifestProblem } = await readPullFiles(
    {
      async files() {
        const listed: PullRequestFile[] = [];
        // GitHub lists at most 3000 files.
        for (let page = 1; page <= 30; page++) {
          const batch = JSON.parse(
            await api(gh, `repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`),
          ) as PullRequestFile[];
          listed.push(...batch);
          if (batch.length < 100) break;
        }
        return listed;
      },
      async contents(path, ref) {
        try {
          return await api(
            gh,
            `repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`,
            "application/vnd.github.raw+json",
          );
        } catch {
          return undefined;
        }
      },
    },
    pull.base.sha,
    pull.head.sha,
  );

  // Attribution as readPulls does it, for this one pull request.
  const [record] = await readPulls(repo, {
    since: new Date(0),
    commits: await local(),
    source: { ...source, pulls: async () => [pull] },
  });
  return {
    target: {
      root,
      pr: { repo, number, url: pull.html_url },
      base: pull.base.sha,
      head: pull.head.sha,
      commits: apiCommits.map((commit) => commit.sha),
    },
    pull: { title: pull.title, ...(pull.body ? { body: pull.body } : {}) },
    subjects: apiCommits.map((commit) => commit.commit.message.split("\n")[0] ?? ""),
    files,
    times: commitTimes(apiCommits),
    manifests,
    ...(manifestProblem ? { manifestProblem } : {}),
    ...(record?.agent ? { pullAgent: record.agent } : {}),
  };
}

/** The agent and model behind most of the attributed commits; ties go to the first by name. */
function mainAgent(commits: CommitRecord[]): AgentRef | undefined {
  const counts = new Map<string, { agent: AgentRef; count: number }>();
  for (const commit of commits) {
    if (!commit.agent) continue;
    const key = `${commit.agent.vendor}\n${commit.agent.model ?? ""}`;
    const entry = counts.get(key) ?? { agent: commit.agent, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  const [best] = [...counts.entries()].sort(([a, x], [b, y]) => y.count - x.count || compare(a, b));
  return best?.[1].agent;
}

async function originRepo(root: string): Promise<string | undefined> {
  try {
    return githubRepo(await gitIn(root)(["remote", "get-url", "origin"]));
  } catch {
    return undefined;
  }
}

/** A change read from a clone, so its repository root is known. */
export type LocalChange = Change & { target: { root: string } };

/**
 * Reads a change locally: the diff, its hunks and manifests from git (or from GitHub through gh
 * for a pull request number), attribution from git, and the agent run from the ledger. Never
 * writes to GitHub.
 */
export async function readChange(opts: ReadChangeOptions): Promise<LocalChange> {
  const root = (await gitIn(opts.repoDir)(["rev-parse", "--show-toplevel"])).trim();
  const cwds = new Map<string, string | undefined>();

  // Commits are read once the change's time window is known, for attribution.
  let window: { from: Date; to: Date } | undefined;
  let history: CommitRecord[] | undefined;
  const readLocal = async () => {
    if (history) return history;
    const sessions =
      opts.ledger && window ? await sessionHints(opts.ledger, window.from, window.to, cwds) : [];
    const starts = [opts.since, window?.from].flatMap((date) => (date ? [date.getTime()] : []));
    const since = new Date(starts.length > 0 ? Math.min(...starts) : 0);
    history = await readCommits(root, { since, sessions });
    return history;
  };

  let diff: Diff;
  let repo: string | undefined;
  if ("pr" in opts.target) {
    repo = opts.repo ?? (await originRepo(root));
    if (!repo) {
      throw new Error(
        "No GitHub repository: the origin remote is not on github.com. Pass --base <ref> to use the local commits instead.",
      );
    }
    const gh = opts.gh ?? ghCli;
    const source = ghCliSource({
      run: gh,
      ...(opts.ghCacheDir ? { cacheDir: opts.ghCacheDir } : {}),
    });
    const number = opts.target.pr;
    // The window needs the commit times, so read them before the local commits.
    const pull = JSON.parse(await api(gh, `repos/${repo}/pulls/${number}`)) as PullDetail;
    const apiCommits = await source.commits(repo, { number, updatedAt: pull.updated_at });
    window = commitWindow(commitTimes(apiCommits));
    diff = await pullDiff(root, repo, pull, apiCommits, gh, source, readLocal);
  } else {
    repo = opts.repo ?? (await originRepo(root));
    diff = await localDiff(root, opts.target.base, opts.target.head ?? "HEAD");
    window = commitWindow(diff.times);
  }

  const local = await readLocal();
  const inChange = new Set(diff.target.commits.map((sha) => sha.toLowerCase()));
  const matched = local.filter((commit) => inChange.has(commit.sha.toLowerCase()));

  let run: Run | undefined;
  let runMissing: string | undefined;
  if (!opts.ledger) {
    runMissing = "no ledger";
  } else if (window) {
    run = await readRun(opts.ledger, root, diff.target.commits, matched, window, cwds);
    if (!run) runMissing = "no session in the ledger made or edited these commits";
  }

  const agent = diff.pullAgent ?? mainAgent(matched) ?? runAgent(run);
  return {
    target: diff.target,
    ...(repo ? { repo } : {}),
    ...(diff.pull ? { pull: diff.pull } : {}),
    subjects: diff.subjects,
    files: diff.files,
    manifests: diff.manifests,
    ...(diff.manifestProblem ? { manifestProblem: diff.manifestProblem } : {}),
    history: local,
    matched,
    ...(agent ? { agent } : {}),
    ...(run ? { run } : {}),
    ...(runMissing ? { runMissing } : {}),
  };
}

import type { AgentRef } from "@selfhost/attribution";
import type { Ledger } from "@selfhost/ledger";
import { isManifest } from "./dependencies.js";
import { parseHunks } from "./diff.js";
import { commitWindow, readRun, runAgent } from "./run.js";
import type { Change, ChangedFile, FileStatus, ManifestChange, Run } from "./types.js";

/** A file from GET /repos/{owner}/{repo}/pulls/{number}/files. */
export interface PullRequestFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  /** Absent for binary files and diffs too large for GitHub to return. */
  patch?: string;
}

/** A commit from GET /repos/{owner}/{repo}/pulls/{number}/commits. */
export interface PullRequestCommit {
  sha: string;
  commit: { message: string; author: { date?: string } | null };
}

/**
 * GitHub's REST API for one pull request, read only: through the developer's gh on a laptop,
 * through a GitHub App installation on the server.
 */
export interface PullRequestApi {
  /** Every page of the pull request's files, with their patches. */
  files(): Promise<PullRequestFile[]>;
  /** Every page of the pull request's commits, oldest first. */
  commits(): Promise<PullRequestCommit[]>;
  /** A file's text at a commit, or undefined when GitHub has none. */
  contents(path: string, ref: string): Promise<string | undefined>;
}

/** The changed files and the manifests, as both readers return them. */
export interface PullFiles {
  files: ChangedFile[];
  manifests: ManifestChange[];
  /** Why a manifest could not be read, when one could not. */
  manifestProblem?: string;
}

const PULL_STATUS: Record<string, FileStatus> = {
  added: "added",
  removed: "removed",
  renamed: "renamed",
};

/** Commit times, ISO 8601, for the commits that carry one. */
export const commitTimes = (commits: PullRequestCommit[]) =>
  commits
    .map((commit) => commit.commit.author?.date)
    .filter((time): time is string => typeof time === "string");

/**
 * The pull request's files with their hunks (parsed from each file's `patch`), and every
 * changed manifest's text at `base` and `head`. Contents are read for manifests only.
 */
export async function readPullFiles(
  api: Pick<PullRequestApi, "files" | "contents">,
  base: string,
  head: string,
): Promise<PullFiles> {
  const listed = await api.files();
  const files: ChangedFile[] = listed.map((file) => {
    const hunks =
      file.patch !== undefined
        ? parseHunks(file.patch)
        : file.additions + file.deletions === 0
          ? []
          : undefined;
    return {
      path: file.filename,
      ...(file.previous_filename ? { previousPath: file.previous_filename } : {}),
      additions: file.additions,
      deletions: file.deletions,
      status: PULL_STATUS[file.status] ?? "modified",
      ...(hunks ? { hunks } : {}),
    };
  });
  const manifests: ManifestChange[] = [];
  let manifestProblem: string | undefined;
  for (const file of listed.filter((f) => isManifest(f.filename))) {
    const before =
      file.status === "added"
        ? undefined
        : await api.contents(file.previous_filename ?? file.filename, base);
    const after = file.status === "removed" ? undefined : await api.contents(file.filename, head);
    if (
      (file.status !== "added" && before === undefined) ||
      (file.status !== "removed" && after === undefined)
    ) {
      manifestProblem = `could not read ${file.filename} from GitHub`;
    }
    manifests.push({
      path: file.filename,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    });
  }
  return { files, manifests, ...(manifestProblem ? { manifestProblem } : {}) };
}

export interface ReadPullRequestOptions {
  /** owner/name. */
  repo: string;
  /** What the webhook or the pull request endpoint says about it. */
  pull: {
    number: number;
    url: string;
    title: string;
    body?: string | null;
    /** Base and head commit SHAs. */
    base: string;
    head: string;
  };
  api: PullRequestApi;
  /** Where the agent runs are. Without it, there is no run. */
  ledger?: Pick<Ledger, "query">;
  /** The agent the pull request is attributed to, when the caller knows it. Default: the run's. */
  agent?: AgentRef;
}

/**
 * Reads a pull request from GitHub's API alone, with no clone: the files with their hunks, the
 * manifests at the base and head commits, the commits, and the agent run joined from the ledger
 * as `readChange` joins it (sessions with a `commit.created` event for one of its commits). With
 * no local git there is no attribution from history and no matching by file and time, so
 * `history` and `matched` are empty and `target.root` is absent. Never writes to GitHub.
 */
export async function readPullRequest(opts: ReadPullRequestOptions): Promise<Change> {
  const { pull, api } = opts;
  const [diff, commits] = await Promise.all([
    readPullFiles(api, pull.base, pull.head),
    api.commits(),
  ]);
  const shas = commits.map((commit) => commit.sha);

  let run: Run | undefined;
  let runMissing: string | undefined;
  const window = commitWindow(commitTimes(commits));
  if (!opts.ledger) {
    runMissing = "no ledger";
  } else if (window) {
    run = await readRun(opts.ledger, undefined, shas, [], window, new Map());
    if (!run) runMissing = "no session in the ledger made these commits";
  }

  const agent = opts.agent ?? runAgent(run);
  return {
    target: {
      pr: { repo: opts.repo, number: pull.number, url: pull.url },
      base: pull.base,
      head: pull.head,
      commits: shas,
    },
    repo: opts.repo,
    pull: { title: pull.title, ...(pull.body ? { body: pull.body } : {}) },
    subjects: commits.map((commit) => commit.commit.message.split("\n")[0] ?? ""),
    files: diff.files,
    manifests: diff.manifests,
    ...(diff.manifestProblem ? { manifestProblem: diff.manifestProblem } : {}),
    history: [],
    matched: [],
    ...(agent ? { agent } : {}),
    ...(run ? { run } : {}),
    ...(runMissing ? { runMissing } : {}),
  };
}

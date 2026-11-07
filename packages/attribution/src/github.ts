import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  GitHubCommit,
  GitHubPull,
  GitHubReview,
  GitHubReviewComment,
  GitHubSource,
  PullRef,
} from "./types.js";

const PAGE_SIZE = 100;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function defaultCacheDir(): string {
  return join(homedir(), ".selfhost", "cache", "github");
}

function runGh(args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile("gh", args, { maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return done(stdout);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        fail(new Error("gh is not installed; install the GitHub CLI and run `gh auth login`"));
      } else {
        fail(new Error(`gh ${args.join(" ")} failed: ${String(stderr).trim() || error.message}`));
      }
    });
  });
}

function checkRepo(repo: string) {
  if (!REPO.test(repo)) throw new Error(`Expected a repository as owner/name, got "${repo}"`);
}

/**
 * GitHub through the developer's own `gh` login (`gh api`). Pull request lists are always read
 * fresh; per pull request responses are cached in `cacheDir` under the pull request's
 * `updated_at`, which GitHub bumps on every push, review and comment, so a later scan only asks
 * for pull requests that changed.
 */
export function ghCliSource(
  opts: { cacheDir?: string; run?: (args: string[]) => Promise<string> } = {},
): GitHubSource {
  const run = opts.run ?? runGh;
  const cacheDir = opts.cacheDir ?? defaultCacheDir();

  const get = async <T>(path: string): Promise<T> => {
    const out = await run([
      "api",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      path,
    ]);
    try {
      return JSON.parse(out) as T;
    } catch {
      throw new Error(`gh api ${path} did not return JSON`);
    }
  };

  /** Every page of a list endpoint, stopping early when `more` says so. */
  const pages = async <T>(path: string, more: (page: T[]) => boolean = () => true) => {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const batch = await get<T[]>(`${path}${sep}per_page=${PAGE_SIZE}&page=${page}`);
      if (!Array.isArray(batch)) throw new Error(`gh api ${path} did not return a list`);
      items.push(...batch);
      if (batch.length < PAGE_SIZE || !more(batch)) return items;
    }
  };

  const cached = async <T>(repo: string, ref: PullRef, name: string, load: () => Promise<T>) => {
    checkRepo(repo);
    const dir = join(cacheDir, ...repo.split("/"), "pulls", String(ref.number));
    const file = join(dir, `${name}.json`);
    try {
      const entry = JSON.parse(await readFile(file, "utf8")) as { updatedAt: string; body: T };
      if (entry.updatedAt === ref.updatedAt) return entry.body;
    } catch {
      // Not cached yet, or unreadable: fetch it.
    }
    const body = await load();
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ updatedAt: ref.updatedAt, body }));
    await rename(tmp, file);
    return body;
  };

  return {
    async pulls(repo, since) {
      checkRepo(repo);
      const all = await pages<GitHubPull>(
        `repos/${repo}/pulls?state=all&sort=updated&direction=desc`,
        (page) => Date.parse(page[page.length - 1]?.updated_at ?? "") >= since.getTime(),
      );
      return all.filter((pull) => Date.parse(pull.updated_at) >= since.getTime());
    },
    pull: (repo, ref) =>
      cached(repo, ref, "pull", () => get<GitHubPull>(`repos/${repo}/pulls/${ref.number}`)),
    reviews: (repo, ref) =>
      cached(repo, ref, "reviews", () =>
        pages<GitHubReview>(`repos/${repo}/pulls/${ref.number}/reviews`),
      ),
    reviewComments: (repo, ref) =>
      cached(repo, ref, "comments", () =>
        pages<GitHubReviewComment>(`repos/${repo}/pulls/${ref.number}/comments`),
      ),
    commits: (repo, ref) =>
      cached(repo, ref, "commits", () =>
        pages<GitHubCommit>(`repos/${repo}/pulls/${ref.number}/commits`),
      ),
  };
}

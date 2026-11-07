import type { AgentRef } from "@selfhost/attribution";
import type { Octokit } from "@selfhost/github";
import type { Ledger } from "@selfhost/ledger";
import { type Change, type PullRequestApi, readPullRequest } from "@selfhost/pr";
import type { AgentPull } from "./github-pull.js";

/**
 * What the providers read about one pull request during one delivery. Each read is made at most
 * once, so the risk score, the owner and the brief share the files, the manifests and the run.
 * A new delivery starts with new reads.
 */
export interface PullReads extends PullRequestApi {
  /** The pull request read through the calls above, with its run joined from the ledger. */
  change(): Promise<Change>;
}

function once<T>(read: () => Promise<T>): () => Promise<T> {
  let result: Promise<T> | undefined;
  return () => {
    result ??= read();
    return result;
  };
}

/**
 * Reads through the App installation: one paginated call each for the files (with patches) and
 * the commits, and the contents of a file at a commit only when asked, which the readers do for
 * changed manifests alone.
 */
export function pullReads(
  octokit: Octokit,
  pull: AgentPull,
  agent: AgentRef,
  ledger: Pick<Ledger, "query">,
): PullReads {
  const where = { owner: pull.owner, repo: pull.repo };
  const contents = new Map<string, Promise<string | undefined>>();
  const fileAt = async (path: string, ref: string) => {
    try {
      const { data } = await octokit.rest.repos.getContent({
        ...where,
        path,
        ref,
        mediaType: { format: "raw" },
      });
      return typeof data === "string" ? data : undefined;
    } catch {
      return undefined;
    }
  };
  const reads: PullReads = {
    files: once(() =>
      octokit.paginate(octokit.rest.pulls.listFiles, {
        ...where,
        pull_number: pull.number,
        per_page: 100,
      }),
    ),
    commits: once(() =>
      octokit.paginate(octokit.rest.pulls.listCommits, {
        ...where,
        pull_number: pull.number,
        per_page: 100,
      }),
    ),
    contents(path, ref) {
      const key = `${ref}:${path}`;
      let read = contents.get(key);
      if (!read) {
        read = fileAt(path, ref);
        contents.set(key, read);
      }
      return read;
    },
    change: once(() =>
      readPullRequest({
        repo: `${pull.owner}/${pull.repo}`,
        pull: {
          number: pull.number,
          url: pull.url,
          title: pull.title,
          ...(pull.body ? { body: pull.body } : {}),
          base: pull.baseSha,
          head: pull.headSha,
        },
        api: reads,
        ledger,
        agent,
      }),
    ),
  };
  return reads;
}

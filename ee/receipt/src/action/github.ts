import type { CommitStatusInfo, DeploymentInfo } from "../preview.js";
import type { ChangedFile } from "../select.js";

/** The GitHub REST calls the receipt action makes, with the workflow's token. */
export interface GitHubApi {
  pullFiles(repo: string, number: number): Promise<ChangedFile[]>;
  deployments(repo: string, sha: string): Promise<DeploymentInfo[]>;
  statuses(repo: string, sha: string): Promise<CommitStatusInfo[]>;
  /** Edits the bot comment holding `marker`, or posts one. Returns the comment's URL. */
  upsertComment(repo: string, number: number, marker: string, body: string): Promise<string>;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** GitHub caps a pull request's file list at 3000 files, 100 a page. */
const MAX_FILE_PAGES = 30;

export function githubApi(token: string, baseUrl = "https://api.github.com"): GitHubApi {
  const api = baseUrl.replace(/\/+$/, "");
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${api}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "selfhost-receipt",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let message = text.slice(0, 200);
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? message;
      } catch {
        // Not JSON.
      }
      throw new GitHubError(response.status, `${method} ${path}: ${response.status} ${message}`);
    }
    return (await response.json()) as T;
  }

  return {
    async pullFiles(repo, number) {
      const files: ChangedFile[] = [];
      for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
        const batch = await call<
          { filename: string; status: string; previous_filename?: string }[]
        >("GET", `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
        for (const file of batch) {
          files.push({
            path: file.filename,
            status: file.status,
            ...(file.previous_filename ? { previousPath: file.previous_filename } : {}),
          });
        }
        if (batch.length < 100) break;
      }
      return files;
    },

    async deployments(repo, sha) {
      const list = await call<
        {
          id: number;
          environment: string;
          production_environment?: boolean;
          created_at: string;
          creator?: { login: string } | null;
        }[]
      >("GET", `/repos/${repo}/deployments?sha=${sha}&per_page=20`);
      return Promise.all(
        list.map(async (deployment) => {
          const statuses = await call<
            { state: string; environment_url?: string; target_url?: string }[]
          >("GET", `/repos/${repo}/deployments/${deployment.id}/statuses?per_page=5`);
          return {
            environment: deployment.environment,
            ...(deployment.production_environment === undefined
              ? {}
              : { production: deployment.production_environment }),
            ...(deployment.creator?.login ? { creator: deployment.creator.login } : {}),
            created_at: deployment.created_at,
            statuses: statuses.map((status) => ({
              state: status.state,
              ...(status.environment_url ? { environment_url: status.environment_url } : {}),
              ...(status.target_url ? { target_url: status.target_url } : {}),
            })),
          };
        }),
      );
    },

    async statuses(repo, sha) {
      const combined = await call<{
        statuses: { context: string; state: string; target_url?: string | null }[];
      }>("GET", `/repos/${repo}/commits/${sha}/status?per_page=100`);
      return combined.statuses.map((status) => ({
        context: status.context,
        state: status.state,
        ...(status.target_url ? { target_url: status.target_url } : {}),
      }));
    },

    async upsertComment(repo, number, marker, body) {
      let existing: { id: number; html_url: string } | undefined;
      for (let page = 1; !existing; page += 1) {
        const batch = await call<
          { id: number; html_url: string; body?: string; user?: { type?: string } | null }[]
        >("GET", `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
        existing = batch.find(
          (comment) => comment.user?.type === "Bot" && (comment.body ?? "").includes(marker),
        );
        if (batch.length < 100) break;
      }
      const comment = existing
        ? await call<{ html_url: string }>(
            "PATCH",
            `/repos/${repo}/issues/comments/${existing.id}`,
            { body },
          )
        : await call<{ html_url: string }>("POST", `/repos/${repo}/issues/${number}/comments`, {
            body,
          });
      return comment.html_url;
    },
  };
}

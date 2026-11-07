import { type AgentRef, webhookPullAgent } from "@selfhost/attribution";
import {
  createGitHubApp,
  type GitHubApp,
  githubAppEnv,
  type PullRequestEvent,
  type SyncResult,
  syncPullRequest,
} from "@selfhost/github";
import type { Ledger } from "@selfhost/ledger";
import { type ApiError, parseConfig, type ResolvedSelfhostConfig } from "@selfhost/schema";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AgentPull, desiredState, type GitHubProviders } from "./github-pull.js";
import { eeRisk } from "./github-risk.js";

export const GITHUB_WEBHOOK_PATH = "/v1/github/webhooks";

/** GitHub caps webhook payloads at 25 MB. */
const MAX_WEBHOOK_BYTES = 25 * 1024 * 1024;

/** pull_request actions that can change what an agent pull request should show. */
const PULL_ACTIONS = ["opened", "reopened", "synchronize", "labeled", "ready_for_review"] as const;

type HandledPullEvent = Extract<PullRequestEvent, { action: (typeof PULL_ACTIONS)[number] }>;

const isHandled = (payload: PullRequestEvent): payload is HandledPullEvent =>
  (PULL_ACTIONS as readonly string[]).includes(payload.action);

export interface GitHubRouteOptions {
  /** The GitHub App. Without it the webhook route answers 404. */
  app?: GitHubApp;
  /** The selfhost.toml whose [review] settings apply, read for every delivery. */
  config?: () => Promise<ResolvedSelfhostConfig>;
  /** Replaces the default risk, owner and brief providers. */
  providers?: Partial<GitHubProviders>;
  /** One line per handled delivery: ids, repository and counts, never payloads or secrets. */
  log?: (line: string) => void;
}

/** What POST /v1/github/webhooks answers to a verified delivery. */
export interface WebhookResponse {
  delivery: string;
  /** true when the delivery was for an agent pull request and was synced. */
  handled: boolean;
  /** Why a signed delivery was not acted on, shown in the App's delivery log on GitHub. */
  skipped?: string;
  /** true when this delivery id was already handled, so nothing was done. */
  duplicate?: boolean;
  /** How many changes the sync made on GitHub. */
  writes?: number;
}

const apiError = (code: string, message: string): ApiError => ({ error: { code, message } });

const DEFAULT_CONFIG = (() => {
  const parsed = parseConfig("version = 1\n");
  if (!parsed.ok) throw new Error("The built-in selfhost.toml defaults are invalid");
  return parsed.config;
})();

const DEFAULT_PROVIDERS: GitHubProviders = {
  risk: eeRisk(),
  owner: async () => undefined,
  brief: async () => undefined,
};

/** One line about an error, without request or response bodies. */
function errorLine(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const status = (error as { status?: unknown }).status;
  const first = error.message.split("\n")[0] ?? "";
  return `${error.name}${typeof status === "number" ? ` ${status}` : ""}: ${first}`;
}

/** The agent pull request a delivery is about, or why it is not acted on. */
function agentPull(
  event: string,
  payload: unknown,
): { pull: AgentPull; installation: number; agent: AgentRef } | { skip: string } {
  if (event !== "pull_request") return { skip: `${event} events are not handled` };
  const body = payload as PullRequestEvent;
  if (!isHandled(body)) return { skip: `action ${body.action} is not handled` };
  const pr = body.pull_request;
  if (!pr?.head || !body.repository) return { skip: "no pull request in the payload" };
  if (pr.state !== "open") return { skip: "the pull request is not open" };
  // The App's own label changes come back as labeled events; they change nothing.
  if (body.action === "labeled" && body.sender?.type === "Bot") {
    return { skip: "labeled by a bot" };
  }
  const installation = body.installation?.id;
  if (!installation) return { skip: "no App installation in the payload" };
  const found = webhookPullAgent({ user: pr.user, body: pr.body, head: { ref: pr.head.ref } });
  if (!found) return { skip: "not an agent pull request" };
  return {
    installation,
    agent: found.agent,
    pull: {
      owner: body.repository.owner.login,
      repo: body.repository.name,
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      headRef: pr.head.ref,
      author: pr.user?.login ?? "ghost",
      draft: pr.draft === true,
    },
  };
}

/** Runs one sync at a time per pull request, so two deliveries never race to create a run. */
function queue() {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const result = (tails.get(key) ?? Promise.resolve()).then(run);
    const tail = result.catch(() => {});
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}

/**
 * POST /v1/github/webhooks, for the selfhost GitHub App. It needs no bearer token: the
 * X-Hub-Signature-256 signature, checked with the App's webhook secret, is the credential.
 *
 * pull_request deliveries (opened, reopened, synchronize, ready_for_review, and labeled by a
 * person) on open agent pull requests sync the risk and agent labels, the selfhost/review check
 * run, the brief comment and the review request. Each X-GitHub-Delivery id is handled once: a
 * delivery that arrives again answers `duplicate: true` and touches nothing. A failed sync
 * forgets the id and answers 500, so a redelivery from GitHub runs it again. Everything else
 * that is signed answers 200 with `handled: false`.
 */
export function githubRoutes(app: Hono, ledger: Ledger, options: GitHubRouteOptions): void {
  const github = options.app;
  if (!github) {
    // Answered here, not by the bearer token check, so the route looks absent.
    app.post(GITHUB_WEBHOOK_PATH, (c) =>
      c.json(apiError("not_found", `No route for ${c.req.method} ${c.req.path}`), 404),
    );
    return;
  }
  const providers: GitHubProviders = { ...DEFAULT_PROVIDERS, ...options.providers };
  const config = options.config ?? (async () => DEFAULT_CONFIG);
  const log = options.log ?? console.log;
  const serial = queue();

  app.post(
    GITHUB_WEBHOOK_PATH,
    bodyLimit({
      maxSize: MAX_WEBHOOK_BYTES,
      onError: (c) =>
        c.json(apiError("payload_too_large", `Request body over ${MAX_WEBHOOK_BYTES} bytes`), 413),
    }),
    async (c) => {
      const delivery = c.req.header("x-github-delivery")?.trim();
      const event = c.req.header("x-github-event")?.trim();
      const body = await c.req.text();
      if (!delivery || !event) {
        return c.json(
          apiError("invalid_webhook", "Expected X-GitHub-Delivery and X-GitHub-Event headers"),
          400,
        );
      }
      if (!(await github.verify(body, c.req.header("x-hub-signature-256")))) {
        return c.json(
          apiError(
            "invalid_signature",
            "X-Hub-Signature-256 does not match the body under the App's webhook secret",
          ),
          401,
        );
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        return c.json(apiError("invalid_webhook", "Expected a JSON body"), 400);
      }

      const target = agentPull(event, payload);
      if ("skip" in target) {
        return c.json({ delivery, handled: false, skipped: target.skip } satisfies WebhookResponse);
      }
      if (!(await ledger.deliveries.claim(delivery, { event }))) {
        return c.json({ delivery, handled: false, duplicate: true } satisfies WebhookResponse);
      }

      const { pull, installation, agent } = target;
      const where = `${pull.owner}/${pull.repo}#${pull.number}`;
      let result: SyncResult;
      try {
        result = await serial(`${installation}/${where}`, async () => {
          const octokit = github.installation(installation);
          const desired = await desiredState(
            { octokit, pull, agent, config: await config() },
            providers,
          );
          return syncPullRequest(
            octokit,
            {
              owner: pull.owner,
              repo: pull.repo,
              number: pull.number,
              headSha: pull.headSha,
              author: pull.author,
            },
            desired,
          );
        });
      } catch (error) {
        await ledger.deliveries.release(delivery);
        log(`github: delivery ${delivery} for ${where} failed: ${errorLine(error)}`);
        return c.json(apiError("github_sync_failed", `Could not sync ${where} on GitHub`), 500);
      }
      const action = (payload as PullRequestEvent).action;
      log(
        `github: delivery ${delivery} ${event}.${action} ${where}: ${result.writes.length} changes`,
      );
      for (const refused of result.refused) {
        log(`github: ${where}: GitHub refused the review request: ${refused.message}`);
      }
      return c.json({
        delivery,
        handled: true,
        writes: result.writes.length,
      } satisfies WebhookResponse);
    },
  );
}

/**
 * The GitHub App from SELFHOST_GITHUB_APP_ID, SELFHOST_GITHUB_PRIVATE_KEY (or _FILE) and
 * SELFHOST_GITHUB_WEBHOOK_SECRET, or undefined when they are not all set. A partial setup is
 * reported by variable name.
 */
export function githubAppFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = console.log,
): GitHubApp | undefined {
  const found = githubAppEnv(env);
  if (!found.credentials) {
    if (found.missing.length < 3) {
      log(
        `GitHub App: ${found.missing.join(", ")} not set, so POST ${GITHUB_WEBHOOK_PATH} answers 404`,
      );
    }
    return undefined;
  }
  return createGitHubApp(found.credentials, { log });
}

/**
 * The selfhost.toml the GitHub delivery reads: the stored policy of SELFHOST_GITHUB_TEAM when
 * that is set and the team has one, else the server's defaults (SELFHOST_CONFIG).
 */
export function githubConfig(
  ledger: Ledger,
  defaults: ResolvedSelfhostConfig,
  team: string | undefined,
): () => Promise<ResolvedSelfhostConfig> {
  return async () => {
    if (!team) return defaults;
    const policy = await ledger.teams.getPolicy(team);
    if (!policy) return defaults;
    const parsed = parseConfig(policy.text);
    if (!parsed.ok) throw new Error(`The stored selfhost.toml of team ${team} is invalid`);
    return parsed.config;
  };
}

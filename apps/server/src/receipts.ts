import { webhookPullAgent } from "@selfhost/attribution";
import { type GitHubApp, syncComment } from "@selfhost/github";
import type { Ledger } from "@selfhost/ledger";
import { validateReceipt } from "@selfhost/schema";
import type { Hono } from "hono";
import { apiError } from "./access.js";
import { loadReceipt } from "./ee.js";
import {
  agentPullOf,
  errorLine,
  type PullRequestFields,
  type PullSync,
  pullKey,
} from "./github.js";
import { type ReceiptModule, receiptUrl } from "./github-review.js";
import { limit } from "./http.js";
import { githubOidc, type OidcVerifier } from "./oidc.js";

export const RECEIPTS_PATH = "/v1/receipts";

/** Receipts carry log tails of a few kilobytes each; screenshots stay in the CI artifact. */
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;

export interface ReceiptRouteOptions {
  /** The GitHub App. Without it POST /v1/receipts answers 404. */
  app?: GitHubApp;
  /** The webhook route's sync, so a receipt and a delivery for one pull request never race. */
  pulls?: PullSync;
  /** Checks the GitHub Actions OIDC token. Default: GitHub's issuer (SELFHOST_GITHUB_OIDC_ISSUER). */
  oidc?: OidcVerifier;
  /** This server's base URL as CI reaches it: the token's audience and the base of links. */
  publicUrl?: string;
  load?: () => Promise<ReceiptModule | undefined>;
  log?: (line: string) => void;
}

/** What POST /v1/receipts answers. */
export interface PostReceiptResponse {
  id: string;
  /** The stored receipt, GET with the admin token. */
  url: string;
  /** The receipt comment on the pull request. Absent for a receipt of an older commit. */
  comment_url?: string;
  /**
   * updated: the review brief links the receipt now. not_agent_pr: the pull request has no
   * brief. stale: the receipt is for a commit that is no longer the head, so it is only stored.
   */
  brief: "updated" | "not_agent_pr" | "stale";
}

const PULL_REF = /^refs\/pull\/(\d+)\//;

/**
 * POST /v1/receipts, for the receipt action in CI, and GET /v1/receipts/{id}.
 *
 * The POST takes no selfhost token. Its credential is the GitHub Actions OIDC token of the job
 * that made the receipt (`permissions: id-token: write`), with this server's URL as audience:
 * GitHub signs it and names the repository the workflow ran in, so no secret is stored in the
 * repository and a token works only for its own repository, for minutes. The receipt must be
 * for that repository (and, on a pull_request run, that pull request), and the selfhost GitHub
 * App must be installed there. Then the receipt is stored, posted as one comment on the pull
 * request (edited in place on the next run), and linked from the review brief of an agent pull
 * request. A receipt for a commit that is no longer the head is stored only.
 *
 * Register it before the admin token check; GET /v1/receipts/{id} goes after it.
 */
export function receiptRoutes(app: Hono, ledger: Ledger, options: ReceiptRouteOptions): void {
  const github = options.app;
  const log = options.log ?? console.log;
  const oidc =
    options.oidc ??
    githubOidc(
      process.env.SELFHOST_GITHUB_OIDC_ISSUER
        ? { issuer: process.env.SELFHOST_GITHUB_OIDC_ISSUER }
        : {},
    );
  const load = options.load ?? loadReceipt;
  let module: Promise<ReceiptModule | undefined> | undefined;

  app.post(RECEIPTS_PATH, limit(MAX_RECEIPT_BYTES), async (c) => {
    if (github) module ??= load();
    const receipts = module ? await module : undefined;
    if (!github || !receipts) {
      return c.json(apiError("not_found", `No route for ${c.req.method} ${c.req.path}`), 404);
    }
    const server = (options.publicUrl ?? new URL(c.req.url).origin).replace(/\/+$/, "");
    const bearer = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(c.req.header("authorization") ?? "")?.[1];
    if (!bearer) {
      c.header("WWW-Authenticate", 'Bearer realm="selfhost"');
      return c.json(
        apiError("unauthorized", "Expected the job's GitHub Actions OIDC token as the bearer"),
        401,
      );
    }
    const verified = await oidc.verify(bearer, server);
    if (!verified.ok) {
      c.header("WWW-Authenticate", 'Bearer realm="selfhost"');
      return c.json(
        apiError("unauthorized", `The GitHub Actions OIDC token: ${verified.reason}`),
        401,
      );
    }
    const { claims } = verified;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(apiError("invalid_request", "Expected a JSON body"), 400);
    }
    const parsed = validateReceipt(body);
    if (!parsed.ok) {
      const [first] = parsed.errors;
      return c.json(apiError("invalid_request", `${first?.field}: ${first?.message}`), 400);
    }
    const receipt = parsed.value;
    if (receipt.repo.toLowerCase() !== claims.repository.toLowerCase()) {
      return c.json(
        apiError(
          "forbidden",
          `The token is for ${claims.repository}, not ${receipt.repo}: a workflow posts receipts only for its own repository`,
        ),
        403,
      );
    }
    const refPull = PULL_REF.exec(claims.ref ?? "")?.[1];
    if (refPull && Number(refPull) !== receipt.pull.number) {
      return c.json(
        apiError(
          "forbidden",
          `The token is for pull request #${refPull}, not #${receipt.pull.number}`,
        ),
        403,
      );
    }

    const [owner = "", repo = ""] = receipt.repo.split("/");
    const where = pullKey({ owner, repo, number: receipt.pull.number });
    let installation: number | undefined;
    let pr: PullRequestFields & { state: string };
    try {
      installation = await github.repoInstallation(owner, repo);
      if (installation === undefined) {
        return c.json(
          apiError("forbidden", `The selfhost GitHub App is not installed on ${receipt.repo}`),
          403,
        );
      }
      const { data } = await github
        .installation(installation)
        .rest.pulls.get({ owner, repo, pull_number: receipt.pull.number });
      pr = data as PullRequestFields & { state: string };
    } catch (error) {
      if ((error as { status?: number }).status === 404) {
        return c.json(apiError("not_found", `No pull request ${where}`), 404);
      }
      log(`receipts: reading ${where} failed: ${errorLine(error)}`);
      return c.json(apiError("github_failed", `Could not read ${where} on GitHub`), 502);
    }

    const stored = await ledger.receipts.add(receipt);
    const url = receiptUrl(server, stored.id);
    if (pr.head.sha.toLowerCase() !== receipt.pull.head_sha.toLowerCase()) {
      log(`receipts: ${where}: stored ${stored.id} for ${receipt.pull.head_sha}, not the head`);
      return c.json({ id: stored.id, url, brief: "stale" } satisfies PostReceiptResponse, 202);
    }

    const agent = webhookPullAgent({ user: pr.user, body: pr.body, head: { ref: pr.head.ref } });
    const pulls = options.pulls;
    const at = installation;
    // The receipt comment first, so the brief synced after it can link the comment.
    const attach = async (): Promise<{ comment: string; brief: PostReceiptResponse["brief"] }> => {
      const comment = await syncComment(
        github.installation(at),
        { owner, repo, number: receipt.pull.number },
        {
          body: receipts.renderReceipt(receipt, { receiptUrl: url }),
          marker: receipts.RECEIPT_MARKER,
        },
      );
      await ledger.receipts.setComment(stored.id, comment.url);
      if (!agent || pr.state !== "open" || !pulls) {
        return { comment: comment.url, brief: "not_agent_pr" };
      }
      await pulls.sync(at, agentPullOf(owner, repo, pr), agent.agent, server);
      return { comment: comment.url, brief: "updated" };
    };
    try {
      const posted = await (pulls ? pulls.serial(at, where, attach) : attach());
      log(`receipts: ${where}: ${receipt.verdict}, stored ${stored.id}, brief ${posted.brief}`);
      return c.json(
        {
          id: stored.id,
          url,
          comment_url: posted.comment,
          brief: posted.brief,
        } satisfies PostReceiptResponse,
        201,
      );
    } catch (error) {
      log(`receipts: ${where}: posting ${stored.id} failed: ${errorLine(error)}`);
      return c.json(apiError("github_failed", `Could not post the receipt on ${where}`), 502);
    }
  });
}

/** GET /v1/receipts/{id}: the stored receipt, with the comment it was posted as. */
export function receiptReadRoutes(app: Hono, ledger: Ledger): void {
  app.get(`${RECEIPTS_PATH}/:id`, async (c) => {
    const stored = await ledger.receipts.get(c.req.param("id"));
    if (!stored) return c.json(apiError("not_found", "No such receipt"), 404);
    return c.json(stored);
  });
}

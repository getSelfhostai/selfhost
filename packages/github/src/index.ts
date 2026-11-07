import type { EmitterWebhookEvent } from "@octokit/webhooks";

export type { Octokit } from "@octokit/rest";
export {
  createGitHubApp,
  GITHUB_APP_ENV,
  type GitHubApp,
  type GitHubAppCredentials,
  type GitHubAppEnv,
  type GitHubAppOptions,
  githubAppEnv,
} from "./app.js";
export {
  AGENT_LABEL_PREFIX,
  agentLabel,
  isManagedLabel,
  RISK_LABEL_PREFIX,
  RISK_LEVELS,
  type RiskLevel,
  riskLabel,
} from "./labels.js";
export {
  briefBody,
  type CheckConclusion,
  checkExternalId,
  type DesiredCheck,
  type DesiredState,
  MAX_CHECK_OUTPUT,
  MAX_COMMENT_BODY,
  type PullRequestRef,
  REVIEW_CHECK_NAME,
  type RefusedReviewRequest,
  type SyncResult,
  type SyncWrite,
  syncPullRequest,
} from "./sync.js";

/** A `pull_request` webhook payload, typed by @octokit/webhooks. */
export type PullRequestEvent = EmitterWebhookEvent<"pull_request">["payload"];

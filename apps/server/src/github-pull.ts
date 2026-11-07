import type { AgentRef } from "@selfhost/attribution";
import {
  type CheckConclusion,
  type DesiredState,
  type Octokit,
  REVIEW_CHECK_NAME,
  type RiskLevel,
} from "@selfhost/github";
import type { ResolvedSelfhostConfig } from "@selfhost/schema";
import type { PullReads } from "./github-reads.js";

/** An open agent pull request, from the webhook that announced it. */
export interface AgentPull {
  owner: string;
  repo: string;
  number: number;
  title: string;
  /** The description, when it has one. */
  body?: string;
  url: string;
  headSha: string;
  baseSha: string;
  headRef: string;
  /** Login that opened it. */
  author: string;
  draft: boolean;
}

/** What every provider is given. `octokit` acts as the App installation on this repository. */
export interface PullContext {
  octokit: Octokit;
  pull: AgentPull;
  agent: AgentRef;
  config: ResolvedSelfhostConfig;
  /** GitHub and ledger reads for this delivery, each made once and shared by the providers. */
  reads: PullReads;
  /** This server's base URL as people reach it, for links back to it such as trace links. */
  server: string;
}

/** A risk level, with the check run text that explains it. */
export interface RiskAssessment {
  level: RiskLevel;
  /** Such as "High risk (score 72)". */
  title?: string;
  /** One paragraph for the check run summary. */
  summary?: string;
  /** Markdown for the check run details. */
  text?: string;
}

/** The review brief: posted as one comment, found again by `marker`, summarized in the check. */
export interface ReviewBrief {
  /** Markdown, with `marker` (a hidden HTML comment such as `<!-- selfhost:brief v1 -->`). */
  body: string;
  marker: string;
  /** One paragraph for the check run summary. Default: the check names the agent instead. */
  summary?: string;
}

/** Where the GitHub delivery gets what it shows. Each one is a seam tests can replace. */
export interface GitHubProviders {
  /** Default: the ee risk score when this build has ee/, else none and no risk label. */
  risk(ctx: PullContext): Promise<RiskAssessment | undefined>;
  /**
   * The selfhost person id the review list routes the pull request to, such as a git email.
   * Default: the owner of its `pr` review item, else `routeItem` on its files. None sends the
   * request to `[review] github_team`.
   */
  owner(ctx: PullContext & { risk?: RiskAssessment }): Promise<string | undefined>;
  /** Default: the review brief built from GitHub and the ledger. None posts no comment. */
  brief(
    ctx: PullContext & { risk?: RiskAssessment; owner?: string },
  ): Promise<ReviewBrief | undefined>;
}

/** Who is asked to review, and why, in words the check run can show. */
export interface ReviewerChoice {
  users: string[];
  teams: string[];
  /** One sentence for the check summary. Names GitHub accounts only, never person ids. */
  note: string;
}

const LEVEL_NAMES: Record<RiskLevel, string> = { low: "Low", medium: "Medium", high: "High" };

/** The login `[review] github_logins` maps a person to, with the key compared ignoring case. */
export function githubLogin(logins: Record<string, string>, person: string): string | undefined {
  if (logins[person]) return logins[person];
  const wanted = person.toLowerCase();
  return Object.entries(logins).find(([key]) => key.toLowerCase() === wanted)?.[1];
}

/**
 * The owner's GitHub login when `[review] github_logins` has one, else `[review] github_team`.
 * The pull request's author cannot review their own pull request, so the team gets it then too.
 */
export function chooseReviewers(
  owner: string | undefined,
  pull: Pick<AgentPull, "owner" | "author">,
  review: ResolvedSelfhostConfig["review"],
): ReviewerChoice {
  const login = owner ? githubLogin(review.github_logins, owner) : undefined;
  if (login && login.toLowerCase() !== pull.author.toLowerCase()) {
    return { users: [login], teams: [], note: `Review requested from @${login}.` };
  }
  const why = !owner
    ? "No owner was picked"
    : login
      ? "The owner opened this pull request"
      : "The owner has no GitHub login in [review] github_logins";
  if (review.github_team) {
    return {
      users: [],
      teams: [review.github_team],
      note: `${why}, so review is requested from @${pull.owner}/${review.github_team}.`,
    };
  }
  return { users: [], teams: [], note: `${why} and [review] github_team is not set.` };
}

/** `failure` only on high risk with `[review] block_merge_on_high`; `neutral` passes otherwise. */
export function checkConclusion(
  risk: RiskAssessment | undefined,
  review: ResolvedSelfhostConfig["review"],
): CheckConclusion {
  return risk?.level === "high" && review.block_merge_on_high ? "failure" : "neutral";
}

function mergeNote(risk: RiskAssessment | undefined, conclusion: CheckConclusion): string {
  if (risk?.level !== "high") return "";
  return conclusion === "failure"
    ? ` High risk fails this check ([review] block_merge_on_high), which blocks the merge when ${REVIEW_CHECK_NAME} is a required check.`
    : ` High risk does not fail this check; set [review] block_merge_on_high = true and make ${REVIEW_CHECK_NAME} a required check to block the merge.`;
}

const agentName = (agent: AgentRef) =>
  agent.model ? `${agent.vendor} (${agent.model})` : agent.vendor;

/**
 * Everything the pull request should show, from the providers: the risk and agent labels, the
 * check run with the brief's summary and the risk details, the brief comment and the review
 * request. Draft pull requests get no review request until they are ready.
 */
export async function desiredState(
  ctx: PullContext,
  providers: GitHubProviders,
): Promise<DesiredState> {
  const { pull, agent, config } = ctx;
  const risk = await providers.risk(ctx);
  const owner = await providers.owner({ ...ctx, risk });
  const brief = await providers.brief({ ...ctx, risk, owner });
  const reviewers = chooseReviewers(owner, pull, config.review);
  const conclusion = checkConclusion(risk, config.review);

  const lead = brief?.summary ?? `Pull request by ${agentName(agent)}, opened by @${pull.author}.`;
  const summary = [
    lead,
    ...(risk?.summary ? [risk.summary] : []),
    `${pull.draft ? "Draft: no review is requested until it is ready." : reviewers.note}${mergeNote(risk, conclusion)}`,
  ].join("\n\n");
  const briefText = brief?.body.replaceAll(brief.marker, "").trim();
  const text = [
    ...(briefText ? [briefText] : []),
    ...(risk?.text ? [risk.text] : []),
    `Agent: ${agentName(agent)}. Head commit: ${pull.headSha}.`,
  ].join("\n\n");

  return {
    labels: { ...(risk ? { risk: risk.level } : {}), agent: agent.vendor },
    check: {
      title: risk ? (risk.title ?? `${LEVEL_NAMES[risk.level]} risk`) : "Not scored",
      summary,
      text,
      conclusion,
    },
    ...(pull.draft ? {} : { reviewers: { users: reviewers.users, teams: reviewers.teams } }),
    ...(brief ? { brief: { body: brief.body, marker: brief.marker } } : {}),
  };
}

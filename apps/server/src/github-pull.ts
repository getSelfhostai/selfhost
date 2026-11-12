import type { AgentRef } from "@selfhost/attribution";
import {
  type CheckConclusion,
  type DesiredState,
  type Octokit,
  REVIEW_CHECK_NAME,
  type ReviewRequestOutcome,
  type RiskLevel,
} from "@selfhost/github";
import type { ResolvedSelfhostConfig, ReviewRoute } from "@selfhost/schema";
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
  /** 0 to 100, when the score is known. Auto-approve needs it. */
  score?: number;
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

/**
 * What `[review.auto_approve]` decided for this head commit, as the check run shows it. Nothing
 * is written by deciding: the approval goes out with the rest of the sync, and the decision log
 * entry after it.
 */
export interface AutoApproval {
  /** Every check passed: approve, or in dry run only record that it would have. */
  eligible: boolean;
  dryRun: boolean;
  /** Why it may be approved, for the decision log. */
  reasons: string[];
  /** One line for the check run summary. */
  summary: string;
  /** Markdown for the check run details. */
  text?: string;
  /** The approving review to post, when eligible and not in dry run. */
  approve?: { body: string; marker: string };
  /** Changed files, for the decision's paths. */
  files: string[];
  /** The pull request's open review item, closed as approved once the approval is recorded. */
  itemId?: string;
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
  /**
   * The route the review list picked, for the GitHub accounts it names (`@` targets and
   * CODEOWNERS), asked to review besides the owner. Default: none without [[review.routes]].
   */
  route(ctx: PullContext & { risk?: RiskAssessment }): Promise<ReviewRoute | undefined>;
  /** Default: [review.auto_approve] with ee/risk; none while it is off. */
  autoApprove(ctx: PullContext & { risk?: RiskAssessment }): Promise<AutoApproval | undefined>;
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
 * The owner's GitHub login when `[review] github_logins` has one, and the GitHub accounts the
 * route names, else `[review] github_team`. The pull request's author cannot review their own
 * pull request, so they are left out, and the team gets it when nobody is left.
 */
export function chooseReviewers(
  owner: string | undefined,
  pull: Pick<AgentPull, "owner" | "author">,
  review: ResolvedSelfhostConfig["review"],
  route?: Pick<ReviewRoute, "github" | "id">,
): ReviewerChoice {
  const author = pull.author.toLowerCase();
  const login = owner ? githubLogin(review.github_logins, owner) : undefined;
  const users = [...new Set([...(login ? [login] : []), ...(route?.github?.users ?? [])])].filter(
    (user) => user.toLowerCase() !== author,
  );
  const teams = route?.github?.teams ?? [];
  if (users.length > 0 || teams.length > 0) {
    const named = [...users.map((user) => `@${user}`), ...teams.map((t) => `@${pull.owner}/${t}`)];
    const via = route?.id && route.github ? ` ([[review.routes]] ${JSON.stringify(route.id)})` : "";
    return { users, teams, note: `Review requested from ${named.join(", ")}${via}.` };
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

/**
 * The check's review sentence after the request, from what GitHub kept: the choice's own note
 * when it kept everything, else who has a request and who GitHub accepted but did not keep (a
 * team without access to the repository, a login that is not a collaborator) or refused.
 */
export function requestNote(
  choice: ReviewerChoice,
  pull: Pick<AgentPull, "owner">,
  outcome: ReviewRequestOutcome | undefined,
): string {
  if (!outcome) return choice.note;
  const named = (who: { users: string[]; teams: string[] }) => [
    ...who.users.map((user) => `@${user}`),
    ...who.teams.map((team) => `@${pull.owner}/${team}`),
  ];
  const lost = named(outcome.dropped);
  const refused = outcome.refused ? named(outcome.refused) : [];
  if (lost.length === 0 && refused.length === 0) return choice.note;
  const kept = named(outcome.requested);
  return [
    kept.length > 0
      ? `Review requested from ${kept.join(", ")}.`
      : "No review is requested on GitHub.",
    ...(lost.length > 0
      ? [
          `GitHub accepted the review request for ${lost.join(", ")} but did not keep it (a team needs access to this repository, a person must be a collaborator), so it is not asked again.`,
        ]
      : []),
    ...(refused.length > 0
      ? [`GitHub refused the review request for ${refused.join(", ")}: ${outcome.refused?.message}`]
      : []),
  ].join(" ");
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
 * check run with the brief's summary, the risk details and what auto-approve decided, the brief
 * comment, the review request and, when auto-approve approves, the approving review. Draft pull
 * requests get no review request until they are ready.
 */
export async function desiredPull(
  ctx: PullContext,
  providers: GitHubProviders,
): Promise<{
  desired: DesiredState;
  autoApproval?: AutoApproval;
  risk?: RiskAssessment;
  /** Who is asked to review, when anyone is (not on a draft). */
  reviewers?: ReviewerChoice;
  /** The check summary with another review sentence, such as what GitHub kept. */
  summaryWith: (note: string) => string;
}> {
  const { pull, agent, config } = ctx;
  const risk = await providers.risk(ctx);
  const owner = await providers.owner({ ...ctx, risk });
  const brief = await providers.brief({ ...ctx, risk, owner });
  const route = await providers.route({ ...ctx, risk });
  const autoApproval = await providers.autoApprove({ ...ctx, risk });
  const reviewers = chooseReviewers(owner, pull, config.review, route);
  const conclusion = checkConclusion(risk, config.review);

  const lead = brief?.summary ?? `Pull request by ${agentName(agent)}, opened by @${pull.author}.`;
  const summaryWith = (note: string) =>
    [
      lead,
      ...(risk?.summary ? [risk.summary] : []),
      `${pull.draft ? "Draft: no review is requested until it is ready." : note}${mergeNote(risk, conclusion)}`,
      ...(autoApproval ? [autoApproval.summary] : []),
    ].join("\n\n");
  const summary = summaryWith(reviewers.note);
  const briefText = brief?.body.replaceAll(brief.marker, "").trim();
  const text = [
    ...(briefText ? [briefText] : []),
    ...(risk?.text ? [risk.text] : []),
    ...(autoApproval?.text ? [autoApproval.text] : []),
    `Agent: ${agentName(agent)}. Head commit: ${pull.headSha}.`,
  ].join("\n\n");

  const desired: DesiredState = {
    labels: { ...(risk ? { risk: risk.level } : {}), agent: agent.vendor },
    check: {
      title: risk ? (risk.title ?? `${LEVEL_NAMES[risk.level]} risk`) : "Not scored",
      summary,
      text,
      conclusion,
    },
    ...(pull.draft ? {} : { reviewers: { users: reviewers.users, teams: reviewers.teams } }),
    ...(brief ? { brief: { body: brief.body, marker: brief.marker } } : {}),
    ...(autoApproval?.approve ? { approve: autoApproval.approve } : {}),
  };
  return {
    desired,
    ...(autoApproval ? { autoApproval } : {}),
    ...(risk ? { risk } : {}),
    ...(pull.draft ? {} : { reviewers }),
    summaryWith,
  };
}

/** What the pull request should show; see desiredPull. */
export async function desiredState(
  ctx: PullContext,
  providers: GitHubProviders,
): Promise<DesiredState> {
  return (await desiredPull(ctx, providers)).desired;
}

import {
  FINDING_SEVERITIES,
  type FindingSeverity,
  REVIEWER_TOOLS,
  type ReviewerTool,
  SECOND_OPINION_VERDICTS,
  type SecondOpinionData,
  type SecondOpinionVerdict,
} from "@selfhost/schema";
import { CODERABBIT_BOT } from "../adapters/coderabbit.js";
import { SECOND_OPINION_MARKER } from "./marker.js";
import { REVIEWER_JOB_NAMES } from "./setup.js";

/**
 * Reads what PR-Agent, the Claude Code GitHub Action and CodeRabbit post on a pull request back
 * from the GitHub App's webhooks, as one normalized verdict. selfhost reviews nothing itself.
 */

interface User {
  login: string;
  type?: string;
}

/** The pull request fields the server needs, as pull_request_review payloads carry them. */
export interface ReviewedPull {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state?: string;
  draft?: boolean;
  user: User | null;
  head: { sha: string; ref: string };
  base: { sha: string };
}

/** One reviewer verdict a webhook delivery carries. */
export interface ReviewerDelivery {
  opinion: SecondOpinionData;
  /** GitHub's id for what was posted, so a redelivery records nothing new. */
  key: string;
  /** When it was posted or last edited. */
  at: string;
  /** owner/name. */
  repo: string;
  owner: string;
  name: string;
  number: number;
  /** The pull request URL, when the payload has it. */
  url?: string;
  /** The whole pull request, when the payload has it; otherwise read it by number. */
  pull?: ReviewedPull;
  installation?: number;
  /** A CodeRabbit review: its inline comments carry the severities. */
  coderabbitReview?: number;
}

export type ReviewerParse = { delivery: ReviewerDelivery } | { skip: string };

/** Events that can carry a reviewer's verdict. */
export const REVIEWER_EVENTS = ["pull_request_review", "issue_comment", "check_run"] as const;

const RANK = (severity: FindingSeverity) => FINDING_SEVERITIES.indexOf(severity);

/** The higher of two severities. */
export function higherSeverity(
  a: FindingSeverity | undefined,
  b: FindingSeverity | undefined,
): FindingSeverity | undefined {
  if (!a) return b;
  if (!b) return a;
  return RANK(a) <= RANK(b) ? a : b;
}

const isBot = (user: User | null | undefined): user is User =>
  !!user && (user.type === "Bot" || user.login.toLowerCase().endsWith("[bot]"));

const iso = (ts: string) => new Date(ts).toISOString();

const MARKER_LINE = new RegExp(`<!--\\s*${SECOND_OPINION_MARKER}\\s+([^>]*?)\\s*-->`, "g");

/**
 * The verdict a reviewer wrote on the selfhost marker line, the last one when it wrote more than
 * one. Lenient about order and case, strict about values: an unknown tool or verdict is no line.
 */
export function markerOpinion(
  body: string,
): Pick<SecondOpinionData, "tool" | "verdict" | "findings" | "severity"> | undefined {
  const lines = [...body.matchAll(MARKER_LINE)];
  const last = lines.at(-1)?.[1];
  if (last === undefined) return undefined;
  const fields = new Map<string, string>();
  for (const pair of last.split(/\s+/)) {
    const at = pair.indexOf("=");
    if (at > 0) fields.set(pair.slice(0, at).toLowerCase(), pair.slice(at + 1).toLowerCase());
  }
  const tool = fields.get("tool");
  const verdict = fields.get("verdict");
  if (!(REVIEWER_TOOLS as readonly string[]).includes(tool ?? "")) return undefined;
  if (!(SECOND_OPINION_VERDICTS as readonly string[]).includes(verdict ?? "")) return undefined;
  const findings = Number(fields.get("findings"));
  const severity = fields.get("severity");
  return {
    tool: tool as ReviewerTool,
    verdict: verdict as SecondOpinionVerdict,
    ...(Number.isInteger(findings) && findings >= 0 ? { findings } : {}),
    ...((FINDING_SEVERITIES as readonly string[]).includes(severity ?? "")
      ? { severity: severity as FindingSeverity }
      : {}),
  };
}

/** PR-Agent's review comment, by its hidden identity or its heading. */
const PR_AGENT_REVIEW =
  /<!--\s*pr-agent:review:(?:full|incremental)\s*-->|\[pr-agent:review:(?:full|incremental)\]:|PR Reviewer Guide/i;

const MERGE_RECOMMENDATIONS: Record<string, SecondOpinionVerdict> = {
  "no concerns found": "approve",
  "needs review": "comment",
  "changes required": "changes",
};

/** Text between `start` and the next table cell end or heading. */
function section(body: string, start: RegExp): string | undefined {
  const found = start.exec(body);
  if (!found) return undefined;
  const rest = body.slice(found.index + found[0].length);
  const end = rest.search(/<\/td><\/tr>|\n#{2,3} /);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * PR-Agent's /review comment (pr_reviewer in its configuration): the merge recommendation is the
 * verdict, the issues under "Recommended focus areas for review" plus a security concern are the
 * findings, and the risk level (high with a security concern) is the severity. selfhost review
 * setup turns the recommendation and the risk level on; without the recommendation a review is a
 * comment. A comment with none of these (PR-Agent's "Preparing review..." placeholder) is none.
 */
export function prAgentOpinion(
  body: string,
): Pick<SecondOpinionData, "verdict" | "findings" | "severity"> | undefined {
  if (!PR_AGENT_REVIEW.test(body)) return undefined;
  const recommendation = /Merge recommendation(?:<\/strong>)?:\s*([A-Za-z ]+?)\s*(?:<|\n|$)/i.exec(
    body,
  )?.[1];
  const verdict = recommendation ? MERGE_RECOMMENDATIONS[recommendation.toLowerCase()] : undefined;
  const clean = /No major issues detected/i.test(body);
  const focus = section(body, /Recommended focus areas for review(?:<\/strong>)?/i);
  if (!verdict && !clean && focus === undefined) return undefined;
  const issues = focus
    ? (focus.match(/<strong>/g)?.length ?? 0) || (focus.match(/^\s*\[?\*\*/gm)?.length ?? 0)
    : 0;
  const security = /Security concerns(?:<\/strong>|\n)/.test(body);
  const risk = /Risk level(?:<\/strong>)?:\s*(low|medium|high)\b/i.exec(body)?.[1]?.toLowerCase() as
    | FindingSeverity
    | undefined;
  const findings = issues + (security ? 1 : 0);
  const severity = higherSeverity(findings > 0 ? risk : undefined, security ? "high" : undefined);
  return {
    verdict: verdict ?? "comment",
    findings,
    ...(severity ? { severity } : {}),
  };
}

/** CodeRabbit's severity labels on a finding, highest first, and its older finding types. */
const CODERABBIT_SEVERITIES: [RegExp, FindingSeverity][] = [
  [/🔴\s*Critical/, "critical"],
  [/🟠\s*Major/, "high"],
  [/🟡\s*Minor/, "medium"],
  [/🔵\s*Trivial/, "low"],
  [/_⚠️ Potential issue_/, "medium"],
  [/_🛠️ Refactor suggestion_/, "low"],
];

/** The highest severity CodeRabbit gave any of its findings in these texts. */
export function coderabbitSeverity(texts: readonly string[]): FindingSeverity | undefined {
  let highest: FindingSeverity | undefined;
  for (const text of texts) {
    for (const [pattern, severity] of CODERABBIT_SEVERITIES) {
      if (pattern.test(text)) highest = higherSeverity(highest, severity);
    }
  }
  return highest;
}

/**
 * A CodeRabbit review body without its nitpick section, which is style: its labels count toward
 * neither the findings nor the severity. The section is a details block holding one details
 * block per file, so it ends where two blocks close in a row.
 */
const withoutNitpicks = (body: string) =>
  body.replace(
    /<summary>[^<]*Nitpick comments[\s\S]*?(?:<\/blockquote><\/details>\s*<\/blockquote><\/details>|$)/gi,
    "",
  );

const REVIEW_STATES: Record<string, SecondOpinionVerdict> = {
  approved: "approve",
  changes_requested: "changes",
  commented: "comment",
};

/**
 * A CodeRabbit review: the review state is the verdict; "Actionable comments posted: N" plus the
 * comments outside the diff are the findings (nitpicks are style and are left out); severity
 * comes from the labels in the body, and from its inline comments when the server reads them.
 */
export function coderabbitOpinion(
  state: string,
  body: string,
): Pick<SecondOpinionData, "verdict" | "findings" | "severity"> | undefined {
  const verdict = REVIEW_STATES[state.toLowerCase()];
  if (!verdict) return undefined;
  const actionable = /Actionable comments posted:\s*(\d+)/i.exec(body)?.[1];
  const outside = /Outside diff range comments\s*\((\d+)\)/i.exec(body)?.[1];
  const findings =
    actionable === undefined && outside === undefined
      ? verdict === "approve"
        ? 0
        : undefined
      : Number(actionable ?? 0) + Number(outside ?? 0);
  const severity = coderabbitSeverity([withoutNitpicks(body)]);
  return {
    verdict,
    ...(findings !== undefined ? { findings } : {}),
    ...(severity ? { severity } : {}),
  };
}

interface Repository {
  name: string;
  full_name: string;
  html_url: string;
  owner: { login: string };
}

interface ReviewPayload {
  action: string;
  review: {
    id: number;
    user: User | null;
    body: string | null;
    state: string;
    html_url?: string;
    submitted_at: string | null;
    commit_id?: string | null;
  };
  pull_request: ReviewedPull;
  repository: Repository;
  installation?: { id: number };
}

interface CommentPayload {
  action: string;
  comment: {
    id: number;
    user: User | null;
    body: string | null;
    html_url?: string;
    created_at: string;
    updated_at?: string;
  };
  issue: { number: number; pull_request?: { html_url?: string } | null };
  repository: Repository;
  installation?: { id: number };
}

interface CheckRunPayload {
  action: string;
  check_run: {
    id: number;
    name: string;
    head_sha: string;
    html_url?: string;
    conclusion: string | null;
    completed_at: string | null;
    app?: { slug?: string } | null;
    pull_requests?: { number: number }[];
  };
  repository: Repository;
  installation?: { id: number };
}

const record = (value: unknown) =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;

function shaped<T>(payload: unknown, keys: string[]): T | undefined {
  const body = record(payload);
  if (!body) return undefined;
  return [...keys, "repository"].every((key) => record(body[key])) ? (payload as T) : undefined;
}

const SHA = /^[0-9a-f]{7,64}$/;

function base(repository: Repository, installation: { id: number } | undefined) {
  return {
    repo: repository.full_name,
    owner: repository.owner.login,
    name: repository.name,
    ...(installation?.id ? { installation: installation.id } : {}),
  };
}

function fromReview(payload: ReviewPayload): ReviewerParse {
  const { review, pull_request: pull } = payload;
  if (payload.action !== "submitted") return { skip: `review ${payload.action} is not a verdict` };
  if (!isBot(review.user)) return { skip: "the review is not from a reviewer bot" };
  if (!review.submitted_at) return { skip: "the review has no submitted time" };
  const body = review.body ?? "";
  const login = review.user.login;
  const marked = markerOpinion(body);
  let opinion: Pick<SecondOpinionData, "tool" | "verdict" | "findings" | "severity"> | undefined;
  if (marked) {
    opinion = marked;
  } else if (login.toLowerCase() === CODERABBIT_BOT) {
    const found = coderabbitOpinion(review.state, body);
    if (found) opinion = { tool: "coderabbit", ...found };
  }
  if (!opinion) return { skip: `a review by ${login} is not a reviewer's verdict` };
  const sha = review.commit_id?.toLowerCase();
  return {
    delivery: {
      opinion: {
        ...opinion,
        reviewer: login,
        ...(review.html_url ? { url: review.html_url } : {}),
        ...(sha && SHA.test(sha) ? { head_sha: sha } : {}),
      },
      key: `pull_request_review:${review.id}`,
      at: iso(review.submitted_at),
      ...base(payload.repository, payload.installation),
      number: pull.number,
      url: pull.html_url,
      pull,
      ...(opinion.tool === "coderabbit" ? { coderabbitReview: review.id } : {}),
    },
  };
}

function fromComment(payload: CommentPayload): ReviewerParse {
  const { comment, issue } = payload;
  if (payload.action !== "created" && payload.action !== "edited") {
    return { skip: `comment ${payload.action} is not a verdict` };
  }
  if (!issue.pull_request) return { skip: "the comment is not on a pull request" };
  if (!isBot(comment.user)) return { skip: "the comment is not from a reviewer bot" };
  const body = comment.body ?? "";
  const login = comment.user.login;
  const marked = markerOpinion(body);
  const prAgent = marked ? undefined : prAgentOpinion(body);
  const opinion = marked ?? (prAgent ? { tool: "pr-agent" as const, ...prAgent } : undefined);
  if (!opinion) return { skip: `a comment by ${login} is not a reviewer's verdict` };
  const at = iso(comment.updated_at ?? comment.created_at);
  return {
    delivery: {
      opinion: {
        ...opinion,
        reviewer: login,
        ...(comment.html_url ? { url: comment.html_url } : {}),
      },
      key: `issue_comment:${comment.id}:${at}`,
      at,
      ...base(payload.repository, payload.installation),
      number: issue.number,
      ...(issue.pull_request.html_url ? { url: issue.pull_request.html_url } : {}),
    },
  };
}

/** Conclusions that mean the reviewer did not get to a review. A cancelled run was replaced. */
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);

const JOB_TOOLS = new Map<string, ReviewerTool>(
  Object.entries(REVIEWER_JOB_NAMES).map(([tool, name]) => [
    name.toLowerCase(),
    tool as ReviewerTool,
  ]),
);

function fromCheckRun(payload: CheckRunPayload): ReviewerParse {
  const run = payload.check_run;
  if (payload.action !== "completed") return { skip: `check run ${payload.action}` };
  if (run.app?.slug !== "github-actions") return { skip: "the check run is not a workflow job" };
  const tool = JOB_TOOLS.get(run.name.toLowerCase());
  if (!tool) return { skip: `check run ${run.name} is not a reviewer job` };
  if (!run.conclusion || !FAILED_CONCLUSIONS.has(run.conclusion)) {
    return { skip: `${run.name} ${run.conclusion ?? "ended"}: its review carries the verdict` };
  }
  const number = run.pull_requests?.[0]?.number;
  if (number === undefined) return { skip: "the check run names no pull request" };
  const sha = run.head_sha.toLowerCase();
  return {
    delivery: {
      opinion: {
        tool,
        reviewer: "github-actions[bot]",
        verdict: "failed",
        ...(run.html_url ? { url: run.html_url } : {}),
        ...(SHA.test(sha) ? { head_sha: sha } : {}),
      },
      key: `check_run:${run.id}`,
      at: iso(run.completed_at ?? new Date().toISOString()),
      ...base(payload.repository, payload.installation),
      number,
    },
  };
}

/**
 * The reviewer verdict a webhook delivery carries, or why it carries none. `event` is the
 * X-GitHub-Event header.
 *
 * - `pull_request_review` submitted by coderabbitai[bot]: CodeRabbit's review.
 * - `issue_comment` created or edited by a bot on a pull request: PR-Agent's review comment
 *   (it edits one comment on every review), or any reviewer's comment ending in the selfhost
 *   marker line, which is how the Claude Code action reports (reviews with the line count too).
 * - `check_run` completed with a failure, from a reviewer job `selfhost review setup` wrote:
 *   the reviewer failed to run.
 *
 * Comments and reviews by people never count: a second opinion comes from a reviewer.
 */
export function reviewerDelivery(event: string, payload: unknown): ReviewerParse {
  if (event === "pull_request_review") {
    const review = shaped<ReviewPayload>(payload, ["review", "pull_request"]);
    return review ? fromReview(review) : { skip: "unexpected pull_request_review payload" };
  }
  if (event === "issue_comment") {
    const comment = shaped<CommentPayload>(payload, ["comment", "issue"]);
    return comment ? fromComment(comment) : { skip: "unexpected issue_comment payload" };
  }
  if (event === "check_run") {
    const run = shaped<CheckRunPayload>(payload, ["check_run"]);
    return run ? fromCheckRun(run) : { skip: "unexpected check_run payload" };
  }
  return { skip: `${event} events carry no reviewer verdict` };
}

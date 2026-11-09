import { anyGlobMatches, globMatches, normalizePath } from "@selfhost/policy";
import type { ResolvedSelfhostConfig } from "@selfhost/schema";
import type { GuardrailHit, RiskLevel } from "./types.js";

/** Who the decision log names for an approval auto-approve makes. */
export const AUTO_APPROVE_DECIDER = "selfhost auto-approve";

/** Hidden marker in the GitHub review body, so the App finds its own approval again. */
export const AUTO_APPROVE_MARKER = "<!-- selfhost:auto-approve v1 -->";

/** What a check run or commit status on the head commit says, other than selfhost's own. */
export type HeadCheckState = "passed" | "failed" | "pending";

/** The second opinion from the reviewer integration ([integrations.reviewer]). */
export interface SecondOpinion {
  verdict: "pass" | "fail";
  /** The reviewer tool, such as coderabbit. */
  by?: string;
  summary?: string;
}

/** Everything auto-approve reads about one agent pull request. Undefined means not known. */
export interface AutoApproveInputs {
  draft: boolean;
  /** The risk score, when the pull request was scored. */
  risk?: { level: RiskLevel; score: number };
  /** Changed files, with the old path of a rename. */
  files: readonly string[];
  /** Every check run and commit status on the head commit, selfhost's own left out. */
  checks?: readonly { name: string; state: HeadCheckState }[];
  /** Guardrail hits of the agent's run, from the ledger. Undefined when no run was recorded. */
  guardrails?: readonly GuardrailHit[];
  secondOpinion?: SecondOpinion;
  /**
   * Open review items of the pull request and its run: an agent waits on one, or it is an
   * exception. Any of them keeps the pull request for a person.
   */
  waits: readonly { kind: string; title: string; blocking: boolean }[];
}

export const AUTO_APPROVE_CHECKS = [
  "ready",
  "waits",
  "risk",
  "paths",
  "checks",
  "guardrails",
  "second_opinion",
] as const;

export type AutoApproveCheck = (typeof AUTO_APPROVE_CHECKS)[number];

export interface AutoApproveStep {
  check: AutoApproveCheck;
  passed: boolean;
  detail: string;
}

export interface AutoApproveVerdict {
  /** Every check passed: approve, or in dry run record that it would have. */
  eligible: boolean;
  dryRun: boolean;
  /** Each check in order, passed or not. */
  steps: AutoApproveStep[];
  /** The details of the checks that passed, for the decision log. */
  reasons: string[];
  /** The details of the checks that failed: why a person still has to review it. */
  blockers: string[];
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function listed(items: readonly string[], max = 3): string {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

function riskStep(
  risk: AutoApproveInputs["risk"],
  max: number,
): Pick<AutoApproveStep, "passed" | "detail"> {
  if (!risk) return { passed: false, detail: "The pull request has no risk score yet" };
  if (risk.level !== "low") {
    return { passed: false, detail: `Risk is ${risk.level} (score ${risk.score})` };
  }
  if (risk.score > max) {
    return { passed: false, detail: `Risk score ${risk.score} is above max_risk ${max}` };
  }
  return { passed: true, detail: `Low risk, score ${risk.score} (max_risk ${max})` };
}

function pathsStep(
  files: readonly string[],
  config: ResolvedSelfhostConfig,
): Pick<AutoApproveStep, "passed" | "detail"> {
  const { allowed_paths: allowed } = config.review.auto_approve;
  const paths = [...new Set(files.map(normalizePath))];
  if (paths.length === 0) return { passed: false, detail: "No changed files were read" };
  const risky = paths.filter((path) => anyGlobMatches(config.review.high_risk_paths, path));
  if (risky.length > 0) {
    return { passed: false, detail: `Touches [review] high_risk_paths: ${listed(risky)}` };
  }
  const outside = paths.filter((path) => !allowed.some((glob) => globMatches(glob, path)));
  if (outside.length > 0) {
    return { passed: false, detail: `Files outside allowed_paths: ${listed(outside)}` };
  }
  return {
    passed: true,
    detail: `${plural(paths.length, "changed file")}, all under ${allowed.join(", ")}`,
  };
}

function checksStep(
  checks: AutoApproveInputs["checks"],
  required: boolean,
): Pick<AutoApproveStep, "passed" | "detail"> {
  if (!required) return { passed: true, detail: "Green checks not required" };
  if (!checks) return { passed: false, detail: "The head commit's checks could not be read" };
  if (checks.length === 0) {
    return { passed: false, detail: "No checks have reported on the head commit" };
  }
  const failed = checks.filter((check) => check.state === "failed").map((check) => check.name);
  if (failed.length > 0) return { passed: false, detail: `Failed: ${listed(failed)}` };
  const pending = checks.filter((check) => check.state === "pending").map((check) => check.name);
  if (pending.length > 0) return { passed: false, detail: `Still running: ${listed(pending)}` };
  return { passed: true, detail: `${plural(checks.length, "check")} passed on the head commit` };
}

function guardrailsStep(
  guardrails: AutoApproveInputs["guardrails"],
): Pick<AutoApproveStep, "passed" | "detail"> {
  if (!guardrails) {
    return {
      passed: false,
      detail: "No agent run was recorded for these commits, so guardrail hits are unknown",
    };
  }
  if (guardrails.length > 0) {
    const rules = [...new Set(guardrails.map((hit) => hit.rule_id))];
    return { passed: false, detail: `Guardrail or rule hits in the run: ${listed(rules)}` };
  }
  return { passed: true, detail: "No guardrail or rule hits in the agent's run" };
}

function secondOpinionStep(
  opinion: SecondOpinion | undefined,
  config: ResolvedSelfhostConfig,
): Pick<AutoApproveStep, "passed" | "detail"> {
  const reviewer = config.integrations.reviewer?.tool;
  const required = config.review.auto_approve.require_second_opinion || reviewer !== undefined;
  if (!required) return { passed: true, detail: "No second opinion required" };
  const who = opinion?.by ?? reviewer ?? "the reviewer";
  if (!opinion) return { passed: false, detail: `No second opinion from ${who} yet` };
  if (opinion.verdict !== "pass") {
    return {
      passed: false,
      detail: `The second opinion from ${who} found problems${opinion.summary ? `: ${opinion.summary}` : ""}`,
    };
  }
  return { passed: true, detail: `The second opinion from ${who} passed` };
}

function waitsStep(waits: AutoApproveInputs["waits"]): Pick<AutoApproveStep, "passed" | "detail"> {
  const holding = waits.filter((item) => item.blocking || item.kind === "exception");
  if (holding.length > 0) {
    return {
      passed: false,
      detail: `Open items that need a person: ${listed(
        holding.map((item) => `${item.kind} "${item.title}"`),
        2,
      )}`,
    };
  }
  return { passed: true, detail: "No agent waits on a person and no exception is open" };
}

/**
 * Whether `[review.auto_approve]` approves an agent pull request. Every check must pass, and a
 * missing input fails its check, so the pull request waits for a person: a draft, an open item
 * an agent waits on or any exception, no risk score or more than low risk or max_risk, a file
 * outside allowed_paths or under high_risk_paths, a check that failed, is running or never
 * reported, no recorded run or any guardrail hit in it, and, once the reviewer integration is
 * set or require_second_opinion is on, a second opinion that is missing or did not pass.
 * Pure, and it makes no model call.
 */
export function autoApproveVerdict(
  inputs: AutoApproveInputs,
  config: ResolvedSelfhostConfig,
): AutoApproveVerdict {
  const auto = config.review.auto_approve;
  const steps: AutoApproveStep[] = [
    {
      check: "ready",
      ...(inputs.draft
        ? { passed: false, detail: "The pull request is a draft" }
        : { passed: true, detail: "Ready for review" }),
    },
    { check: "waits", ...waitsStep(inputs.waits) },
    { check: "risk", ...riskStep(inputs.risk, auto.max_risk) },
    { check: "paths", ...pathsStep(inputs.files, config) },
    { check: "checks", ...checksStep(inputs.checks, auto.require_green_checks) },
    { check: "guardrails", ...guardrailsStep(inputs.guardrails) },
    { check: "second_opinion", ...secondOpinionStep(inputs.secondOpinion, config) },
  ];
  const blockers = steps.filter((step) => !step.passed).map((step) => step.detail);
  return {
    eligible: auto.enabled && blockers.length === 0,
    dryRun: auto.dry_run,
    steps,
    reasons: steps.filter((step) => step.passed).map((step) => step.detail),
    blockers,
  };
}

/** One line for the check run summary. */
export function autoApproveSummary(verdict: AutoApproveVerdict): string {
  if (!verdict.eligible) {
    const [first] = verdict.blockers;
    const more = verdict.blockers.length > 1 ? ` (and ${verdict.blockers.length - 1} more)` : "";
    return `Auto-approve: a person reviews this. ${first ?? ""}${more}.`;
  }
  return verdict.dryRun
    ? "Auto-approve (dry run): selfhost would approve this pull request. [review.auto_approve] dry_run = true, so it only recorded that."
    : "Auto-approve: selfhost approved this pull request.";
}

/** Markdown for the check run text: every check with what it found. */
export function autoApproveText(verdict: AutoApproveVerdict): string {
  const mode = verdict.dryRun ? " (dry run)" : "";
  return [
    `### Auto-approve${mode}`,
    "",
    "| Check | Result | Found |",
    "| --- | --- | --- |",
    ...verdict.steps.map(
      (step) =>
        `| ${step.check} | ${step.passed ? "passed" : "needs a person"} | ${step.detail.replaceAll("|", "\\|")} |`,
    ),
  ].join("\n");
}

/** The GitHub review body: why it was approved, with the marker the App finds it by. */
export function autoApproveReviewBody(verdict: AutoApproveVerdict): string {
  return [
    AUTO_APPROVE_MARKER,
    "Approved by selfhost auto-approve ([review.auto_approve] in selfhost.toml):",
    "",
    ...verdict.reasons.map((reason) => `- ${reason}`),
  ].join("\n");
}

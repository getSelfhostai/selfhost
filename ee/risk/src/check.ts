import type { ResolvedSelfhostConfig } from "@selfhost/schema";
import { IRREVERSIBLE_FLOOR, mediumThreshold } from "./score.js";
import type { RiskInput, RiskLevel, RiskResult } from "./types.js";

/** The check run's name on the pull request. */
export const RISK_CHECK_NAME = "selfhost/risk";

export const RISK_LABELS = {
  low: "selfhost:risk-low",
  medium: "selfhost:risk-medium",
  high: "selfhost:risk-high",
} as const satisfies Record<RiskLevel, string>;

export function riskLabel(level: RiskLevel): string {
  return RISK_LABELS[level];
}

/** A GitHub check run's name and output, ready for the GitHub App to post. */
export interface RiskCheck {
  name: string;
  title: string;
  /** One paragraph: the level and what set it, then what was missing. */
  summary: string;
  /** Markdown: every input with its points, then the missing inputs and the thresholds. */
  text: string;
}

const INPUT_NAMES: Record<RiskInput, string> = {
  irreversible_rules: "Irreversible rules",
  outside_effects: "Outside effects",
  protected_paths: "Protected paths",
  size: "Size",
  dependencies: "New dependencies",
  tests: "Tests",
  guardrails: "Guardrail blocks",
  reverts: "Revert rate",
  module_reverts: "Module revert rate",
};

const LEVEL_NAMES: Record<RiskLevel, string> = { low: "Low", medium: "Medium", high: "High" };

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");

/** The label and check result for a scored pull request. */
export function riskCheck(result: RiskResult, config: ResolvedSelfhostConfig): RiskCheck {
  const level = LEVEL_NAMES[result.level];
  const threshold = config.review.high_risk_threshold;
  const setBy =
    result.reasons.length > 0
      ? `Set by: ${result.reasons.join("; ")}.`
      : "Nothing raised the score.";
  const missing =
    result.missing.length > 0
      ? ` Missing: ${result.missing.map((m) => `${INPUT_NAMES[m.input].toLowerCase()} (${m.reason})`).join("; ")}.`
      : "";

  const text = [
    "| Input | Points | Found |",
    "| --- | ---: | --- |",
    ...result.factors.map(
      (factor) =>
        `| ${INPUT_NAMES[factor.input]} | ${factor.forcesHigh ? `${factor.points}, sets high` : factor.points} | ${cell(factor.detail)} |`,
    ),
    "",
    ...(result.missing.length > 0
      ? [
          "**Missing inputs.** The score uses the rest.",
          "",
          ...result.missing.map((m) => `- ${INPUT_NAMES[m.input]}: ${m.reason}`),
          "",
        ]
      : []),
    `High: an irreversible change or outside effect (score ${IRREVERSIBLE_FLOOR} or more), a change under [review] high_risk_paths, or a score of ${threshold} or more ([review] high_risk_threshold). Medium: ${mediumThreshold(threshold)} or more. The same inputs always give the same level.`,
  ].join("\n");

  return {
    name: RISK_CHECK_NAME,
    title: `${level} risk (score ${result.score})`,
    summary: `${level} risk, score ${result.score} of 100. ${setBy}${missing}`,
    text,
  };
}

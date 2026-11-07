import type { AgentRef } from "@selfhost/attribution";
import type { Ledger } from "@selfhost/ledger";
import type { ResolvedSelfhostConfig } from "@selfhost/schema";
import { type RiskCheck, riskCheck, riskLabel } from "./check.js";
import { type GatheredTarget, gatherRiskInputs, type RiskTarget } from "./gather.js";
import type { Runner } from "./git.js";
import { scoreRisk } from "./score.js";
import type { RiskResult, TestStatus } from "./types.js";

export const REVIEW_RISK_SCHEMA = "selfhost.review_risk/v1";

/** `selfhost review risk --json`. */
export interface ReviewRiskReport {
  schema: typeof REVIEW_RISK_SCHEMA;
  /** selfhost.toml used, or null when none was found and the defaults applied. */
  config: string | null;
  target: GatheredTarget;
  agent: AgentRef | null;
  /** The PR label, selfhost:risk-low, -medium or -high. */
  label: string;
  check: RiskCheck;
  risk: RiskResult;
}

export interface ReviewRiskOptions {
  repoDir: string;
  /** A pull request number, or undefined with `base`. */
  pr?: string;
  base?: string;
  head?: string;
  /** passed, failed or not-run. */
  tests?: string;
  config: ResolvedSelfhostConfig;
  configPath?: string;
  ledger?: Pick<Ledger, "query">;
  now?: Date;
  gh?: Runner;
  ghCacheDir?: string;
}

const TEST_STATUSES: Record<string, TestStatus> = {
  passed: "passed",
  failed: "failed",
  "not-run": "not_run",
  not_run: "not_run",
};

export function parseTestStatus(value: string | undefined): TestStatus | undefined {
  if (value === undefined) return undefined;
  const status = TEST_STATUSES[value.trim().toLowerCase()];
  if (!status) throw new Error(`--tests: expected passed, failed or not-run, got "${value}"`);
  return status;
}

function parseTarget(options: ReviewRiskOptions): RiskTarget {
  if ((options.pr === undefined) === (options.base === undefined)) {
    throw new Error("Pass a pull request number or --base <ref>, not both and not neither");
  }
  if (options.pr !== undefined) {
    if (!/^\d+$/.test(options.pr) || Number(options.pr) < 1) {
      throw new Error(`Expected a pull request number, got "${options.pr}"`);
    }
    if (options.head !== undefined) throw new Error("--head goes with --base");
    return { pr: Number(options.pr) };
  }
  return { base: options.base as string, ...(options.head ? { head: options.head } : {}) };
}

/** Gathers the inputs, scores them and builds the label and check result. Writes nothing anywhere. */
export async function reviewRisk(options: ReviewRiskOptions): Promise<ReviewRiskReport> {
  const target = parseTarget(options);
  const tests = parseTestStatus(options.tests);
  const gathered = await gatherRiskInputs({
    repoDir: options.repoDir,
    target,
    ...(options.ledger ? { ledger: options.ledger } : {}),
    ...(tests ? { tests } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.gh ? { gh: options.gh } : {}),
    ...(options.ghCacheDir ? { ghCacheDir: options.ghCacheDir } : {}),
  });
  const risk = scoreRisk(gathered.inputs, options.config);
  return {
    schema: REVIEW_RISK_SCHEMA,
    config: options.configPath ?? null,
    target: gathered.target,
    agent: gathered.inputs.agent ?? null,
    label: riskLabel(risk.level),
    check: riskCheck(risk, options.config),
    risk,
  };
}

/** The report as the terminal shows it: what was scored, the label, then the check result. */
export function formatRiskReport(report: ReviewRiskReport): string[] {
  const { target } = report;
  const what = target.pr
    ? `${target.pr.repo}#${target.pr.number}`
    : `${target.commits.length} commit${target.commits.length === 1 ? "" : "s"} since ${target.base.slice(0, 12)}`;
  const agent = report.agent
    ? `${report.agent.vendor}${report.agent.model ? ` ${report.agent.model}` : ""}`
    : "no agent attributed";
  return [
    `${what} (${agent})`,
    "",
    `Label: ${report.label}`,
    `Check: ${report.check.name}: ${report.check.title}`,
    "",
    report.check.summary,
    "",
    report.check.text,
  ];
}

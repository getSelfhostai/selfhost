import { anyGlobMatches, effectiveRules, evaluate, globMatches } from "@selfhost/policy";
import { compare, isLockfile } from "@selfhost/pr";
import { MIN_MODULE_LINES } from "@selfhost/provenance";
import type { ResolvedSelfhostConfig } from "@selfhost/schema";
import { type OutsideEffect, outsideEffects } from "./effects.js";
import {
  type ChangedFile,
  type MissingInput,
  RISK_INPUTS,
  type RiskFactor,
  type RiskInput,
  type RiskInputs,
  type RiskLevel,
  type RiskResult,
  type RunInput,
} from "./types.js";

/**
 * Points each input adds. The score is their sum, held in a band:
 *
 * - An irreversible change (a changed file or a run tool call matched by a selfhost.toml rule
 *   with `irreversible = true`) or an irreversible outside effect during the run makes the level
 *   high and the score at least IRREVERSIBLE_FLOOR, whatever else is true.
 * - Everything else stays below IRREVERSIBLE_FLOOR, so what cannot be undone always sorts above
 *   what can, however large or untested the rest is.
 * - A change under `[review] high_risk_paths` makes the level high and the score at least
 *   `[review] high_risk_threshold` (capped below the band).
 * - Otherwise the level is high from `high_risk_threshold` (default 70) and medium from half of
 *   it, rounded up (35).
 *
 * Defaults to tune on real data; see the README for the reasoning behind each number.
 */
export const WEIGHTS = {
  irreversibleChange: 60,
  outsideEffect: 60,
  protectedPaths: 40,
  /** Changed lines (additions plus deletions, lockfiles left out) up to each bound. */
  size: [
    { upTo: 50, points: 0 },
    { upTo: 200, points: 5 },
    { upTo: 500, points: 10 },
    { upTo: 1000, points: 15 },
  ],
  sizeAbove: 20,
  firstDependency: 10,
  eachMoreDependency: 5,
  dependenciesMax: 20,
  testsFailed: 30,
  testsNotRun: 15,
  guardrailBlock: 10,
  guardrailsMax: 20,
  /** Share of the agent and model's commits reverted, from each rate up. */
  revertRate: [
    { from: 0.25, points: 20 },
    { from: 0.1, points: 10 },
  ],
  /**
   * A touched module whose agent-written lines were reverted or reworked above
   * `[review] revert_rate_threshold`, with at least MIN_MODULE_LINES of them.
   */
  firstHotModule: 10,
  eachMoreHotModule: 5,
  hotModulesMax: 20,
} as const;

export const IRREVERSIBLE_FLOOR = 90;

/** Revert rates from fewer commits than this are reported as missing, not scored. */
export const MIN_REVERT_SAMPLE = 5;

/** Irreversible rules and size are always scored: the diff is the one input every PR has. */
type MissableInput = Exclude<RiskInput, "irreversible_rules" | "size">;

const DEFAULT_MISSING: Record<MissableInput, string> = {
  outside_effects: "no agent run found in the ledger",
  protected_paths: "no [review] high_risk_paths in selfhost.toml",
  dependencies: "manifests could not be read",
  tests: "no sandbox run yet",
  guardrails: "no agent run found in the ledger",
  reverts: "no revert history yet",
  module_reverts: "no module revert rates: they need the repository's git history",
};

const MAX_LISTED = 5;

/** "a, b, c and 2 more". */
function list(items: string[]): string {
  const shown = items.slice(0, MAX_LISTED);
  const more = items.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const percent = (rate: number) => `${Math.round(rate * 100)}%`;

const agentName = (agent: { vendor: string; model?: string }) =>
  agent.model ? `${agent.vendor} ${agent.model}` : agent.vendor;

interface IrreversibleHit {
  rule_id: string;
  /** The changed file, command or tool that matched. */
  what: string;
}

/**
 * Changed files matched by an irreversible rule's `path`. Rules that also test a command or URL
 * are about tool calls, not changes.
 */
function irreversibleChanges(
  files: ChangedFile[],
  config: ResolvedSelfhostConfig,
  agent: RiskInputs["agent"],
): IrreversibleHit[] {
  const hits: IrreversibleHit[] = [];
  for (const rule of effectiveRules(config, { agent: agent?.vendor })) {
    const glob = rule.match.path;
    if (!rule.irreversible || glob === undefined) continue;
    if (rule.match.command !== undefined || rule.match.url !== undefined) continue;
    for (const file of files) {
      const paths = [file.path, ...(file.previousPath ? [file.previousPath] : [])];
      const matched = paths.find((path) => globMatches(glob, path));
      if (matched) hits.push({ rule_id: rule.id, what: matched });
    }
  }
  return hits;
}

/**
 * The run's commands, URLs and tools an irreversible rule fires on, and irreversible hits
 * recorded during the run. File paths count only through the diff: reading a file, or editing
 * one the change no longer holds, cannot be irreversible.
 */
function irreversibleRun(run: RunInput, config: ResolvedSelfhostConfig): IrreversibleHit[] {
  const hits: IrreversibleHit[] = [];
  for (const { path: _path, ...call } of run.toolCalls) {
    for (const hit of evaluate(config, call)) {
      if (hit.irreversible) {
        hits.push({ rule_id: hit.rule_id, what: call.command ?? call.url ?? call.tool });
      }
    }
  }
  for (const guardrail of run.guardrails) {
    if (guardrail.irreversible) {
      hits.push({ rule_id: guardrail.rule_id, what: "recorded during the run" });
    }
  }
  return hits;
}

function unique<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) if (!seen.has(key(item))) seen.set(key(item), item);
  return [...seen.entries()].sort(([a], [b]) => compare(a, b)).map(([, item]) => item);
}

function sizePoints(lines: number): number {
  return WEIGHTS.size.find((step) => lines <= step.upTo)?.points ?? WEIGHTS.sizeAbove;
}

/**
 * The risk of a pull request from its inputs and selfhost.toml. Pure: no I/O, and the same
 * inputs and config always give the same result, whatever order the lists come in.
 */
export function scoreRisk(inputs: RiskInputs, config: ResolvedSelfhostConfig): RiskResult {
  const factors: RiskFactor[] = [];
  const missing: MissingInput[] = [];
  const why = inputs.unavailable ?? {};
  const isMissing = (input: MissableInput) =>
    missing.push({ input, reason: why[input] ?? DEFAULT_MISSING[input] });
  const files = unique(inputs.files, (file) => `${file.path}\n${file.previousPath ?? ""}`);
  const run = inputs.run;

  const irreversible = unique(
    [
      ...irreversibleChanges(files, config, inputs.agent),
      ...(run ? irreversibleRun(run, config) : []),
    ],
    (hit) => `${hit.rule_id}\n${hit.what}`,
  );
  factors.push({
    input: "irreversible_rules",
    points: irreversible.length > 0 ? WEIGHTS.irreversibleChange : 0,
    forcesHigh: irreversible.length > 0,
    detail:
      irreversible.length > 0
        ? `Irreversible by selfhost.toml: ${list(irreversible.map((hit) => `${hit.rule_id} (${hit.what})`))}`
        : `No irreversible rule matched the ${run ? "changes or the run" : "changes"}`,
  });

  if (run) {
    const effects = unique(
      run.toolCalls.flatMap((call) => outsideEffects(call)),
      (effect: OutsideEffect) => `${effect.kind}\n${effect.label}\n${effect.evidence}`,
    );
    factors.push({
      input: "outside_effects",
      points: effects.length > 0 ? WEIGHTS.outsideEffect : 0,
      forcesHigh: effects.length > 0,
      detail:
        effects.length > 0
          ? `Irreversible outside ${effects.length === 1 ? "effect" : "effects"} during the run: ${list(effects.map((effect) => `${effect.kind.replace("_", " ")}, ${effect.label} (${effect.evidence})`))}`
          : `No payment, email, production data write, publish or infrastructure change in ${plural(run.sessions.length, "session")}`,
    });
  } else {
    isMissing("outside_effects");
  }

  const protectedGlobs = config.review.high_risk_paths;
  let protectedHit = false;
  if (protectedGlobs.length > 0) {
    const touched = files
      .filter(
        (file) =>
          anyGlobMatches(protectedGlobs, file.path) ||
          (file.previousPath !== undefined && anyGlobMatches(protectedGlobs, file.previousPath)),
      )
      .map((file) => file.path);
    protectedHit = touched.length > 0;
    factors.push({
      input: "protected_paths",
      points: protectedHit ? WEIGHTS.protectedPaths : 0,
      forcesHigh: protectedHit,
      detail: protectedHit
        ? `${plural(touched.length, "file")} under [review] high_risk_paths: ${list(touched)}`
        : "No file under [review] high_risk_paths",
    });
  } else {
    isMissing("protected_paths");
  }

  const counted = files.filter((file) => !isLockfile(file.path));
  const lines = counted.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  factors.push({
    input: "size",
    points: sizePoints(lines),
    forcesHigh: false,
    detail: `${plural(lines, "changed line")} in ${plural(counted.length, "file")}${counted.length < files.length ? " (lockfiles left out)" : ""}`,
  });

  if (inputs.dependencies) {
    const deps = unique(inputs.dependencies, (dep) => `${dep.manifest}\n${dep.name}`);
    const points =
      deps.length === 0
        ? 0
        : Math.min(
            WEIGHTS.firstDependency + (deps.length - 1) * WEIGHTS.eachMoreDependency,
            WEIGHTS.dependenciesMax,
          );
    factors.push({
      input: "dependencies",
      points,
      forcesHigh: false,
      detail:
        deps.length > 0
          ? `${deps.length} new ${deps.length === 1 ? "dependency" : "dependencies"}: ${list(deps.map((dep) => `${dep.name} (${dep.manifest})`))}`
          : "No new dependencies",
    });
  } else {
    isMissing("dependencies");
  }

  if (inputs.tests) {
    const points =
      inputs.tests === "failed"
        ? WEIGHTS.testsFailed
        : inputs.tests === "not_run"
          ? WEIGHTS.testsNotRun
          : 0;
    const detail = {
      passed: "Tests ran and passed",
      failed: "Tests failed",
      not_run: "No tests ran",
    }[inputs.tests];
    factors.push({ input: "tests", points, forcesHigh: false, detail });
  } else {
    isMissing("tests");
  }

  if (run) {
    const blocks = [...run.guardrails]
      .filter((hit) => hit.verdict === "block")
      .sort((a, b) => compare(a.rule_id, b.rule_id) || compare(a.mode, b.mode));
    const enforced = blocks.filter((hit) => hit.mode === "enforce").length;
    factors.push({
      input: "guardrails",
      points: Math.min(blocks.length * WEIGHTS.guardrailBlock, WEIGHTS.guardrailsMax),
      forcesHigh: false,
      detail:
        blocks.length > 0
          ? `${plural(blocks.length, "guardrail block")} during the run (${enforced} enforced, ${blocks.length - enforced} observe only): ${list([...new Set(blocks.map((hit) => hit.rule_id))])}`
          : "No guardrail blocks during the run",
    });
  } else {
    isMissing("guardrails");
  }

  const reverts = inputs.reverts;
  if (reverts && reverts.commits >= MIN_REVERT_SAMPLE) {
    const rate = reverts.reverted / reverts.commits;
    factors.push({
      input: "reverts",
      points: WEIGHTS.revertRate.find((step) => rate >= step.from)?.points ?? 0,
      forcesHigh: false,
      detail: `${agentName(reverts.agent)}: ${reverts.reverted} of ${plural(reverts.commits, "commit")} reverted in the last ${reverts.days} days (${percent(rate)})`,
    });
  } else if (reverts) {
    missing.push({
      input: "reverts",
      reason: `only ${plural(reverts.commits, "commit")} by ${agentName(reverts.agent)} in the last ${reverts.days} days (needs ${MIN_REVERT_SAMPLE})`,
    });
  } else {
    isMissing("reverts");
  }

  const modules = inputs.modules;
  if (modules) {
    const threshold = config.review.revert_rate_threshold;
    const touched = [...modules.modules].sort((a, b) => compare(a.module, b.module));
    const hot = touched.filter(
      (m) => m.agentLines >= MIN_MODULE_LINES && m.rate !== null && m.rate > threshold,
    );
    factors.push({
      input: "module_reverts",
      points:
        hot.length === 0
          ? 0
          : Math.min(
              WEIGHTS.firstHotModule + (hot.length - 1) * WEIGHTS.eachMoreHotModule,
              WEIGHTS.hotModulesMax,
            ),
      forcesHigh: false,
      detail:
        hot.length > 0
          ? `${plural(hot.length, "touched module")} above [review] revert_rate_threshold (${percent(threshold)}) in the last ${modules.days} days: ${list(hot.map((m) => `${m.module} ${percent(m.rate ?? 0)} of ${plural(m.agentLines, "agent line")} reverted or reworked`))}`
          : `No touched module above [review] revert_rate_threshold (${percent(threshold)}) in the last ${modules.days} days (${list(touched.map((m) => m.module)) || "no modules"})`,
    });
  } else {
    isMissing("module_reverts");
  }

  const order = (input: RiskInput) => RISK_INPUTS.indexOf(input);
  factors.sort((a, b) => order(a.input) - order(b.input));
  missing.sort((a, b) => order(a.input) - order(b.input));

  const threshold = config.review.high_risk_threshold;
  const points = factors.reduce((sum, factor) => sum + factor.points, 0);
  const cannotUndo = factors.some(
    (factor) =>
      factor.forcesHigh &&
      (factor.input === "irreversible_rules" || factor.input === "outside_effects"),
  );
  let score: number;
  if (cannotUndo) {
    score = Math.min(Math.max(points, IRREVERSIBLE_FLOOR), 100);
  } else {
    score = Math.min(points, IRREVERSIBLE_FLOOR - 1);
    if (protectedHit) score = Math.max(score, Math.min(threshold, IRREVERSIBLE_FLOOR - 1));
  }
  const forced = factors.some((factor) => factor.forcesHigh);
  const level: RiskLevel =
    forced || score >= threshold ? "high" : score >= mediumThreshold(threshold) ? "medium" : "low";

  const reasons = factors
    .filter((factor) => factor.forcesHigh || factor.points > 0)
    .sort(
      (a, b) =>
        Number(b.forcesHigh) - Number(a.forcesHigh) ||
        b.points - a.points ||
        order(a.input) - order(b.input),
    )
    .map((factor) => factor.detail);

  return { level, score, reasons, missing, factors };
}

/** Half of `[review] high_risk_threshold`, rounded up. */
export function mediumThreshold(threshold: number): number {
  return Math.ceil(threshold / 2);
}

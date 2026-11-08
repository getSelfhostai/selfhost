import type { PolicyHit, ToolCall } from "@selfhost/policy";
import { PACKAGE_RULE_IDS, type ResolvedSelfhostConfig, type RuleAction } from "@selfhost/schema";
import { type Cache, createCache } from "./cache.js";
import {
  checkCommand,
  type Finding,
  type GuardDeps,
  type PackageReport,
  REGISTRY_NAMES,
} from "./check.js";

/** Hits come back in this order, one per rule id. */
const RULE_ORDER: string[] = [
  PACKAGE_RULE_IDS.deny,
  PACKAGE_RULE_IDS.blocked_registry,
  PACKAGE_RULE_IDS.malicious,
  PACKAGE_RULE_IDS.not_found,
  PACKAGE_RULE_IDS.too_new,
  PACKAGE_RULE_IDS.install_scripts,
  PACKAGE_RULE_IDS.unchecked,
];

/** Sentences one hit's message lists before "and N more". */
const MAX_SENTENCES = 5;

function joined(sentences: string[]): string {
  const unique = [...new Set(sentences)];
  const shown = unique.slice(0, MAX_SENTENCES);
  const more = unique.length - shown.length;
  return [...shown, ...(more > 0 ? [`And ${more} more.`] : [])].join(" ");
}

/**
 * The report as policy hits: one per rule id, its message naming every package that broke it.
 * Hits take the mode of [packages], except packages.unchecked, which is always observe: an
 * install the guard could not check goes ahead (fail open) and is only recorded.
 */
export function packageHits(report: PackageReport, config: ResolvedSelfhostConfig): PolicyHit[] {
  const policy = config.packages;
  if (policy.mode === "off") return [];
  const byRule = new Map<string, { verdict: RuleAction; messages: string[] }>();
  const add = (finding: Finding) => {
    const entry = byRule.get(finding.rule_id) ?? { verdict: finding.verdict, messages: [] };
    entry.messages.push(finding.message);
    byRule.set(finding.rule_id, entry);
  };
  const unchecked: string[] = [];
  const reasons = new Set<string>();
  for (const install of report.installs) {
    for (const finding of install.findings) add(finding);
    for (const pkg of install.packages) {
      for (const finding of pkg.findings) add(finding);
      if (pkg.unchecked.length === 0) continue;
      unchecked.push(`${pkg.name} (${REGISTRY_NAMES[pkg.ecosystem]})`);
      for (const reason of pkg.unchecked) reasons.add(reason);
    }
  }
  if (unchecked.length > 0) {
    const shown = [...reasons].slice(0, 3);
    const more = reasons.size - shown.length;
    add({
      rule_id: PACKAGE_RULE_IDS.unchecked,
      verdict: "ask",
      message: `Could not fully check ${unchecked.join(", ")}: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}. ${unchecked.length === 1 ? "It was" : "They were"} not blocked.`,
    });
  }
  const mode = policy.mode === "enforce" ? "enforce" : "observe";
  return RULE_ORDER.flatMap((ruleId) => {
    const entry = byRule.get(ruleId);
    if (!entry) return [];
    return [
      {
        rule_id: ruleId,
        mode: ruleId === PACKAGE_RULE_IDS.unchecked ? "observe" : mode,
        verdict: entry.verdict,
        message: joined(entry.messages),
        irreversible: false,
      },
    ];
  });
}

/** A checker the pre-tool hook awaits for each tool call. */
export type PackageChecker = (call: ToolCall) => Promise<PolicyHit[]>;

/**
 * The package guard for one policy: checks the packages a shell call installs and returns its
 * hits. Calls with no command, or no install in it, return no hits without any network call.
 * The cache lives as long as the guard, and on disk too with `cacheDir`.
 */
export function packageGuard(config: ResolvedSelfhostConfig, deps: GuardDeps): PackageChecker {
  const cache: Cache = createCache(deps.now, deps.cacheDir);
  return async (call) => {
    if (call.command === undefined || config.packages.mode === "off") return [];
    const report = await checkCommand(call.command, config, { ...deps, cache });
    return packageHits(report, config);
  };
}

/**
 * The same guard in the shape of an extra evaluator check, `(call, config) => hits`, for hooks
 * that pass the policy on every call. One cache serves every policy it sees.
 */
export function packageChecker(
  deps: GuardDeps,
): (call: ToolCall, config: ResolvedSelfhostConfig) => Promise<PolicyHit[]> {
  const cache: Cache = createCache(deps.now, deps.cacheDir);
  return async (call, config) => {
    if (call.command === undefined || config.packages.mode === "off") return [];
    const report = await checkCommand(call.command, config, { ...deps, cache });
    return packageHits(report, config);
  };
}

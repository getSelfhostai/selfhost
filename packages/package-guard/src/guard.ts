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

/** What the agent can do instead, for each rule that can stop an install. */
export const PACKAGE_ALTERNATIVES: Record<string, string> = {
  [PACKAGE_RULE_IDS.deny]:
    "Use a different package that does the same job, or ask the user whether the team wants to take it off [packages] deny.",
  [PACKAGE_RULE_IDS.blocked_registry]:
    "Install from the default registry or one the team allows, without the blocked registry or URL.",
  [PACKAGE_RULE_IDS.malicious]:
    "Do not install it. Check the spelling of the package you meant, or pick a maintained package that does the same job.",
  [PACKAGE_RULE_IDS.not_found]:
    "Look up the exact name on the registry and install that, or ask the user which package they mean. Do not guess names.",
  [PACKAGE_RULE_IDS.too_new]:
    "Pin an older version, published before [packages] min_age_days, or ask the user to approve this one.",
  [PACKAGE_RULE_IDS.install_scripts]:
    "Install without running its code (npm install --ignore-scripts, pip install --only-binary :all:) if it works that way, or ask the user to approve it.",
};

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
    const alternative = PACKAGE_ALTERNATIVES[ruleId];
    return [
      {
        rule_id: ruleId,
        mode: ruleId === PACKAGE_RULE_IDS.unchecked ? "observe" : mode,
        verdict: entry.verdict,
        message: joined(entry.messages),
        ...(alternative ? { alternative } : {}),
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

import { policyChecks } from "@selfhost/policy";
import {
  COMPILE_VENDORS,
  type CompileVendor,
  MCP_ALLOW_RULE_ID,
  type PolicyCoverage,
  type ResolvedSelfhostConfig,
  type RuleCoverage,
} from "@selfhost/schema";
import { AGENT_NAMES, policyText } from "./policy-text.js";
import { VENDOR_NAMES } from "./target.js";
import type { Check, Mapping, OutputFile, VendorCompiler, VendorOutput } from "./types.js";
import { claudeCode } from "./vendors/claude-code.js";
import { codex } from "./vendors/codex.js";
import { copilot } from "./vendors/copilot.js";
import { cursor } from "./vendors/cursor.js";
import { resolveVersion } from "./versions.js";

/** The hook command `selfhost init` and `selfhost agents configure` write. */
export const DEFAULT_HOOK_COMMAND = "selfhost hook {agent}";

/** Where the policy text goes in a repository, for Ruler to copy into rules files. */
export const RULER_SOURCE = ".ruler/selfhost-policy.md";

export interface CompileOptions {
  /** Default: every vendor, in COMPILE_VENDORS order. */
  vendors?: readonly CompileVendor[];
  /** Vendor config version to target; default the newest in VENDOR_VERSIONS. */
  versions?: Partial<Record<CompileVendor, string>>;
  /** Apply this team's overrides. */
  team?: string;
  /** Command each agent's hooks run; `{agent}` becomes the agent id. */
  hookCommand?: string;
}

export interface CompileResult {
  coverage: PolicyCoverage;
  vendors: VendorOutput[];
  /** The policy text for Ruler, or null when no rule or allow list is on. */
  rules: OutputFile | null;
}

const COMPILERS: Record<CompileVendor, VendorCompiler> = {
  claude_code: claudeCode,
  codex,
  cursor,
  copilot,
};

/** Every rule and allow-list check with the team's overrides, in evaluation order. */
export function checksOf(config: ResolvedSelfhostConfig, team?: string): Check[] {
  return policyChecks(config, { team }).map((check, index): Check => {
    const rule = config.rules[index];
    const base = {
      id: check.id,
      mode: check.mode,
      action: check.action,
      message: check.message,
      agents: [...check.agents],
      irreversible: check.irreversible,
    };
    // policyChecks lists the rules first, in file order, then the allow lists.
    if (rule !== undefined) return { ...base, match: rule.match };
    return check.id === MCP_ALLOW_RULE_ID
      ? { ...base, list: { kind: "mcp", allow: config.mcp.allow } }
      : { ...base, list: { kind: "models", allow: config.models.allow } };
  });
}

const forVendor = (check: Check, vendor: CompileVendor) =>
  check.agents.includes("all") || check.agents.includes(vendor);

function ruleCoverage(
  vendor: CompileVendor,
  check: Check,
  mapping: Mapping<unknown> | undefined,
): RuleCoverage {
  const base = { rule_id: check.id, vendor, mode: check.mode, action: check.action };
  if (check.mode === "off" || mapping === undefined) {
    const names = check.agents.map((agent) => AGENT_NAMES[agent] ?? agent);
    return {
      ...base,
      status: "not_applicable",
      native: [],
      hook: "none",
      detail: check.mode === "off" ? "Mode off." : `The rule is only for ${names.join(" and ")}.`,
    };
  }
  const { status } = mapping;
  const hook =
    mapping.hook && status !== "not_applicable"
      ? check.mode === "enforce"
        ? "enforce"
        : "record"
      : "none";
  const sentences: string[] = [];
  if (check.mode === "observe" && status !== "not_applicable") {
    sentences.push("Observe mode: nothing native is written until the rule is enforced.");
  }
  if (mapping.detail !== "") sentences.push(mapping.detail);
  if (hook === "record") sentences.push("The selfhost hook records its hits.");
  else if (status === "partial" || status === "not_expressible") {
    const rest = status === "partial" ? "the rest" : "it";
    sentences.push(
      hook === "enforce"
        ? `The selfhost hook checks ${rest}.`
        : `Nothing checks ${rest} on ${VENDOR_NAMES[vendor]}.`,
    );
  }
  return {
    ...base,
    status,
    native: check.mode === "enforce" ? mapping.native : [],
    hook,
    detail: sentences.join(" "),
  };
}

/**
 * Compiles a resolved selfhost.toml into each vendor's native controls. Pure: the same config
 * and options give the same files, calls and coverage. Only enforced rules become native
 * entries; observe rules are reported with the status they get once enforced, and the hooks
 * record them. Every rule gets one coverage entry per vendor, and a status is compiled only
 * when the native entries cover every call the rule matches.
 */
export function compilePolicy(
  config: ResolvedSelfhostConfig,
  options: CompileOptions = {},
): CompileResult {
  const wanted = new Set(options.vendors ?? COMPILE_VENDORS);
  const vendors = COMPILE_VENDORS.filter((vendor) => wanted.has(vendor));
  const checks = checksOf(config, options.team);
  const rulesText = policyText(checks, options.team);
  const hookCommand = options.hookCommand ?? DEFAULT_HOOK_COMMAND;
  const results = vendors.map((vendor) =>
    COMPILERS[vendor]({
      version: resolveVersion(vendor, options.versions?.[vendor]),
      checks: checks.filter((check) => check.mode !== "off" && forVendor(check, vendor)),
      hookCommand: hookCommand.replaceAll("{agent}", vendor),
      rulesText,
    }),
  );
  const rules = checks.flatMap((check) =>
    vendors.map((vendor, index) =>
      ruleCoverage(vendor, check, results[index]?.mappings.get(check.id)),
    ),
  );
  return {
    coverage: {
      schema: "selfhost.policy_coverage/v1",
      team: options.team ?? null,
      vendors: results.map((result) => result.coverage),
      rules,
    },
    vendors: results.map((result) => result.output),
    rules:
      rulesText === ""
        ? null
        : {
            name: RULER_SOURCE,
            content: rulesText,
            description:
              "The policy as text. Ruler copies it into each agent's rules file (CLAUDE.md, AGENTS.md).",
            install: { kind: "repo", path: RULER_SOURCE },
          },
  };
}

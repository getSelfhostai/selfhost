import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "./common.js";
import { RULE_ACTIONS, RULE_MODES } from "./config.js";

/** Vendors `selfhost policy compile` writes native controls for. */
export const COMPILE_VENDORS = ["claude_code", "codex", "cursor", "copilot"] as const;

/**
 * How much of a rule a vendor's native controls express:
 * compiled covers every call the rule matches, partial covers some, not_expressible none,
 * and not_applicable means the rule can never match on that vendor (mode off, another agent,
 * or a tool name the vendor does not report).
 */
export const COVERAGE_STATUSES = [
  "compiled",
  "partial",
  "not_expressible",
  "not_applicable",
] as const;

/**
 * What the selfhost hook does for the rule on that vendor: enforce (enforce mode, the vendor
 * runs selfhost's pre-tool hook on the calls the rule matches), record (observe mode) or none.
 */
export const HOOK_COVERAGES = ["enforce", "record", "none"] as const;

export type CompileVendor = (typeof COMPILE_VENDORS)[number];
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];
export type HookCoverage = (typeof HOOK_COVERAGES)[number];

export const RuleCoverageSchema = Type.Object(
  {
    rule_id: Type.String({ description: "Rule id, or mcp.allow, models.allow and egress.allow." }),
    vendor: StringEnum(COMPILE_VENDORS),
    mode: StringEnum(RULE_MODES, { description: "Mode after the team's overrides." }),
    action: StringEnum(RULE_ACTIONS),
    status: StringEnum(COVERAGE_STATUSES, {
      description:
        "What the vendor's native controls express once the rule is enforced. Observe rules write nothing native.",
    }),
    native: Type.Array(Type.String(), {
      description:
        "Native entries written for the rule, like Bash(git push --force*). Empty when nothing is written.",
    }),
    hook: StringEnum(HOOK_COVERAGES, {
      description: "What the selfhost pre-tool hook does for the rule on this vendor.",
    }),
    detail: Type.String({ description: "Why, and what is left uncovered." }),
  },
  { additionalProperties: false, title: "RuleCoverage" },
);

export const VendorCoverageSchema = Type.Object(
  {
    vendor: StringEnum(COMPILE_VENDORS),
    version: Type.String({ description: "Vendor config version the output targets." }),
    docs: Type.Array(Type.String(), { description: "Vendor docs the mapping follows." }),
    notes: Type.Array(Type.String(), {
      description: "Side effects and checks still open for this vendor.",
    }),
  },
  { additionalProperties: false, title: "VendorCoverage" },
);

export const PolicyCoverageSchema = Type.Object(
  {
    schema: Type.Literal("selfhost.policy_coverage/v1"),
    team: Type.Union([Type.String(), Type.Null()], {
      description: "Team whose overrides were applied, or null.",
    }),
    vendors: Type.Array(VendorCoverageSchema),
    rules: Type.Array(RuleCoverageSchema, {
      description:
        "One entry per rule and vendor, in rule order then vendor order: rules in file order, then mcp.allow, models.allow and egress.allow.",
    }),
  },
  { additionalProperties: false, title: "PolicyCoverage" },
);

export type RuleCoverage = Static<typeof RuleCoverageSchema>;
export type VendorCoverage = Static<typeof VendorCoverageSchema>;
export type PolicyCoverage = Static<typeof PolicyCoverageSchema>;

/**
 * Agents `selfhost context compile` writes repository context files for: rules, skills,
 * commands, subagents and MCP servers from .selfhost/context.
 */
export const CONTEXT_AGENTS = [
  "claude_code",
  "codex",
  "cursor",
  "copilot",
  "gemini",
  "opencode",
  "goose",
] as const;

/** What a .selfhost/context item is: a rule, a skill, a slash command, a subagent or an MCP server. */
export const CONTEXT_ITEM_KINDS = ["rule", "skill", "command", "agent", "mcp"] as const;

export type ContextAgent = (typeof CONTEXT_AGENTS)[number];
export type ContextItemKind = (typeof CONTEXT_ITEM_KINDS)[number];

export const ContextItemCoverageSchema = Type.Object(
  {
    item: Type.String({ description: "Item id: kind and name, like rule:style or skill:review." }),
    kind: StringEnum(CONTEXT_ITEM_KINDS),
    agent: StringEnum(CONTEXT_AGENTS),
    status: StringEnum(COVERAGE_STATUSES, {
      description:
        "compiled: the agent loads the item as written. partial: some of it. not_expressible: the agent has no place for it. not_applicable: the item is not for this agent.",
    }),
    files: Type.Array(Type.String(), {
      description: "Repository files that carry the item for this agent.",
    }),
    detail: Type.String({ description: "Why, and what is left out." }),
  },
  { additionalProperties: false, title: "ContextItemCoverage" },
);

export const ContextAgentCoverageSchema = Type.Object(
  {
    agent: StringEnum(CONTEXT_AGENTS),
    docs: Type.Array(Type.String(), { description: "Vendor docs the mapping follows." }),
    notes: Type.Array(Type.String(), {
      description: "What else the agent reads, and conditions for loading the files.",
    }),
  },
  { additionalProperties: false, title: "ContextAgentCoverage" },
);

export const ContextCoverageSchema = Type.Object(
  {
    schema: Type.Literal("selfhost.context_coverage/v1"),
    agents: Type.Array(ContextAgentCoverageSchema),
    items: Type.Array(ContextItemCoverageSchema, {
      description: "One entry per item and agent, in item order then agent order.",
    }),
  },
  { additionalProperties: false, title: "ContextCoverage" },
);

export type ContextItemCoverage = Static<typeof ContextItemCoverageSchema>;
export type ContextAgentCoverage = Static<typeof ContextAgentCoverageSchema>;
export type ContextCoverage = Static<typeof ContextCoverageSchema>;

import { createHash } from "node:crypto";
import type { TeamPolicy } from "@selfhost/ledger";
import {
  type AgentVendor,
  type PolicyResponse,
  parseConfig,
  type ResolvedRule,
  type ResolvedSelfhostConfig,
} from "@selfhost/schema";

export interface RuleScope {
  /** Team id on the server. Overrides in [teams.<id>] apply to everyone in it. */
  team: string;
  /** Overrides of every [teams.<name>] that lists this person as a member apply too. */
  person?: string;
  /** Only rules for this agent. */
  agent?: AgentVendor;
}

/**
 * The rules after team overrides, applied in team name order so the result does not depend on
 * file order. Rules in mode off and rules for other agents are left out.
 */
export function effectiveRules(config: ResolvedSelfhostConfig, scope: RuleScope): ResolvedRule[] {
  const overrides = Object.entries(config.teams)
    .filter(
      ([name, team]) =>
        name === scope.team || (scope.person !== undefined && team.members.includes(scope.person)),
    )
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, team]) => team.rules);
  return config.rules
    .map((rule) => {
      let merged = rule;
      for (const rules of overrides) merged = { ...merged, ...rules[rule.id] };
      return merged;
    })
    .filter((rule) => rule.mode !== "off")
    .filter(
      (rule) =>
        scope.agent === undefined ||
        rule.agents.includes("all") ||
        rule.agents.includes(scope.agent),
    );
}

export function policyResponse(policy: TeamPolicy, scope: RuleScope): PolicyResponse {
  const parsed = parseConfig(policy.text);
  // PUT /v1/policy stores only text that parses, so this means the schema changed under it.
  if (!parsed.ok) throw new Error(`The stored selfhost.toml of team ${policy.team} is invalid`);
  return {
    hash: createHash("sha256").update(policy.text).digest("hex"),
    team: policy.team,
    text: policy.text,
    loaded_at: policy.updatedAt,
    config: parsed.config,
    effective_rules: effectiveRules(parsed.config, scope),
  };
}

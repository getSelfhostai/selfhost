import { createHash } from "node:crypto";
import type { TeamPolicy } from "@selfhost/ledger";
import { effectiveRules } from "@selfhost/policy";
import { type AgentVendor, type PolicyResponse, parseConfig } from "@selfhost/schema";

export interface RuleScope {
  /** Team id on the server. Overrides in [teams.<id>] apply to everyone in it. */
  team: string;
  /** Overrides of every [teams.<name>] that lists this person as a member apply too. */
  person?: string;
  /** Only rules for this agent. */
  agent?: AgentVendor;
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

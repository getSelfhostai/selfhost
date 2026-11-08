import { createHash } from "node:crypto";
import { compilePolicy } from "@selfhost/compile";
import type { TeamPolicy } from "@selfhost/ledger";
import { effectiveRules } from "@selfhost/policy";
import {
  type AgentVendor,
  type CompileVendor,
  type PolicyCoverageResponse,
  type PolicyResponse,
  parseConfig,
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

function storedConfig(policy: TeamPolicy): ResolvedSelfhostConfig {
  const parsed = parseConfig(policy.text);
  // PUT /v1/policy stores only text that parses, so this means the schema changed under it.
  if (!parsed.ok) throw new Error(`The stored selfhost.toml of team ${policy.team} is invalid`);
  return parsed.config;
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

export function policyResponse(policy: TeamPolicy, scope: RuleScope): PolicyResponse {
  const config = storedConfig(policy);
  return {
    hash: hashOf(policy.text),
    team: policy.team,
    text: policy.text,
    loaded_at: policy.updatedAt,
    config,
    effective_rules: effectiveRules(config, scope),
  };
}

/**
 * What `selfhost policy compile` would cover of the team's policy, per rule and vendor, with the
 * team's overrides applied. The dashboard shows each gap from this.
 */
export function policyCoverageResponse(
  policy: TeamPolicy,
  vendor?: CompileVendor,
): PolicyCoverageResponse {
  const { coverage } = compilePolicy(storedConfig(policy), {
    team: policy.team,
    ...(vendor ? { vendors: [vendor] } : {}),
  });
  return { hash: hashOf(policy.text), team: policy.team, coverage };
}

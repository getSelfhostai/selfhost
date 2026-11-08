import { checkToolCall, type PolicyHit, type ToolCall } from "@selfhost/policy";
import type { DecisionMode, PolicyDecision, ResolvedSelfhostConfig } from "@selfhost/schema";

/**
 * The one check `selfhost policy test` runs on a tool call, for single calls, test files and
 * replays alike: the rules and allow lists, then the built-in guardrails, as the pre-tool hook
 * runs them. The extra checkers (the package guard) are left out: they ask registries over the
 * network, so a test would not give the same answer twice. The environment is empty, so a test
 * gives the same answer on every machine.
 */
export async function checkCall(
  config: ResolvedSelfhostConfig,
  call: ToolCall,
  opts: { team?: string } = {},
): Promise<PolicyHit[]> {
  const { hits } = await checkToolCall(config, call, { ...opts, env: {} });
  return hits;
}

/** What selfhost decides on one call, from the hits of its check. */
export interface CallDecision {
  decision: PolicyDecision;
  /** Mode of a block or ask decision; null for allow. */
  mode: DecisionMode | null;
  /** Every rule that fired, enforce and observe alike, in evaluation order. */
  rules: string[];
}

const strongest = (hits: PolicyHit[]): PolicyDecision =>
  hits.some((hit) => hit.verdict === "block") ? "block" : "ask";

/**
 * Enforce hits decide first: block when one blocks, else ask. With no enforce hit the observe
 * hits decide the same way, in mode observe: recorded only, the call goes through. No hit is
 * allow.
 */
export function decide(hits: PolicyHit[]): CallDecision {
  const rules = [...new Set(hits.map((hit) => hit.rule_id))];
  const enforced = hits.filter((hit) => hit.mode === "enforce");
  if (enforced.length > 0) return { decision: strongest(enforced), mode: "enforce", rules };
  if (hits.length > 0) return { decision: strongest(hits), mode: "observe", rules };
  return { decision: "allow", mode: null, rules };
}

/** `block (enforce)`, `ask (observe)` or `allow`. */
export function describeDecision({ decision, mode }: Pick<CallDecision, "decision" | "mode">) {
  return mode === null ? decision : `${decision} (${mode})`;
}

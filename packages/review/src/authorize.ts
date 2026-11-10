import {
  type PersonRole,
  type PersonVerdict,
  type ResolvedSelfhostConfig,
  type ReviewItem,
  roleAllows,
} from "@selfhost/schema";

/** Who answers an item on a team server, as the server knows them. */
export interface Decider {
  /** The person the answer is recorded for. */
  by: string;
  /**
   * Their role in the item's team; undefined when they are not in it. Ignored when `trusted`.
   */
  role?: PersonRole;
  /**
   * The admin token or selfhost itself, which may name anyone as `by`: only the self-approval
   * check applies.
   */
  trusted?: boolean;
}

/**
 * Why `decider` may not give `verdict` on a team server's item, or undefined when they may. One
 * rule for every path an answer reaches the server by (the review item route, decision events
 * synced from a laptop, MCP), because only the server knows who a token belongs to:
 *
 * - An exception (approve or override) needs the owner or admin role in the item's team, and the
 *   person whose agent was blocked never approves their own unless the team's selfhost.toml sets
 *   [review] self_approve_exceptions = true. Denying one is always allowed.
 * - A proposal to add to the team's context (any answer) needs the owner or admin role.
 *
 * Items on one machine's own ledger (no team) are that person's to answer and never come here.
 */
export function decisionRefusal(
  item: Pick<ReviewItem, "kind" | "requested_by">,
  team: string,
  verdict: PersonVerdict,
  decider: Decider,
  config: Pick<ResolvedSelfhostConfig, "review">,
): string | undefined {
  const { by, role, trusted = false } = decider;
  const manages = trusted || (role !== undefined && roleAllows(role, "policy.write"));
  const yourRole = role === undefined ? `you are not in team ${team}` : `you are a ${role} there`;
  if (item.kind === "context_promotion") {
    if (manages) return undefined;
    return `Answering a proposal to the team's context needs the owner or admin role in team ${team}; ${yourRole}.`;
  }
  if (item.kind !== "exception" || (verdict !== "approve" && verdict !== "override")) {
    return undefined;
  }
  const requester = item.requested_by;
  if (requester !== undefined && requester.toLowerCase() === by.toLowerCase()) {
    if (config.review.self_approve_exceptions) return undefined;
    return "You cannot approve an exception your own agent asked for. An owner or admin of the team approves it, or the team's selfhost.toml sets [review] self_approve_exceptions = true.";
  }
  if (manages) return undefined;
  return `Approving another person's exception needs the owner or admin role in team ${team}; ${yourRole}.`;
}

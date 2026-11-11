import {
  type Handoff,
  type HandoffEventData,
  type PersonRole,
  type ReviewItem,
  roleAllows,
} from "@selfhost/schema";
import type { Decider } from "./authorize.js";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Where an item's owners come from once its run changed hands. */
export const RUN_OWNER_ROUTE = "the run's owner";

/** The new owner as the server knows them: their role in the run's team, if any. */
export interface HandoffTarget {
  id: string;
  role?: PersonRole;
}

/** Why a handoff was refused: the caller may not make it (403), or the new owner is wrong (400). */
export type HandoffRefusal = { by: "caller" | "target"; message: string };

/**
 * Why `decider` may not hand a run in `team`, held by `owner`, to `to`, or undefined when they
 * may. One rule for every path a handoff reaches the server by, because only the server knows
 * who a token belongs to:
 *
 * - The run's owner with the work role in its team may hand it over, and so may an owner or
 *   admin of the team (the role that manages it). The admin token (trusted) may too.
 * - The new owner must be in the run's team with the work role: someone without access to the
 *   run's repo cannot hold it. Handing a run to the person who holds it changes nothing.
 */
export function handoffRefusal(
  run: { team: string; owner: string | null },
  to: HandoffTarget,
  decider: Decider,
): HandoffRefusal | undefined {
  const { by, role, trusted = false } = decider;
  const owns = run.owner !== null && same(run.owner, by);
  if (!trusted) {
    if (role === undefined) return { by: "caller", message: `You are not in team ${run.team}.` };
    const manages = roleAllows(role, "policy.write");
    if (!(owns && roleAllows(role, "work")) && !manages) {
      const holder = run.owner === null ? "nobody's yet" : `${run.owner}'s`;
      return {
        by: "caller",
        message: `Handing a run over needs to hold it (it is ${holder}) or the owner or admin role in team ${run.team}; you are a ${role} there.`,
      };
    }
  }
  if (to.role === undefined || !roleAllows(to.role, "work")) {
    return {
      by: "target",
      message: `${to.id} is not in team ${run.team} with the work role, so they cannot hold its runs. Add them to the team first (selfhost team add ${to.id}).`,
    };
  }
  if (run.owner !== null && same(run.owner, to.id)) {
    return { by: "target", message: `${to.id} already holds this run.` };
  }
  return undefined;
}

/**
 * Why `caller` may not take over `handoff`, or undefined when they may. Only the new owner takes
 * a run over, as themselves and while still in its team: the next step runs under their own
 * login, never the previous owner's, so the admin token cannot take over for anyone.
 */
export function takeoverRefusal(
  handoff: Pick<Handoff, "to" | "team">,
  caller: Decider,
): string | undefined {
  if (caller.trusted) {
    return `A takeover runs under the new owner's own login: ${handoff.to} runs selfhost takeover with their own person token.`;
  }
  if (!same(caller.by, handoff.to)) {
    return `This run was handed to ${handoff.to}; only they can take it over.`;
  }
  if (handoff.team !== null && (caller.role === undefined || !roleAllows(caller.role, "work"))) {
    return `You are no longer in team ${handoff.team} with the work role, so you cannot take over its runs.`;
  }
  return undefined;
}

/**
 * The item as it reads once its run changed hands, or undefined when the handoff does not move
 * it. Items routed to the run's person move to the new owner; items a route, the team or the
 * fallback picked keep their people and gain the new owner; items nobody was named for go to the
 * new owner. Exceptions stay with the team's approvers, and their requester stays who asked.
 */
export function handedOverItem(
  item: ReviewItem,
  handoff: Pick<HandoffEventData, "owner" | "previous_owner">,
  now: Date,
): ReviewItem | undefined {
  if (item.state !== "open" || item.kind === "exception") return undefined;
  const route = item.route;
  const why = `handed over from ${handoff.previous_owner}`;
  const ownedByRun =
    route === undefined ||
    route.step === "none" ||
    (route.step === "owner" &&
      (route.from === "the session's person" || route.from === RUN_OWNER_ROUTE));
  const owners = ownedByRun
    ? [handoff.owner]
    : item.owners.some((owner) => same(owner, handoff.owner))
      ? item.owners
      : [...item.owners, handoff.owner];
  const next: ReviewItem = {
    ...item,
    owners,
    ...(ownedByRun ? { route: { step: "owner" as const, from: RUN_OWNER_ROUTE, why } } : {}),
    updated_at: now.toISOString(),
  };
  const changed =
    JSON.stringify(next.owners) !== JSON.stringify(item.owners) ||
    JSON.stringify(next.route) !== JSON.stringify(item.route);
  return changed ? next : undefined;
}

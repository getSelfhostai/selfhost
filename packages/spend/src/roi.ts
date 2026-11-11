import {
  type LedgerEvent,
  ROI_DEFINITION,
  ROI_SCHEMA,
  ROI_UNKNOWN,
  type RoiAgentRow,
  type RoiResponse,
} from "@selfhost/schema";
import { COST_SOURCE_PREFERENCE, pairGatewayCosts } from "./sources.js";

/**
 * Cost per merged pull request (ROI_RULES in @selfhost/schema has the definition in words).
 * Pure: the readers build the input from the ledger (roi-query.ts) or from events in memory
 * (roiInputFromEvents, for selfhost scan), and the same input gives the same report.
 */

/** Spend of one session (or of no session) from one source, inside or outside the range. */
export interface RoiCost {
  session?: string;
  agent?: string;
  model?: string;
  source: string;
  /** owner/name in lower case. */
  repo?: string;
  team?: string;
  usd: number;
  /** Spent at or after from and before to. */
  in_window: boolean;
  /**
   * A gateway request whose agent-side copy was dropped (rule 1 in sources.ts); its session is
   * the copy's. Always counted, whatever source the session's other rows come from.
   */
  paired?: boolean;
}

export interface RoiPullEvent {
  url: string;
  kind: "pr.opened" | "pr.merged" | "pr.closed";
  /** ISO 8601. */
  ts: string;
  repo?: string;
  team?: string;
  /** agent.vendor when the pull request was attributed to an agent. */
  agent?: string;
  model?: string;
}

/** A session joined to a pull request by an event that carries both. */
export interface RoiLink {
  session: string;
  pr: string;
}

export interface RoiInput {
  /** Only this team's pull requests and pooled spend; null for every event. */
  team: string | null;
  from: Date;
  to: Date;
  costs: RoiCost[];
  pulls: RoiPullEvent[];
  links: RoiLink[];
}

export type RoiReport = Omit<RoiResponse, "baseline">;

interface Pull {
  url: string;
  repo?: string;
  team?: string;
  agent?: string;
  model?: string;
  mergedAt?: number;
  closedAt?: number;
}

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;
const perPr = (usd: number, prs: number) => (prs > 0 ? round(usd / prs) : null);
const sum = (values: Iterable<number>) => {
  let total = 0;
  for (const value of values) total += value;
  return total;
};

function rank(source: string): number {
  const index = (COST_SOURCE_PREFERENCE as readonly string[]).indexOf(source);
  return index === -1 ? COST_SOURCE_PREFERENCE.length : index;
}

/** The rows of one source per session, as oneSourcePerSession keeps them. */
function oneSource(costs: RoiCost[]): RoiCost[] {
  const key = (cost: RoiCost) => `${cost.agent ?? ""}\n${cost.session}`;
  const chosen = new Map<string, string>();
  for (const cost of costs) {
    if (!cost.session || cost.paired) continue;
    const current = chosen.get(key(cost));
    if (
      current === undefined ||
      rank(cost.source) < rank(current) ||
      (rank(cost.source) === rank(current) && cost.source < current)
    ) {
      chosen.set(key(cost), cost.source);
    }
  }
  return costs.filter(
    (cost) => !cost.session || cost.paired || chosen.get(key(cost)) === cost.source,
  );
}

const KIND_ORDER = { "pr.merged": 0, "pr.closed": 1, "pr.opened": 2 } as const;

/** One record per URL: merge and close times, and repo, team and agent, merged events first. */
function pullsOf(events: RoiPullEvent[]): Map<string, Pull> {
  const sorted = [...events].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.ts.localeCompare(b.ts),
  );
  const pulls = new Map<string, Pull>();
  for (const event of sorted) {
    const pull = pulls.get(event.url) ?? { url: event.url };
    const at = Date.parse(event.ts);
    if (event.kind === "pr.merged" && (pull.mergedAt === undefined || at < pull.mergedAt)) {
      pull.mergedAt = at;
    }
    if (event.kind === "pr.closed" && (pull.closedAt === undefined || at < pull.closedAt)) {
      pull.closedAt = at;
    }
    pull.repo ??= event.repo;
    pull.team ??= event.team;
    if (pull.agent === undefined && event.agent) {
      pull.agent = event.agent;
      if (event.model) pull.model = event.model;
    }
    pulls.set(event.url, pull);
  }
  return pulls;
}

const NO_REPO = "";

/** The largest key of a usd map, alphabetical on a tie. */
function largest(map: Map<string, number>): string | undefined {
  let best: [string, number] | undefined;
  for (const entry of map) {
    if (!best || entry[1] > best[1] || (entry[1] === best[1] && entry[0] < best[0])) best = entry;
  }
  return best?.[0];
}

export function costPerMergedPr(input: RoiInput): RoiReport {
  const from = input.from.getTime();
  const to = input.to.getTime();
  const inRange = (at: number | undefined) => at !== undefined && at >= from && at < to;
  const ours = (team: string | undefined) => input.team === null || team === input.team;

  const prsOf = new Map<string, Set<string>>();
  const sessionsOf = new Map<string, Set<string>>();
  for (const { session, pr } of input.links) {
    prsOf.set(session, (prsOf.get(session) ?? new Set()).add(pr));
    sessionsOf.set(pr, (sessionsOf.get(pr) ?? new Set()).add(session));
  }

  // Each session's spend by agent and model, whenever it was spent. Only the scope's own spend:
  // another team's session linked to one of its pull requests does not charge it.
  const costs = oneSource(input.costs);
  const spendOf = new Map<string, Map<string, number>>();
  for (const cost of costs) {
    if (!cost.session || !prsOf.has(cost.session) || !ours(cost.team)) continue;
    const spend = spendOf.get(cost.session) ?? new Map<string, number>();
    const key = `${cost.agent ?? ""}\n${cost.model ?? ""}`;
    spend.set(key, (spend.get(key) ?? 0) + cost.usd);
    spendOf.set(cost.session, spend);
  }

  /** A pull request's part of its sessions' spend, by agent and model. */
  const ownSpend = (url: string) => {
    const parts = new Map<string, number>();
    for (const session of sessionsOf.get(url) ?? []) {
      const share = 1 / (prsOf.get(session)?.size ?? 1);
      for (const [key, usd] of spendOf.get(session) ?? []) {
        parts.set(key, (parts.get(key) ?? 0) + usd * share);
      }
    }
    return parts;
  };

  const pulls = [...pullsOf(input.pulls).values()].filter((pull) => ours(pull.team));
  const isAgent = (pull: Pull) => pull.agent !== undefined || sessionsOf.has(pull.url);
  const merged = pulls.filter((pull) => inRange(pull.mergedAt));
  const agentPrs = merged.filter(isAgent);
  const closed = pulls.filter(
    (pull) => pull.mergedAt === undefined && inRange(pull.closedAt) && isAgent(pull),
  );

  // Spend that produced no merged pull request, pooled by repo.
  const pool = new Map<string, number>();
  const addToPool = (repo: string | undefined, usd: number) =>
    pool.set(repo ?? NO_REPO, (pool.get(repo ?? NO_REPO) ?? 0) + usd);
  let unattributed = 0;
  for (const cost of costs) {
    if (!cost.in_window || !cost.agent || !ours(cost.team)) continue;
    if (cost.session && prsOf.has(cost.session)) continue;
    unattributed += cost.usd;
    addToPool(cost.repo, cost.usd);
  }
  let closedUsd = 0;
  for (const pull of closed) {
    const usd = sum(ownSpend(pull.url).values());
    closedUsd += usd;
    addToPool(pull.repo, usd);
  }

  const shared = new Map<string, number>();
  let unallocated = 0;
  for (const [repo, usd] of pool) {
    const takers = agentPrs.filter((pull) => repo === NO_REPO || pull.repo === repo);
    if (takers.length === 0) unallocated += usd;
    for (const pull of takers) {
      shared.set(pull.url, (shared.get(pull.url) ?? 0) + usd / takers.length);
    }
  }

  let attributed = 0;
  const rows = new Map<string, { agent: string; model: string; prs: number; usd: number }>();
  for (const pull of agentPrs) {
    const parts = ownSpend(pull.url);
    const own = sum(parts.values());
    attributed += own;
    const vendors = new Map<string, number>();
    for (const [key, usd] of parts) {
      const vendor = key.split("\n")[0] ?? "";
      if (vendor) vendors.set(vendor, (vendors.get(vendor) ?? 0) + usd);
    }
    const agent = pull.agent ?? largest(vendors) ?? ROI_UNKNOWN;
    const models = new Map<string, number>();
    for (const [key, usd] of parts) {
      const [vendor = "", model = ""] = key.split("\n");
      if (model && vendor === agent) models.set(model, (models.get(model) ?? 0) + usd);
    }
    const model = pull.model ?? largest(models) ?? ROI_UNKNOWN;
    const key = `${agent}\n${model}`;
    const row = rows.get(key) ?? { agent, model, prs: 0, usd: 0 };
    row.prs += 1;
    row.usd += own + (shared.get(pull.url) ?? 0);
    rows.set(key, row);
  }
  const sharedUsd = sum(shared.values());
  const cost = attributed + sharedUsd;

  const byAgent = [...rows.values()]
    .map(
      (row): RoiAgentRow => ({
        agent: row.agent,
        model: row.model,
        merged_prs: row.prs,
        cost_usd: round(row.usd),
        cost_per_merged_pr: perPr(row.usd, row.prs),
      }),
    )
    .sort(
      (a, b) =>
        b.cost_usd - a.cost_usd || a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model),
    );

  return {
    schema: ROI_SCHEMA,
    definition: ROI_DEFINITION,
    team: input.team,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    merged_prs: agentPrs.length,
    cost_usd: round(cost),
    cost_per_merged_pr: perPr(cost, agentPrs.length),
    human_prs: merged.length - agentPrs.length,
    closed_prs: closed.length,
    attributed_usd: round(attributed),
    shared_usd: round(sharedUsd),
    unattributed_usd: round(unattributed),
    closed_usd: round(closedUsd),
    unallocated_usd: round(unallocated),
    by_agent: byAgent,
  };
}

/** The pull request an event names: links.pr_url, else its pr target. */
export function prUrlOf(event: LedgerEvent): string | undefined {
  return event.links?.pr_url ?? (event.target?.type === "pr" ? event.target.value : undefined);
}

const PR_KINDS = new Set(["pr.opened", "pr.merged", "pr.closed"]);
const LINK_KINDS = new Set(["commit.created", ...PR_KINDS]);

/** The input from events in memory, as selfhost scan has them. */
export function roiInputFromEvents(
  events: Iterable<LedgerEvent>,
  range: { team: string | null; from: Date; to: Date },
): RoiInput {
  const input: RoiInput = { ...range, costs: [], pulls: [], links: [] };
  const seen = new Set<string>();
  const list = [...events];
  const { copies, twins } = pairGatewayCosts(list);
  for (const event of list) {
    if (copies.has(event.id)) continue;
    const repo = (event.repo ?? twins.get(event.id)?.repo)?.toLowerCase();
    const where = {
      ...(repo ? { repo } : {}),
      ...(event.team ? { team: event.team } : {}),
    };
    const at = Date.parse(event.ts);
    if (event.kind === "cost.recorded" && event.cost) {
      const twin = twins.get(event.id);
      const session = event.session_id || twin?.session_id;
      input.costs.push({
        ...(session ? { session } : {}),
        ...(event.agent ? { agent: event.agent.vendor } : {}),
        ...(event.model ? { model: event.model } : {}),
        source: event.source,
        ...where,
        usd: event.cost.usd,
        in_window: at >= range.from.getTime() && at < range.to.getTime(),
        ...(twin ? { paired: true } : {}),
      });
      continue;
    }
    const url = prUrlOf(event);
    if (!url || !LINK_KINDS.has(event.kind)) continue;
    if (event.session_id && !seen.has(`${event.session_id}\n${url}`)) {
      seen.add(`${event.session_id}\n${url}`);
      input.links.push({ session: event.session_id, pr: url });
    }
    if (PR_KINDS.has(event.kind)) {
      input.pulls.push({
        url,
        kind: event.kind as RoiPullEvent["kind"],
        ts: event.ts,
        ...where,
        ...(event.agent ? { agent: event.agent.vendor } : {}),
        ...(event.agent && event.model ? { model: event.model } : {}),
      });
    }
  }
  return input;
}

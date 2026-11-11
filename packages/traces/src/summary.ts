import { type AgentRef, currentOwner, type LedgerEvent, type RunSummary } from "@selfhost/schema";
import {
  type CacheTipOptions,
  cacheTips,
  cacheTipText,
  oneSourcePerSession,
  sessionCaches,
} from "@selfhost/spend";

/** A run with no session.ended counts as over once its last event is this old. */
export const RUN_IDLE_MS = 30 * 60_000;

const time = (event: LedgerEvent) => Date.parse(event.ts);

function mostCommon(values: Iterable<string | undefined>): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | undefined;
  for (const [value, n] of counts)
    if (best === undefined || n > (counts.get(best) ?? 0)) best = value;
  return best;
}

/**
 * When the run ended: its session.ended, else its last event once that is `idleMs` old.
 * undefined while it is still going.
 */
export function runEnd(
  events: readonly LedgerEvent[],
  now: Date,
  idleMs = RUN_IDLE_MS,
): { at: string; by: "session_end" | "idle" } | undefined {
  const ended = events.filter((e) => e.kind === "session.ended").sort((a, b) => time(b) - time(a));
  if (ended[0]) return { at: ended[0].ts, by: "session_end" };
  const last = [...events].sort((a, b) => time(b) - time(a))[0];
  if (last && time(last) <= now.getTime() - idleMs) return { at: last.ts, by: "idle" };
  return undefined;
}

/** The model requests of a run, one source when several reported the same session. */
export function runCosts(events: readonly LedgerEvent[]): LedgerEvent[] {
  return oneSourcePerSession(events).filter((e) => e.kind === "cost.recorded" && e.cost);
}

export function tokensOf(event: LedgerEvent): number {
  const cost = event.cost;
  if (!cost) return 0;
  return cost.input_tokens + cost.output_tokens + cost.cache_read_tokens + cost.cache_write_tokens;
}

/** The summary of one run from all of its events, as GET /v1/runs/{run_id} returns it. */
export function summarizeRun(
  id: string,
  events: readonly LedgerEvent[],
  options: { now: Date; team?: string | null; idleMs?: number; cacheTip?: CacheTipOptions },
): RunSummary {
  const sorted = [...events].sort((a, b) => time(a) - time(b) || a.id.localeCompare(b.id));
  const costs = runCosts(sorted);
  const agentEvent =
    sorted.find((e) => e.agent && e.agent.vendor !== "other") ?? sorted.find((e) => e.agent);
  const agent: AgentRef | null = agentEvent?.agent ? { ...agentEvent.agent } : null;
  const usd = costs.reduce((sum, e) => sum + (e.cost?.usd ?? 0), 0);
  // The run's requests as one session, whatever session ids its sources gave them.
  const [cache] = sessionCaches(costs.map((e) => ({ ...e, session_id: id })));
  const tip = cache && options.cacheTip ? cacheTips([cache], options.cacheTip)[0] : undefined;
  const person = sorted.find((e) => e.actor.kind === "person")?.actor.id ?? null;
  return {
    id,
    agent,
    model: mostCommon(costs.map((e) => e.model)) ?? sorted.find((e) => e.model)?.model ?? null,
    person,
    owner: currentOwner(sorted, person),
    team: options.team ?? mostCommon(sorted.map((e) => e.team)) ?? null,
    repo: sorted.find((e) => e.repo)?.repo ?? null,
    started_at: sorted[0]?.ts ?? options.now.toISOString(),
    ended_at: runEnd(sorted, options.now, options.idleMs)?.at ?? null,
    cost_usd: Math.round(usd * 1e6) / 1e6,
    tokens: costs.reduce((sum, e) => sum + tokensOf(e), 0),
    cache_hit_rate:
      cache?.hit_rate === null || cache === undefined
        ? null
        : Math.round(cache.hit_rate * 1e6) / 1e6,
    cache_tip: tip ? cacheTipText(tip) : null,
  };
}

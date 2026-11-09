import { AGENT_VENDORS, CACHE_MISS_CAUSES, EVENT_SCHEMA, type LedgerEvent } from "@selfhost/schema";
import { dimensionValue, groupKey, type SpendDimension, type SpendGroup } from "./group.js";

/**
 * Prompt cache hit rates from the token counts cost.recorded events already carry. A hit rate
 * is cache reads over all input: cache reads, uncached input and cache writes. A session that
 * reported no cache read and no cache write at all is unknown, not 0: some agents' logs carry no
 * cache fields, and their importers write 0 for both. Pass events through oneSourcePerSession
 * first, as for spend.
 */

export interface CacheStats {
  /** Input tokens read from the prompt cache. */
  read_tokens: number;
  /** Input tokens that were not cache reads: uncached input plus cache writes. */
  fresh_tokens: number;
  /** read / (read + fresh), 0 to 1, over requests of known sessions; null when there are none. */
  hit_rate: number | null;
  /** Requests of sessions that reported cache tokens. */
  requests: number;
  /** Requests of sessions that reported none, left out of the rate. */
  unknown_requests: number;
}

export interface SessionCache extends CacheStats {
  session_id: string;
  agent: string;
  person: string;
  /** The model most of its requests went to. */
  model: string;
  usd: number;
  first_ts: string;
  last_ts: string;
  /** Hit rate of its last `recent` requests (see sessionCaches), null when unknown. */
  recent_hit_rate: number | null;
  /** Times the model changed from one request to the next. */
  model_switches: number;
}

export interface CacheTipOptions {
  /** Hit rate under which a session gets a tip, 0 to 1. */
  floor: number;
  /** Sessions that cost less get none. */
  minUsd: number;
}

export interface CacheDropOptions {
  floor: number;
  /** Requests a session needs before it can raise one. */
  minRequests: number;
  /** Only sessions with a request at or after this time. */
  since?: Date;
}

/** Requests the recent hit rate looks at, so a collapse shows while the session runs. */
export const CACHE_RECENT_REQUESTS = 10;

const isCost = (
  event: LedgerEvent,
): event is LedgerEvent & { cost: NonNullable<LedgerEvent["cost"]> } =>
  event.kind === "cost.recorded" && event.cost !== undefined;

/** The session an event's cache rate is judged by: agent and session id, else the event itself. */
export function cacheSessionKey(event: LedgerEvent): string {
  return event.session_id
    ? `${event.agent?.vendor ?? ""}\n${event.session_id}`
    : `event\n${event.id}`;
}

export function hitRate(read: number, fresh: number): number | null {
  return read + fresh > 0 ? read / (read + fresh) : null;
}

/** Sessions with at least one cache read or cache write: their agent reports cache tokens. */
export function knownCacheSessions(events: Iterable<LedgerEvent>): Set<string> {
  const known = new Set<string>();
  for (const event of events) {
    if (!isCost(event)) continue;
    if (event.cost.cache_read_tokens > 0 || event.cost.cache_write_tokens > 0) {
      known.add(cacheSessionKey(event));
    }
  }
  return known;
}

export function emptyCacheStats(): CacheStats {
  return { read_tokens: 0, fresh_tokens: 0, hit_rate: null, requests: 0, unknown_requests: 0 };
}

function add(stats: CacheStats, event: LedgerEvent, known: ReadonlySet<string>): void {
  if (!isCost(event)) return;
  if (!known.has(cacheSessionKey(event))) {
    stats.unknown_requests += 1;
    return;
  }
  stats.requests += 1;
  stats.read_tokens += event.cost.cache_read_tokens;
  stats.fresh_tokens += event.cost.input_tokens + event.cost.cache_write_tokens;
  stats.hit_rate = hitRate(stats.read_tokens, stats.fresh_tokens);
}

/** Hit rate over every cost.recorded event given. */
export function cacheStats(
  events: Iterable<LedgerEvent>,
  known: ReadonlySet<string> = knownCacheSessions(events),
): CacheStats {
  const stats = emptyCacheStats();
  for (const event of events) add(stats, event, known);
  return stats;
}

/** Hit rate per group of the spend dimensions, keyed by groupKey, and over all of them. */
export function cacheByGroup(
  events: readonly LedgerEvent[],
  by: readonly SpendDimension[],
): { total: CacheStats; groups: Map<string, CacheStats & { group: SpendGroup }> } {
  const known = knownCacheSessions(events);
  const total = emptyCacheStats();
  const groups = new Map<string, CacheStats & { group: SpendGroup }>();
  for (const event of events) {
    if (!isCost(event)) continue;
    add(total, event, known);
    const group: SpendGroup = {};
    for (const dimension of by) group[dimension] = dimensionValue(event, dimension);
    const key = groupKey(group, by);
    let stats = groups.get(key);
    if (!stats) {
      stats = { group, ...emptyCacheStats() };
      groups.set(key, stats);
    }
    add(stats, event, known);
  }
  return { total, groups };
}

const byTime = (a: LedgerEvent, b: LedgerEvent) =>
  Date.parse(a.ts) - Date.parse(b.ts) || a.id.localeCompare(b.id);

function mostCommon(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = "unknown";
  for (const [value, n] of counts) if (n > (counts.get(best) ?? 0)) best = value;
  return best;
}

/**
 * One entry per session with a session id and a cost.recorded event, highest spend first. The
 * recent hit rate covers its last `recent` requests (default CACHE_RECENT_REQUESTS).
 */
export function sessionCaches(
  events: readonly LedgerEvent[],
  recent = CACHE_RECENT_REQUESTS,
): SessionCache[] {
  const known = knownCacheSessions(events);
  const sessions = new Map<string, LedgerEvent[]>();
  for (const event of events) {
    if (!isCost(event) || !event.session_id) continue;
    const key = cacheSessionKey(event);
    const list = sessions.get(key) ?? [];
    list.push(event);
    sessions.set(key, list);
  }
  const result: SessionCache[] = [];
  for (const list of sessions.values()) {
    list.sort(byTime);
    const first = list[0] as LedgerEvent;
    const last = list.at(-1) as LedgerEvent;
    const models = list.map((event) => event.model ?? "unknown");
    let switches = 0;
    for (let i = 1; i < models.length; i++) if (models[i] !== models[i - 1]) switches++;
    const person = list.find((event) => event.actor.kind === "person")?.actor.id ?? "unknown";
    result.push({
      session_id: first.session_id ?? "",
      agent: first.agent?.vendor ?? "unknown",
      person,
      model: mostCommon(models),
      usd: list.reduce((sum, event) => sum + (event.cost?.usd ?? 0), 0),
      first_ts: first.ts,
      last_ts: last.ts,
      ...cacheStats(list, known),
      recent_hit_rate: cacheStats(list.slice(-recent), known).hit_rate,
      model_switches: switches,
    });
  }
  return result.sort((a, b) => b.usd - a.usd || a.session_id.localeCompare(b.session_id));
}

/** Sessions that cost at least minUsd at a known hit rate under the floor, highest spend first. */
export function cacheTips(
  sessions: readonly SessionCache[],
  opts: CacheTipOptions,
): SessionCache[] {
  return sessions.filter(
    (session) =>
      session.hit_rate !== null && session.hit_rate < opts.floor && session.usd >= opts.minUsd,
  );
}

/**
 * Long sessions whose recent hit rate dropped under the floor: at least minRequests known
 * requests, and a request at or after `since` when given. A session that never reported cache
 * tokens raises nothing.
 */
export function cacheDrops(
  sessions: readonly SessionCache[],
  opts: CacheDropOptions,
): SessionCache[] {
  const since = opts.since?.getTime();
  return sessions.filter(
    (session) =>
      session.requests >= opts.minRequests &&
      session.recent_hit_rate !== null &&
      session.recent_hit_rate < opts.floor &&
      (since === undefined || Date.parse(session.last_ts) >= since),
  );
}

const pct = (rate: number) => `${Math.round(rate * 100)}%`;
const shortId = (id: string) => (id.length > 12 ? id.slice(0, 8) : id);

/** The likely cause first when the session switched models, then the usual ones. */
function causes(session: SessionCache): string {
  const switched =
    session.model_switches > 0
      ? `it switched models ${session.model_switches === 1 ? "once" : `${session.model_switches} times`}; `
      : "";
  return `${switched}usually ${CACHE_MISS_CAUSES}`;
}

/** One line for `selfhost spend` and the run view. */
export function cacheTipText(session: SessionCache): string {
  return (
    `Session ${shortId(session.session_id)} (${session.agent}, ${session.person}) cost ` +
    `$${session.usd.toFixed(2)} at ${pct(session.hit_rate ?? 0)} cache hits: ${causes(session)}.`
  );
}

/** The message of a cache_hit_low alert. */
export function cacheDropText(session: SessionCache, floor: number): string {
  return (
    `Prompt cache hit rate of session ${shortId(session.session_id)} (${session.agent}, ` +
    `${session.person}) fell to ${pct(session.recent_hit_rate ?? 0)} over its last requests, ` +
    `under ${pct(floor)} after ${session.requests} requests: ${causes(session)}.`
  );
}

/** alert.raised data.alert of a cache drop. It stays in the ledger and in `selfhost tail`. */
export const CACHE_HIT_ALERT = "cache_hit_low";

/**
 * The alert.raised event for a cache drop, one per session: its id comes from the session alone
 * (`id` is stableEventId from @selfhost/ledger), so a later check records nothing new.
 */
export function cacheAlert(
  session: SessionCache,
  floor: number,
  now: Date,
  id: (ts: string, key: string) => string,
  source: "cli" | "server",
): LedgerEvent {
  const vendor = AGENT_VENDORS.find((candidate) => candidate === session.agent);
  return {
    id: id(session.first_ts, `${CACHE_HIT_ALERT}:${session.agent}:${session.session_id}`),
    schema: EVENT_SCHEMA,
    ts: now.toISOString(),
    source,
    kind: "alert.raised",
    actor: { kind: "system", id: "selfhost" },
    ...(vendor ? { agent: { vendor } } : {}),
    ...(session.model !== "unknown" ? { model: session.model } : {}),
    session_id: session.session_id,
    data: {
      alert: CACHE_HIT_ALERT,
      owner: session.person,
      hit_rate: round(session.hit_rate),
      recent_hit_rate: round(session.recent_hit_rate),
      floor,
      requests: session.requests,
      usd: Math.round(session.usd * 1e6) / 1e6,
      model_switches: session.model_switches,
      message: cacheDropText(session, floor),
    },
  };
}

const round = (rate: number | null) => (rate === null ? null : Math.round(rate * 1e4) / 1e4);

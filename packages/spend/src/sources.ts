import type { EventSource, LedgerEvent } from "@selfhost/schema";

/**
 * Which cost.recorded events count, when several sources report the same spend. Two rules, in
 * this order (the docs' "Where spend comes from" has the same text):
 *
 * 1. One request, one source: the model gateway. A request that went through the gateway is
 *    reported by the gateway and, on the agent's side, by its session log, OpenTelemetry or a
 *    hook. The gateway's event counts and the agent-side copies do not. The gateway saw the
 *    request as it was billed, but it knows no session, so its event takes the session of its
 *    agent-side copy. The two are joined on the request itself: the person (when both name
 *    one), prompt tokens (uncached input, cache reads and cache writes together, which both
 *    sides count the same way) and output tokens, the n-th request of a size on one side with
 *    the n-th of that size on the other, when they are no more than GATEWAY_PAIR_WINDOW_MS
 *    apart. Requests under GATEWAY_PAIR_MIN_TOKENS are never joined: sizes that small repeat
 *    too often to tell two requests apart. No id joins them: the gateways log their own request
 *    ids, not the vendor's message id the session log keeps.
 * 2. One session, one source: for the rest, a session (agent vendor and session id) reported by
 *    more than one source counts the events of one, in the order of COST_SOURCE_PREFERENCE. That
 *    keeps the session log for sessions that did not go through the gateway.
 *
 * Every reader applies both: oneSourcePerSession here, countedCostsSql for the server's SQL
 * (usage, ROI), and the ROI report's own rows.
 */

/**
 * Ingest paths in order of preference when more than one reports a session's spend.
 * OpenTelemetry first: it sees every request, including the background ones Claude Code leaves
 * out of its transcripts. Then local logs, hooks, the model gateway and the vendor audit feed,
 * whose request types say less.
 */
export const COST_SOURCE_PREFERENCE: readonly EventSource[] = [
  "otel",
  "local_log",
  "hook",
  "gateway",
  "vendor_api",
];

/** Sources that read a request on the agent's side; the gateway reads it in transit. */
export const AGENT_COST_SOURCES: readonly EventSource[] = ["otel", "local_log", "hook"];

/**
 * How far apart a gateway request and its agent-side copy can be. The gateway stamps the start
 * of the request, a session log the first line of the response, which a long response or a
 * retry can push minutes later.
 */
export const GATEWAY_PAIR_WINDOW_MS = 10 * 60_000;

/** Smallest request (prompt plus output tokens) joined to a gateway request. */
export const GATEWAY_PAIR_MIN_TOKENS = 100;

function rank(source: string): number {
  const index = (COST_SOURCE_PREFERENCE as readonly string[]).indexOf(source);
  return index === -1 ? COST_SOURCE_PREFERENCE.length : index;
}

/** The person, prompt and output tokens of a request, or undefined for one too small to join. */
function requestSize(event: LedgerEvent): string | undefined {
  const cost = event.cost;
  if (event.kind !== "cost.recorded" || !cost) return undefined;
  const prompt = cost.input_tokens + cost.cache_read_tokens + cost.cache_write_tokens;
  return prompt + cost.output_tokens >= GATEWAY_PAIR_MIN_TOKENS
    ? `${prompt}:${cost.output_tokens}`
    : undefined;
}

/** The person a request was made for, or "" for a key or agent with none. */
const personOf = (event: LedgerEvent) => (event.actor.kind === "person" ? event.actor.id : "");

const byTimeThenId = (a: LedgerEvent, b: LedgerEvent) =>
  a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export interface GatewayPairs {
  /** Agent-side copies of gateway requests: these do not count. */
  copies: Set<string>;
  /** Gateway event id to its agent-side copy from the most preferred source. */
  twins: Map<string, LedgerEvent>;
}

/** Joins each gateway request to its agent-side copies (rule 1). */
export function pairGatewayCosts(events: Iterable<LedgerEvent>): GatewayPairs {
  const groups = new Map<string, LedgerEvent[]>();
  for (const event of events) {
    if (event.source !== "gateway" && !AGENT_COST_SOURCES.includes(event.source)) continue;
    const size = requestSize(event);
    if (size === undefined) continue;
    const key = `${event.source}\n${size}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  const pairs: GatewayPairs = { copies: new Set(), twins: new Map() };
  for (const [key, gateway] of groups) {
    if (!key.startsWith("gateway\n")) continue;
    const size = key.slice("gateway\n".length);
    gateway.sort(byTimeThenId);
    for (const source of AGENT_COST_SOURCES) {
      const agent = (groups.get(`${source}\n${size}`) ?? []).sort(byTimeThenId);
      for (let index = 0; index < Math.min(gateway.length, agent.length); index++) {
        const request = gateway[index] as LedgerEvent;
        const copy = agent[index] as LedgerEvent;
        if (Math.abs(Date.parse(copy.ts) - Date.parse(request.ts)) > GATEWAY_PAIR_WINDOW_MS) {
          continue;
        }
        const people = [personOf(request), personOf(copy)];
        if (people[0] && people[1] && people[0] !== people[1]) continue;
        pairs.copies.add(copy.id);
        const twin = pairs.twins.get(request.id);
        if (!twin || rank(copy.source) < rank(twin.source)) pairs.twins.set(request.id, copy);
      }
    }
  }
  return pairs;
}

/** The gateway event as it counts: with the session, repo and request type of its copy. */
function adopt(request: LedgerEvent, copy: LedgerEvent): LedgerEvent {
  const type = request.data?.request_type;
  const copyType = copy.data?.request_type;
  return {
    ...request,
    ...(request.session_id || !copy.session_id ? {} : { session_id: copy.session_id }),
    ...(request.agent || !copy.agent ? {} : { agent: copy.agent }),
    ...(request.repo || !copy.repo ? {} : { repo: copy.repo }),
    ...((type === undefined || type === "unknown") && copyType !== undefined
      ? { data: { ...request.data, request_type: copyType } }
      : {}),
  };
}

/**
 * The cost.recorded events that count, by the two rules at the top of this file: a gateway
 * request once, as the gateway's event (carrying its copy's session), and otherwise one source
 * per session. Events without a session id, and events of other kinds, are kept as they are.
 * Order is preserved.
 */
export function oneSourcePerSession(events: Iterable<LedgerEvent>): LedgerEvent[] {
  const list = [...events];
  const { copies, twins } = pairGatewayCosts(list);
  const counted = list.flatMap((event) => {
    if (copies.has(event.id)) return [];
    const twin = twins.get(event.id);
    return [twin ? adopt(event, twin) : event];
  });
  const chosen = new Map<string, string>();
  const sessionOf = (event: LedgerEvent) =>
    event.kind === "cost.recorded" && event.session_id && !twins.has(event.id)
      ? `${event.agent?.vendor ?? ""}\n${event.session_id}`
      : undefined;
  for (const event of counted) {
    const session = sessionOf(event);
    if (session === undefined) continue;
    const current = chosen.get(session);
    if (
      current === undefined ||
      rank(event.source) < rank(current) ||
      (rank(event.source) === rank(current) && event.source < current)
    ) {
      chosen.set(session, event.source);
    }
  }
  return counted.filter((event) => {
    const session = sessionOf(event);
    return session === undefined || chosen.get(session) === event.source;
  });
}

/** SQL CASE giving a source's place in COST_SOURCE_PREFERENCE. */
export function sourceRankSql(column = "source"): string {
  return `CASE ${column} ${COST_SOURCE_PREFERENCE.map(
    (source, index) => `WHEN '${source}' THEN ${index}`,
  ).join(" ")} ELSE ${COST_SOURCE_PREFERENCE.length} END`;
}

/**
 * Rule 1 in SQL: CTEs that read `input` (cost.recorded rows with id, ts, source, session_id and
 * body) and end in `<prefix>_counted`, every input row except the agent-side copies of gateway
 * requests, plus `paired` (a gateway row with a copy), `counted_session` and `counted_repo` (its
 * own, or its copy's). Rule 2 is left to the caller, over the rows that are not paired, as the pairing
 * is the same however the caller groups. Pairs the same events as pairGatewayCosts.
 */
export function countedCostsSql(input: string, prefix = "counted"): string {
  const tokens = (field: string) => `coalesce((body#>>'{cost,${field}}')::numeric, 0)`;
  const agent = AGENT_COST_SOURCES.map((source) => `'${source}'`).join(", ");
  return `${prefix}_sized AS (
  SELECT *,
    ${tokens("input_tokens")} + ${tokens("cache_read_tokens")} + ${tokens("cache_write_tokens")}
      AS req_prompt,
    ${tokens("output_tokens")} AS req_output
  FROM ${input}
),
${prefix}_ranked AS (
  SELECT id, ts, source, session_id, body->>'repo' AS repo_name, req_prompt, req_output,
    CASE WHEN body#>>'{actor,kind}' = 'person' THEN body#>>'{actor,id}' ELSE '' END AS person,
    row_number() OVER (PARTITION BY source, req_prompt, req_output ORDER BY ts, id) AS req_rank
  FROM ${prefix}_sized
  WHERE req_prompt + req_output >= ${GATEWAY_PAIR_MIN_TOKENS} AND source IN ('gateway', ${agent})
),
${prefix}_pairs AS (
  SELECT c.id AS copy_id, g.id AS gateway_id, c.session_id AS copy_session,
    c.repo_name AS copy_repo,
    ${sourceRankSql("c.source")} AS copy_rank
  FROM ${prefix}_ranked c
  JOIN ${prefix}_ranked g
    ON g.source = 'gateway' AND c.source IN (${agent})
    AND g.req_prompt = c.req_prompt AND g.req_output = c.req_output AND g.req_rank = c.req_rank
    AND abs(extract(epoch FROM (c.ts - g.ts))) * 1000 <= ${GATEWAY_PAIR_WINDOW_MS}
    AND (c.person = '' OR g.person = '' OR c.person = g.person)
),
${prefix}_counted AS (
  SELECT s.*, p.gateway_id IS NOT NULL AS paired,
    coalesce(nullif(s.session_id, ''), p.copy_session) AS counted_session,
    coalesce(s.body->>'repo', p.copy_repo) AS counted_repo
  FROM ${prefix}_sized s
  LEFT JOIN LATERAL (
    SELECT gateway_id, copy_session, copy_repo FROM ${prefix}_pairs
    WHERE gateway_id = s.id ORDER BY copy_rank, copy_id LIMIT 1
  ) p ON true
  WHERE s.id NOT IN (SELECT copy_id FROM ${prefix}_pairs)
)`;
}

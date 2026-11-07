import { DEFAULT_SHARE_THRESHOLD, type WasteFlag } from "@selfhost/spend";
import { percent, plural, tokens, usd } from "../format.js";
import type { AgentVendor } from "./attribution.js";
import type { CostRecord, SessionStats } from "./sessions.js";

export const LEAK_KINDS = ["status_loop", "cache_miss", "retry_loop", "oversized_context"] as const;

export type LeakKind = (typeof LEAK_KINDS)[number];

/** Thresholds for the leak heuristics. */
export const LEAK_RULES = {
  /** The same tool call with the same input, this many times in a row. */
  repeatedCalls: 6,
  /** Cache reads under this share of the context sent, after a session's first request. */
  cacheReadShare: 0.5,
  /** Sessions with fewer requests are too short to judge their cache use. */
  cacheMinRequests: 5,
  /** And sessions that sent less context than this, after the first request. */
  cacheMinContext: 50_000,
  /** Requests re-sent after an API error in one session. */
  retryRequests: 2,
  /** Context tokens (input, cache read and cache write) in one request. */
  contextTokens: 150_000,
  /** Requests at or over contextTokens in one session. */
  contextRequests: 3,
} as const;

const STATUS_TYPES: ReadonlySet<string> = new Set(["status_line", "background"]);

export interface LeakSession {
  vendor: AgentVendor;
  session_id: string;
  /** Spend on the requests the rule picked out in this session. */
  usd: number;
}

export interface LeakFinding {
  kind: LeakKind;
  title: string;
  /** One sentence of totals. Never prompts, commands or code. */
  detail: string;
  /** The rule that fired. */
  rule: string;
  /** Spend on the requests the rule picked out. */
  usd: number;
  /** usd as a share of all spend in the window. */
  share: number;
  /** UTC days the request type first crossed the waste detector's threshold. */
  days: string[];
  /** Highest spend first. */
  sessions: LeakSession[];
}

export interface LeakScan {
  /** Highest spend first. */
  findings: LeakFinding[];
  /** Spend on requests any rule picked out, each request counted once. */
  usd: number;
  /** Short reasons per session (`vendor\nsession id`), highest spend first. */
  reasons: Map<string, string[]>;
}

interface Hit {
  session: SessionStats;
  costs: CostRecord[];
  reason: string;
}

interface Detector {
  kind: LeakKind;
  title: string;
  rule: string;
  hits: Hit[];
  days: string[];
  detail: (hits: Hit[], spend: string) => string;
}

const sumUsd = (costs: CostRecord[]) => costs.reduce((total, cost) => total + cost.usd, 0);
/** 150000 as "150k", for the rules. */
const thousands = (count: number) => `${Math.round(count / 1000)}k`;
export const sessionKey = (vendor: string, sessionId: string) => `${vendor}\n${sessionId}`;

function statusLines(sessions: SessionStats[], waste: WasteFlag[], totalUsd: number): Detector {
  const days = [
    ...new Set(waste.filter((flag) => STATUS_TYPES.has(flag.request_type)).map((f) => f.day)),
  ];
  const hits: Hit[] = [];
  if (days.length > 0) {
    for (const session of sessions) {
      const costs = session.costs.filter((cost) => STATUS_TYPES.has(cost.requestType));
      if (costs.length === 0) continue;
      const share = session.usd > 0 ? sumUsd(costs) / session.usd : 0;
      hits.push({
        session,
        costs,
        reason: `status and background requests, ${percent(share)} of its spend`,
      });
    }
  }
  return {
    kind: "status_loop",
    title: "Status-line and background loops",
    rule: `status_line or background requests at ${percent(DEFAULT_SHARE_THRESHOLD)} or more of a day's spend`,
    hits,
    days,
    detail: (found, spend) =>
      `${spend} (${percent(totalUsd > 0 ? sumUsd(found.flatMap((hit) => hit.costs)) / totalUsd : 0)} of spend) went to requests the agents made on their own, crossing ${percent(DEFAULT_SHARE_THRESHOLD)} of a day's spend on ${days.join(", ")}.`,
  };
}

/** Runs of the same tool call with the same input, at least LEAK_RULES.repeatedCalls long. */
function pollingLoops(sessions: SessionStats[]): Detector {
  const hits: Hit[] = [];
  const longest = new Map<Hit, { length: number; tool: string }>();
  for (const session of sessions) {
    const picked = new Map<string, CostRecord>();
    let best: { length: number; tool: string } | undefined;
    let start = 0;
    for (let index = 1; index <= session.tools.length; index++) {
      const current = session.tools[index];
      const first = session.tools[start];
      if (current && first && current.key === first.key) continue;
      const length = index - start;
      const last = session.tools[index - 1];
      if (first && last && length >= LEAK_RULES.repeatedCalls) {
        for (const cost of session.costs) {
          if (cost.ts >= first.ts && cost.ts <= last.ts) picked.set(cost.id, cost);
        }
        if (!best || length > best.length) best = { length, tool: first.name };
      }
      start = index;
    }
    if (!best) continue;
    const hit = {
      session,
      costs: [...picked.values()],
      reason: `the same ${best.tool} call ${best.length} times in a row`,
    };
    hits.push(hit);
    longest.set(hit, best);
  }
  return {
    kind: "status_loop",
    title: "Status polling loops",
    rule: `the same tool call with the same input ${LEAK_RULES.repeatedCalls} or more times in a row`,
    hits,
    days: [],
    detail: (found, spend) => {
      const top = found
        .map((hit) => longest.get(hit))
        .reduce((a, b) => (b && (!a || b.length > a.length) ? b : a), undefined);
      return `${plural(found.length, "session")} made the same tool call ${LEAK_RULES.repeatedCalls} or more times in a row (longest: ${top?.length ?? 0} ${top?.tool ?? ""} calls); ${spend} of spend during those runs.`;
    },
  };
}

function cacheMisses(sessions: SessionStats[]): Detector {
  const hits: Hit[] = [];
  let read = 0;
  let sent = 0;
  for (const session of sessions) {
    if (session.costs.length < LEAK_RULES.cacheMinRequests) continue;
    // The first request writes the cache; judge the ones after it.
    const costs = session.costs.slice(1);
    const context = costs.reduce((total, cost) => total + cost.context, 0);
    const cached = costs.reduce((total, cost) => total + cost.cacheRead, 0);
    if (context < LEAK_RULES.cacheMinContext || cached / context >= LEAK_RULES.cacheReadShare) {
      continue;
    }
    read += cached;
    sent += context;
    hits.push({ session, costs, reason: `cache misses, ${percent(cached / context)} from cache` });
  }
  return {
    kind: "cache_miss",
    title: "Cache misses",
    rule: `under ${percent(LEAK_RULES.cacheReadShare)} of context read from cache after the first request, in sessions with ${LEAK_RULES.cacheMinRequests} or more requests and ${thousands(LEAK_RULES.cacheMinContext)} or more context tokens`,
    hits,
    days: [],
    detail: (found, spend) =>
      `${plural(found.length, "session")} read ${percent(sent > 0 ? read / sent : 0)} of ${found.length === 1 ? "its" : "their"} context from cache after the first request; ${spend} of spend.`,
  };
}

function retries(sessions: SessionStats[], waste: WasteFlag[]): Detector {
  const days = [...new Set(waste.filter((f) => f.request_type === "retry").map((f) => f.day))];
  const hits: Hit[] = [];
  for (const session of sessions) {
    const costs = session.costs.filter((cost) => cost.requestType === "retry");
    if (costs.length === 0) continue;
    if (costs.length < LEAK_RULES.retryRequests && days.length === 0) continue;
    hits.push({
      session,
      costs,
      reason: `${plural(costs.length, "request")} re-sent after API errors`,
    });
  }
  return {
    kind: "retry_loop",
    title: "Retry loops",
    rule: `${LEAK_RULES.retryRequests} or more requests re-sent after API errors in one session, or retries at ${percent(DEFAULT_SHARE_THRESHOLD)} or more of a day's spend`,
    hits,
    days,
    detail: (found, spend) => {
      const count = found.reduce((total, hit) => total + hit.costs.length, 0);
      const crossed =
        days.length > 0
          ? ` Crossed ${percent(DEFAULT_SHARE_THRESHOLD)} of a day's spend on ${days.join(", ")}.`
          : "";
      return `${plural(count, "request")} ${count === 1 ? "was" : "were"} re-sent after API errors in ${plural(found.length, "session")}; ${spend} of spend.${crossed}`;
    },
  };
}

function oversizedContext(sessions: SessionStats[]): Detector {
  const hits: Hit[] = [];
  let largest = 0;
  for (const session of sessions) {
    const costs = session.costs.filter((cost) => cost.context >= LEAK_RULES.contextTokens);
    if (costs.length < LEAK_RULES.contextRequests) continue;
    const max = Math.max(...costs.map((cost) => cost.context));
    largest = Math.max(largest, max);
    hits.push({
      session,
      costs,
      reason: `${plural(costs.length, "request")} over ${thousands(LEAK_RULES.contextTokens)} tokens of context (largest ${tokens(max)})`,
    });
  }
  return {
    kind: "oversized_context",
    title: "Oversized context",
    rule: `${LEAK_RULES.contextRequests} or more requests in one session with ${thousands(LEAK_RULES.contextTokens)} or more tokens of context`,
    hits,
    days: [],
    detail: (found, spend) => {
      const count = found.reduce((total, hit) => total + hit.costs.length, 0);
      return `${plural(count, "request")} carried ${thousands(LEAK_RULES.contextTokens)} or more tokens of context (largest ${tokens(largest)}) in ${plural(found.length, "session")}; ${spend} of spend.`;
    },
  };
}

/**
 * Leak findings from session stats and the waste detector's flags: status-line and background
 * loops, status polling loops, cache misses, retry loops and oversized context.
 */
export function findLeaks(
  sessions: SessionStats[],
  waste: WasteFlag[],
  totalUsd: number,
): LeakScan {
  const detectors = [
    statusLines(sessions, waste, totalUsd),
    pollingLoops(sessions),
    cacheMisses(sessions),
    retries(sessions, waste),
    oversizedContext(sessions),
  ];
  const picked = new Map<string, number>();
  const reasons = new Map<string, { reason: string; usd: number }[]>();
  const findings: LeakFinding[] = [];
  for (const detector of detectors) {
    if (detector.hits.length === 0) continue;
    const spend = sumUsd(detector.hits.flatMap((hit) => hit.costs));
    for (const hit of detector.hits) {
      for (const cost of hit.costs) picked.set(cost.id, cost.usd);
      const key = sessionKey(hit.session.vendor, hit.session.sessionId);
      const list = reasons.get(key) ?? [];
      list.push({ reason: hit.reason, usd: sumUsd(hit.costs) });
      reasons.set(key, list);
    }
    findings.push({
      kind: detector.kind,
      title: detector.title,
      detail: detector.detail(detector.hits, usd(spend)),
      rule: detector.rule,
      usd: spend,
      share: totalUsd > 0 ? spend / totalUsd : 0,
      days: detector.days,
      sessions: detector.hits
        .map((hit) => ({
          vendor: hit.session.vendor,
          session_id: hit.session.sessionId,
          usd: sumUsd(hit.costs),
        }))
        .sort((a, b) => b.usd - a.usd || a.session_id.localeCompare(b.session_id)),
    });
  }
  findings.sort((a, b) => b.usd - a.usd || LEAK_KINDS.indexOf(a.kind) - LEAK_KINDS.indexOf(b.kind));
  let total = 0;
  for (const value of picked.values()) total += value;
  return {
    findings,
    usd: total,
    reasons: new Map(
      [...reasons].map(([key, list]) => [
        key,
        list.sort((a, b) => b.usd - a.usd).map((entry) => entry.reason),
      ]),
    ),
  };
}

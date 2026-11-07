import type { AgentVendor, LedgerEvent, PlanLimits } from "@selfhost/schema";

/** Subscription plans the limit forecast covers. */
export const PLANS = ["claude", "codex"] as const;

export type Plan = (typeof PLANS)[number];

/** The agent whose local logs carry each plan's usage. */
export const PLAN_AGENT: Record<Plan, AgentVendor> = { claude: "claude_code", codex: "codex" };

/** Each plan has a 5-hour session window and a weekly window. */
export const LIMIT_WINDOWS = ["session", "weekly"] as const;

export type LimitWindow = (typeof LIMIT_WINDOWS)[number];

export const HOUR_MS = 3_600_000;
export const SESSION_WINDOW_MS = 5 * HOUR_MS;
export const WEEK_MS = 7 * 24 * HOUR_MS;

export type PlanLimitTable = Partial<Record<Plan, Record<string, PlanLimits>>>;

/** A limit table and how to name it in output, for example "built-in table as of 2026-11-01". */
export interface LimitSource {
  label: string;
  limits: PlanLimitTable;
}

/** Day the built-in table was last checked. */
export const PLAN_LIMITS_AS_OF = "2026-11-01";

/**
 * Rough limits per tier in API-equivalent USD: what the same tokens would cost at list prices,
 * which is what the ledger records for subscription usage. Anthropic and OpenAI publish limits
 * as relative multiples and hours, not numbers, and change them often, so these are starting
 * points for people who have not hit a limit yet. A limit hit in the person's own logs replaces
 * them, and `[plans]` in selfhost.toml overrides them per tier.
 */
export const PLAN_LIMITS: Record<Plan, Record<string, PlanLimits>> = {
  claude: {
    pro: { session_usd: 10, weekly_usd: 75 },
    max_5x: { session_usd: 50, weekly_usd: 375 },
    max_20x: { session_usd: 200, weekly_usd: 1500 },
  },
  codex: {
    plus: { session_usd: 8, weekly_usd: 50 },
    business: { session_usd: 8, weekly_usd: 50 },
    pro: { session_usd: 60, weekly_usd: 400 },
  },
};

export const BUILT_IN_LIMITS: LimitSource = {
  label: `built-in table as of ${PLAN_LIMITS_AS_OF}`,
  limits: PLAN_LIMITS,
};

export function isPlan(value: unknown): value is Plan {
  return (PLANS as readonly unknown[]).includes(value);
}

/** The plan whose usage an event counts toward, from its agent. */
export function planOf(event: LedgerEvent): Plan | undefined {
  const vendor = event.agent?.vendor;
  return PLANS.find((plan) => PLAN_AGENT[plan] === vendor);
}

/** Tier names known for a plan across the given tables, in table order. */
export function knownTiers(plan: Plan, sources: readonly LimitSource[]): string[] {
  return [...new Set(sources.flatMap((source) => Object.keys(source.limits[plan] ?? {})))];
}

/** The first table that gives this tier a limit for the window. */
export function tableLimit(
  plan: Plan,
  tier: string,
  window: LimitWindow,
  sources: readonly LimitSource[],
): { usd: number; label: string } | undefined {
  const field = window === "session" ? "session_usd" : "weekly_usd";
  for (const source of sources) {
    const usd = source.limits[plan]?.[tier]?.[field];
    if (usd !== undefined && usd > 0) return { usd, label: source.label };
  }
  return undefined;
}

export const USAGE_LIMIT_ALERT = "usage_limit";

/** A usage limit the vendor reported in a person's logs. */
export interface LimitHit {
  ts: string;
  person: string;
  plan: Plan;
  /** Unknown windows count as the 5-hour session window, the one people hit most. */
  window: LimitWindow;
  /** When the vendor said the window resets, when it said. */
  resets_at?: string;
}

/** The `alert.raised` usage_limit events the importers write, oldest first. */
export function limitHits(events: Iterable<LedgerEvent>): LimitHit[] {
  const hits: LimitHit[] = [];
  for (const event of events) {
    if (event.kind !== "alert.raised" || event.data?.alert !== USAGE_LIMIT_ALERT) continue;
    const plan = planOf(event);
    if (!plan || event.actor.kind !== "person") continue;
    const resets = event.data.resets_at;
    hits.push({
      ts: event.ts,
      person: event.actor.id,
      plan,
      window: event.data.window === "weekly" ? "weekly" : "session",
      ...(typeof resets === "string" && Number.isFinite(Date.parse(resets))
        ? { resets_at: resets }
        : {}),
    });
  }
  return hits.sort((a, b) => a.ts.localeCompare(b.ts));
}

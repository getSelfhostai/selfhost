import type { AgentVendor, BreakEvenRow } from "@selfhost/schema";
import { PLAN_LIMITS, type Plan, WEEK_MS } from "./plans.js";

/** Day the seat prices below were last checked. */
export const SEAT_PRICES_AS_OF = "2026-11-12";

/** One seat tier: its list price a month and roughly how much API-rate use it holds. */
export interface SeatTier {
  tier: string;
  usd: number;
  /** Approximate API-rate spend a month before the tier's limits stop it. */
  limit_usd: number;
}

const MONTH_DAYS = 30;
const WEEKS_A_MONTH = (MONTH_DAYS * 86_400_000) / WEEK_MS;

/** A tier's monthly limit, from the weekly limit of the limit forecast's table. */
const monthly = (plan: Plan, tier: string) =>
  Math.round((PLAN_LIMITS[plan][tier]?.weekly_usd ?? 0) * WEEKS_A_MONTH);

/**
 * List prices of the subscription seats a coding agent can run on, by agent, cheapest first
 * (claude.com/pricing and chatgpt.com/pricing, monthly billing). Limits come from the dated
 * table the limit forecast uses (PLAN_LIMITS), so both read the same numbers.
 */
export const SEAT_TIERS: Partial<Record<AgentVendor, SeatTier[]>> = {
  claude_code: [
    { tier: "pro", usd: 20, limit_usd: monthly("claude", "pro") },
    { tier: "max_5x", usd: 100, limit_usd: monthly("claude", "max_5x") },
    { tier: "max_20x", usd: 200, limit_usd: monthly("claude", "max_20x") },
  ],
  codex: [
    { tier: "plus", usd: 20, limit_usd: monthly("codex", "plus") },
    { tier: "pro", usd: 200, limit_usd: monthly("codex", "pro") },
  ],
};

export const BREAK_EVEN_NOTES = [
  `Seat prices are list prices as of ${SEAT_PRICES_AS_OF}; limits are the approximate ones the plan limit forecast uses. Use past a tier's limit is priced at API rates on top of the seat.`,
  "Usage is every cost the ledger counts for the person: interactive sessions and background runs under their own login, at API rates. Cursor and Copilot bill seats and usage together, so they are not compared.",
];

export interface PersonAgentSpend {
  person: string;
  agent: string;
  usd: number;
}

const round = (usd: number) => Math.round(usd * 100) / 100;

/**
 * Seat or API key, for each person and agent with seat tiers: the range's spend scaled to 30
 * days, against what each tier would cost for the same use (its price, plus API rates for use
 * past its limit). The cheapest option wins; on a tie the API key does, since it needs no seat.
 * Heaviest use first.
 */
export function breakEven(
  spend: readonly PersonAgentSpend[],
  days: number,
  tiers: Partial<Record<string, SeatTier[]>> = SEAT_TIERS,
): BreakEvenRow[] {
  const rows: BreakEvenRow[] = [];
  for (const { person, agent, usd } of spend) {
    const seats = tiers[agent];
    if (!seats || seats.length === 0 || usd <= 0) continue;
    const month = (usd * MONTH_DAYS) / days;
    let best: { seat: SeatTier; cost: number } | undefined;
    for (const seat of seats) {
      const cost = seat.usd + Math.max(0, month - seat.limit_usd);
      if (!best || cost < best.cost) best = { seat, cost };
    }
    const cheapest = Math.min(...seats.map((seat) => seat.usd));
    const seatWins = best !== undefined && best.cost < month;
    rows.push({
      person,
      agent: agent as AgentVendor,
      api_usd: round(usd),
      monthly_api_usd: round(month),
      verdict: seatWins ? "seat" : "api",
      tier: seatWins && best ? best.seat.tier : null,
      seat_usd: seatWins && best ? best.seat.usd : null,
      monthly_cost_usd: round(seatWins && best ? best.cost : month),
      saving_usd: round(best ? Math.abs(month - best.cost) : 0),
      break_even_usd: cheapest,
      over_limit: seatWins && best !== undefined && month > best.seat.limit_usd,
    });
  }
  return rows.sort(
    (a, b) =>
      b.monthly_api_usd - a.monthly_api_usd ||
      a.person.localeCompare(b.person) ||
      a.agent.localeCompare(b.agent),
  );
}

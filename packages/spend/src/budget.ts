import type { Budget, BudgetPeriod, BudgetResponse } from "@selfhost/schema";

const DAY_MS = 86_400_000;
/** A forecast needs this share of the period behind it. */
const FORECAST_MIN_SHARE = 0.1;

/** The [budget] key that holds each period's limit. */
export const BUDGET_KEY = {
  day: "daily_usd",
  week: "weekly_usd",
  month: "monthly_usd",
} as const satisfies Record<BudgetPeriod, keyof Budget>;

/** Start and end (exclusive) of the UTC day, week from Monday, or calendar month holding `now`. */
export function periodRange(period: BudgetPeriod, now: Date): { from: Date; to: Date } {
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (period === "day") return { from: new Date(day), to: new Date(day + DAY_MS) };
  if (period === "week") {
    const monday = day - ((now.getUTCDay() + 6) % 7) * DAY_MS;
    return { from: new Date(monday), to: new Date(monday + 7 * DAY_MS) };
  }
  return {
    from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

/** Spend against a budget in the period holding `now`. No chargeback: this only shows it. */
export function budgetResponse(
  period: BudgetPeriod,
  now: Date,
  spent: number,
  limitUsd: number | undefined,
): BudgetResponse {
  const { from, to } = periodRange(period, now);
  const elapsed = (now.getTime() - from.getTime()) / (to.getTime() - from.getTime());
  const forecast = elapsed >= FORECAST_MIN_SHARE && spent > 0 ? spent / elapsed : null;
  return {
    period,
    from: from.toISOString(),
    to: to.toISOString(),
    spent_usd: round(spent),
    limit_usd: limitUsd ?? null,
    remaining_usd: limitUsd === undefined ? null : round(Math.max(limitUsd - spent, 0)),
    forecast_usd: forecast === null ? null : round(forecast),
  };
}

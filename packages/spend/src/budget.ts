import {
  BUDGET_PERIODS,
  BUDGET_SCOPES,
  type Budget,
  type BudgetEnforcement,
  type BudgetLine,
  type BudgetPeriod,
  type BudgetResponse,
  type BudgetScope,
} from "@selfhost/schema";

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

/** One budget and the spend against it; spent is null when the caller may not see it. */
export function budgetLine(input: {
  scope: BudgetScope;
  owner: string;
  period: BudgetPeriod;
  now: Date;
  limitUsd: number;
  spentUsd: number | null;
  enforcement: BudgetEnforcement;
  raise: string;
}): BudgetLine {
  const { from, to } = periodRange(input.period, input.now);
  const spent = input.spentUsd === null ? null : round(input.spentUsd);
  return {
    scope: input.scope,
    owner: input.owner,
    period: input.period,
    from: from.toISOString(),
    to: to.toISOString(),
    limit_usd: input.limitUsd,
    spent_usd: spent,
    remaining_usd: spent === null ? null : round(Math.max(input.limitUsd - spent, 0)),
    enforcement: input.enforcement,
    cut_off: input.enforcement === "gateway" && spent !== null && spent >= input.limitUsd,
    raise: input.raise,
  };
}

/** Cut-off budgets first, then the person's, the team's and the org's, shortest period first. */
export function sortBudgetLines(lines: BudgetLine[]): BudgetLine[] {
  const rank = (line: BudgetLine) =>
    (line.cut_off ? 0 : 100) +
    BUDGET_SCOPES.indexOf(line.scope) * 10 +
    BUDGET_PERIODS.indexOf(line.period);
  return [...lines].sort((a, b) => rank(a) - rank(b));
}

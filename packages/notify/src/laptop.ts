import { spendAlerts } from "@selfhost/gateway";
import { type Ledger, LedgerValidationError, stableEventId } from "@selfhost/ledger";
import type { Budget, LedgerEvent } from "@selfhost/schema";
import { oneSourcePerSession, periodRange } from "@selfhost/spend";
import type { Directory, NotifySettingsInForce } from "./job.js";

/** The team name spendAlerts writes into its messages, replaced for a laptop. */
const LAPTOP = "laptop";
/** The CLI's own actor on the alerts it raises, which a team server accepts from a laptop. */
const CLI_ACTOR = { kind: "system" as const, id: "selfhost" };

/**
 * The 50%, 80% and 100% alerts a laptop's own spend raises against [budget] in its
 * selfhost.toml, built by the team server's threshold code and written as the CLI writes its
 * alerts, so a later `selfhost join` can send them up. Each id names the person, so two laptops
 * over the same budget raise two alerts.
 */
export function laptopBudgetAlerts(
  costs: readonly LedgerEvent[],
  budget: Budget | undefined,
  person: string,
  now: Date,
): LedgerEvent[] {
  const counted = oneSourcePerSession([...costs]).filter(
    (event) => event.actor.kind === "person" && event.actor.id === person,
  );
  const spent = (period: "day" | "week" | "month") => {
    const start = periodRange(period, now).from.getTime();
    return counted
      .filter((event) => Date.parse(event.ts) >= start && Date.parse(event.ts) <= now.getTime())
      .reduce((sum, event) => sum + (event.cost?.usd ?? 0), 0);
  };
  return spendAlerts(LAPTOP, budget, spent, now).map((alert) => {
    const { team: _team, ...rest } = alert;
    const data = alert.data ?? {};
    const window = typeof data.window === "string" ? data.window : alert.ts;
    return {
      ...rest,
      id: stableEventId(window, `laptop-budget:${person}:${alert.id}`),
      source: "cli",
      actor: CLI_ACTOR,
      data: {
        ...data,
        owner: person,
        message: String(data.message ?? "").replace(`Team ${LAPTOP}`, "You"),
      },
    };
  });
}

/** The earliest spend a check reads: the start of this week or this month, whichever is first. */
export function budgetHistoryStart(now: Date): Date {
  return new Date(
    Math.min(periodRange("week", now).from.getTime(), periodRange("month", now).from.getTime()),
  );
}

/**
 * Raises the laptop's budget alerts from the ledger's spend. Returns the alerts that are new:
 * each share of each window is raised once, however often it runs.
 */
export async function raiseLaptopBudgetAlerts(
  ledger: Ledger,
  budget: Budget | undefined,
  person: string,
  now: Date,
): Promise<LedgerEvent[]> {
  if (!budget) return [];
  const costs: LedgerEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await ledger.query({
      kind: "cost.recorded",
      person,
      from: budgetHistoryStart(now).toISOString(),
      limit: 1000,
      cursor,
    });
    costs.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor);
  const alerts = laptopBudgetAlerts(costs, budget, person, now);
  if (alerts.length === 0) return [];
  try {
    const { accepted } = await ledger.append(alerts);
    const fresh = new Set(accepted);
    return alerts.filter((alert) => fresh.has(alert.id));
  } catch (error) {
    if (error instanceof LedgerValidationError) return [];
    throw error;
  }
}

/** A laptop's one person gets everything: their own items, unowned ones and budget alerts. */
export function laptopDirectory(person: string, settings: NotifySettingsInForce): Directory {
  const same = (other: string) => other.toLowerCase() === person.toLowerCase();
  return {
    settingsFor: async (other) => (same(other) ? settings : undefined),
    unowned: async () => [person],
    budgetOwners: async () => [person],
  };
}

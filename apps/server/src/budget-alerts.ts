import { spendAlerts } from "@selfhost/gateway";
import { databaseOf, type Ledger, LedgerValidationError } from "@selfhost/ledger";
import { highestShares } from "@selfhost/notify";
import { periodRange } from "@selfhost/spend";
import { costsOf, totalOf } from "./orgs.js";

/**
 * Budget alerts from the spend in the ledger: each team whose selfhost.toml sets [budget] gets
 * an alert at 50%, 80% and 100% of each period's budget, once per window, as the gateway raises
 * its own; when spend crosses several shares between two checks only the highest is raised.
 * They become budget items on the review list, for the budget owners. Requests are never stopped
 * here; only a gateway with [budget] mode = "hard" does that, and each alert's suggestion says
 * which of the two is in force.
 */
export async function raiseBudgetAlerts(
  ledger: Ledger,
  now: Date,
  /** Whether this server runs a gateway, so an alert says what holds a hard budget. */
  options: { gateway?: boolean } = {},
): Promise<number> {
  const db = databaseOf(ledger);
  const orgs = await db.query<{ id: string }>("SELECT id FROM orgs ORDER BY id");
  let raised = 0;
  for (const { id: org } of orgs) {
    for (const team of await ledger.teams.listTeams(org)) {
      let budget: Awaited<ReturnType<Ledger["orgs"]["effectivePolicy"]>>;
      try {
        budget = await ledger.orgs.effectivePolicy(team.id);
      } catch {
        continue;
      }
      const limits = budget?.config.budget;
      if (!limits) continue;
      // The month holds the week's and the day's spend too, except a week that began last month.
      const from = new Date(
        Math.min(periodRange("week", now).from.getTime(), periodRange("month", now).from.getTime()),
      );
      const costs = costsOf(
        await ledger.orgs.teamCosts(org, [team.id], from.toISOString(), now.toISOString()),
        team.id,
      );
      const spent = (period: "day" | "week" | "month") => {
        const start = periodRange(period, now).from.getTime();
        return totalOf(costs.filter((event) => Date.parse(event.ts) >= start)).usd;
      };
      const alerts = highestShares(spendAlerts(team.id, limits, spent, now, options));
      if (alerts.length === 0) continue;
      try {
        raised += (await ledger.append(alerts, { team: team.id })).accepted.length;
      } catch (error) {
        if (!(error instanceof LedgerValidationError)) throw error;
      }
    }
  }
  return raised;
}

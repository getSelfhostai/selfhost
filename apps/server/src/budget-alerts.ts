import { spendAlerts } from "@selfhost/gateway";
import { databaseOf, type Ledger, LedgerValidationError, stableEventId } from "@selfhost/ledger";
import { highestShares } from "@selfhost/notify";
import {
  EVENT_SCHEMA,
  type LedgerEvent,
  NAMED_AGENT_RULE_PREFIX,
  namedAgentActor,
  type ResolvedSelfhostConfig,
} from "@selfhost/schema";
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
      if (budget) raised += await raiseNamedAgentBudgets(ledger, org, team.id, budget.config, now);
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

/**
 * A budget alert for each named agent ([agents.<name>] daily_usd) that spent its day's budget,
 * once per UTC day, for its owner: the review list routes it to them. The agent's spend is the
 * cost of the requests it made as the actor, and of the sessions it acted in today.
 */
export async function raiseNamedAgentBudgets(
  ledger: Ledger,
  org: string,
  team: string,
  config: Pick<ResolvedSelfhostConfig, "agents">,
  now: Date,
): Promise<number> {
  const budgets = Object.entries(config.agents ?? {}).filter(
    ([, agent]) => agent.daily_usd !== undefined,
  );
  if (budgets.length === 0) return 0;
  const day = periodRange("day", now).from.toISOString();
  const costs = costsOf(await ledger.orgs.teamCosts(org, [team], day, now.toISOString()), team);
  const alerts: LedgerEvent[] = [];
  for (const [name, agent] of budgets) {
    const actor = namedAgentActor(name).id;
    const sessions = new Set(
      (
        await databaseOf(ledger).query<{ session_id: string }>(
          "SELECT DISTINCT session_id FROM events WHERE actor_id = $1 AND ts >= $2 AND session_id IS NOT NULL",
          [actor, day],
        )
      ).map((row) => row.session_id),
    );
    const spent = totalOf(
      costs.filter(
        (e) => e.actor.id === actor || (e.session_id !== undefined && sessions.has(e.session_id)),
      ),
    ).usd;
    const cap = agent.daily_usd as number;
    if (spent < cap) continue;
    alerts.push({
      id: stableEventId(day, `named_agent_budget\n${team}\n${name}\n${day}`),
      schema: EVENT_SCHEMA,
      ts: now.toISOString(),
      source: "server",
      kind: "alert.raised",
      actor: { kind: "system", id: "selfhost" },
      team,
      ...(org ? { org } : {}),
      data: {
        alert: "budget",
        owner: agent.owner,
        named_agent: name,
        cap: `${NAMED_AGENT_RULE_PREFIX}${name}`,
        window: "day",
        spent_usd: Math.round(spent * 100) / 100,
        budget_usd: cap,
        message: `Agent ${name} spent $${spent.toFixed(2)} of its $${cap.toFixed(2)} daily budget`,
        suggestion: `Raise [agents.${name}] daily_usd, or stop the agent until tomorrow. Nothing was cut off.`,
      },
    });
  }
  if (alerts.length === 0) return 0;
  try {
    return (await ledger.append(alerts, { team })).accepted.length;
  } catch (error) {
    if (!(error instanceof LedgerValidationError)) throw error;
    return 0;
  }
}

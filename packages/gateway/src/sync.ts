import { stableEventId } from "@selfhost/ledger";
import {
  EVENT_SCHEMA,
  type GatewayBudget,
  type GatewaySyncReport,
  type LedgerEvent,
  type ResolvedSelfhostConfig,
  type RouterTool,
} from "@selfhost/schema";
import { periodRange } from "@selfhost/spend";
import { keySettings, sameBudgets, sameSettings, teamLimits } from "./policy.js";
import type { GatewayClient, ManagedKey, ManagedTeam } from "./types.js";

/** One selfhost team as the sync needs it: its policy in use and who is in it. */
export interface TeamInput {
  team: string;
  config: ResolvedSelfhostConfig | undefined;
  people: readonly string[];
}

export interface SyncOptions {
  /** [integrations.router] providers of the server's own config, for teams that set none. */
  fallbackProviders?: string[];
  now?: () => Date;
}

export interface SyncResult {
  report: GatewaySyncReport;
  /** alert.raised events for budgets the gateway counted as spent. Ids are stable per window. */
  alerts: LedgerEvent[];
  teams: ManagedTeam[];
  keys: ManagedKey[];
}

/**
 * The alert a spent gateway budget raises: the review list's budget alert, so it shows there
 * once per owner and window.
 */
export const BUDGET_SPENT_ALERT = "budget_exceeded";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Brings the gateway in line with the team policies: one gateway team per selfhost team with the
 * team's hard limits, and every key selfhost issued with its limits, providers and on or off.
 * Only what differs is written, so running it again changes nothing. Keys are never created
 * here: a key's value goes to whoever asks for it (see issueKey), and to nobody else.
 */
export async function syncGateway(
  client: GatewayClient,
  inputs: readonly TeamInput[],
  options: SyncOptions = {},
): Promise<SyncResult> {
  const now = options.now?.() ?? new Date();
  const report: GatewaySyncReport = {
    at: now.toISOString(),
    teams: inputs.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    deactivated: 0,
    alerts: 0,
    errors: [],
  };
  const byTeam = new Map(inputs.map((input) => [input.team, input]));

  let teams: ManagedTeam[] = [];
  try {
    teams = await client.teams();
  } catch (error) {
    report.errors.push(`reading teams: ${message(error)}`);
    return { report, alerts: [], teams, keys: [] };
  }
  const existing = new Map(teams.map((team) => [team.team, team]));
  for (const input of inputs) {
    const wanted = client.held(teamLimits(input.config));
    const found = existing.get(input.team);
    try {
      if (!found) {
        const created = await client.createTeam(input.team, wanted);
        teams.push(created);
        existing.set(input.team, created);
        report.created++;
      } else if (!sameBudgets(found.budgets, wanted)) {
        await client.updateTeam(found, wanted);
        report.updated++;
      } else {
        report.unchanged++;
      }
    } catch (error) {
      report.errors.push(`team ${input.team}: ${message(error)}`);
    }
  }

  let keys: ManagedKey[] = [];
  try {
    keys = await client.keys();
  } catch (error) {
    report.errors.push(`reading keys: ${message(error)}`);
  }
  for (const key of keys) {
    const input = byTeam.get(key.team);
    // A team selfhost no longer has keeps its keys as they are.
    if (!input) continue;
    const wanted = keySettings(key, input.config, {
      inTeam: key.person === undefined || input.people.includes(key.person),
      ...(options.fallbackProviders ? { fallbackProviders: options.fallbackProviders } : {}),
    });
    const held = {
      ...wanted,
      budgets: client.held(wanted.budgets),
      providers: client.heldProviders(wanted.providers),
    };
    if (sameSettings(key, held)) {
      report.unchanged++;
      continue;
    }
    try {
      await client.updateKey(key, wanted);
      if (key.active && !wanted.active) report.deactivated++;
      else report.updated++;
    } catch (error) {
      report.errors.push(`key ${key.name}: ${message(error)}`);
    }
  }

  const alerts = budgetAlerts(client.tool, teams, keys, now).filter((alert) =>
    byTeam.has(alert.team ?? ""),
  );
  report.alerts = alerts.length;
  return { report, alerts, teams, keys };
}

function spent(budget: GatewayBudget): boolean {
  return budget.spent_usd !== null && budget.spent_usd >= budget.limit_usd;
}

/**
 * One alert.raised per gateway budget spent in its current window. The id depends on the owner,
 * the period and the window, so the sync raises each one once, however often it runs.
 */
export function budgetAlerts(
  tool: RouterTool,
  teams: readonly ManagedTeam[],
  keys: readonly ManagedKey[],
  now: Date,
): LedgerEvent[] {
  const alerts: LedgerEvent[] = [];
  const raise = (
    owner: string,
    team: string,
    budget: GatewayBudget,
    extra: { scope: string; person?: string; key_alias?: string; run_id?: string },
  ) => {
    const window =
      budget.period === "run" ? "run" : periodRange(budget.period, now).from.toISOString();
    const at = budget.period === "run" ? now.toISOString() : window;
    const who =
      extra.scope === "team"
        ? `Team ${team}`
        : extra.scope === "run"
          ? `Run ${extra.run_id}`
          : (extra.person ?? extra.key_alias ?? "A key");
    alerts.push({
      id: stableEventId(
        at,
        `gateway:alert.raised:budget:${tool}:${owner}:${budget.period}:${window}`,
      ),
      schema: EVENT_SCHEMA,
      ts: now.toISOString(),
      source: "gateway",
      kind: "alert.raised",
      actor: extra.person
        ? { kind: "person", id: extra.person }
        : { kind: "system", id: `${tool}:${extra.key_alias ?? `team:${team}`}` },
      team,
      ...(extra.run_id ? { run_id: extra.run_id } : {}),
      data: {
        alert: BUDGET_SPENT_ALERT,
        message: `${who} spent ${budget.period === "run" ? "the run's" : `the ${budget.period}'s`} gateway budget of $${budget.limit_usd}`,
        suggestion:
          budget.period === "run"
            ? "The gateway refuses this run's requests from now on."
            : "The gateway refuses these requests until the budget resets, or until [budget] in selfhost.toml is raised.",
        gateway: tool,
        scope: extra.scope,
        period: budget.period,
        window,
        ...(extra.person ? { owner: extra.person } : {}),
        limit_usd: budget.limit_usd,
        spent_usd: budget.spent_usd,
        // The gateway refuses this key's (or team's) requests until the window resets.
        enforced: true,
        ...(extra.key_alias ? { key_alias: extra.key_alias } : {}),
      },
    });
  };
  for (const team of teams) {
    for (const budget of team.budgets.filter(spent)) {
      raise(`team:${team.id}`, team.team, budget, { scope: "team" });
    }
  }
  for (const key of keys) {
    if (!key.active) continue;
    for (const budget of key.budgets.filter(spent)) {
      raise(`key:${key.id}`, key.team, budget, {
        scope: key.kind,
        key_alias: key.name,
        ...(key.person ? { person: key.person } : {}),
        ...(key.run_id ? { run_id: key.run_id } : {}),
      });
    }
  }
  return alerts;
}

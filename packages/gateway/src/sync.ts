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

/** What one budget alert is about: whose budget, which window, how much of it is spent. */
interface BudgetAlertInput {
  /** Who raises it: the gateway tool, or "selfhost" for spend read from the ledger. */
  raiser: RouterTool | "selfhost";
  /** The budget's owner, unique per budget: team:<id>, key:<id>. */
  owner: string;
  team: string;
  period: GatewayBudget["period"];
  limit_usd: number;
  spent_usd: number | null;
  scope: string;
  /** Share of the budget spent that raised it, for alerts below 100%. */
  percent?: number;
  /** true when a gateway refuses the requests until the window resets. */
  enforced: boolean;
  person?: string;
  key_alias?: string;
  run_id?: string;
}

const round = (usd: number) => Math.round(usd * 100) / 100;

/**
 * The alert.raised event for a budget: spent (budget_exceeded), or a share of it spent (budget).
 * The id depends on the owner, the period, the window and the share, so each is raised once.
 */
function budgetAlert(input: BudgetAlertInput, now: Date): LedgerEvent {
  const { period, team } = input;
  const window = period === "run" ? "run" : periodRange(period, now).from.toISOString();
  const at = period === "run" ? now.toISOString() : window;
  const who =
    input.scope === "team"
      ? `Team ${team}`
      : input.scope === "run"
        ? `Run ${input.run_id}`
        : (input.person ?? input.key_alias ?? "A key");
  const gateway = input.raiser === "selfhost" ? "" : "gateway ";
  const budget = `${period === "run" ? "the run's" : `the ${period}'s`} ${gateway}budget of $${input.limit_usd}`;
  const partial = input.percent !== undefined && input.percent < 100;
  const share = partial ? `:${input.percent}` : "";
  const over =
    input.spent_usd !== null && input.spent_usd > input.limit_usd
      ? input.spent_usd - input.limit_usd
      : undefined;
  return {
    id: stableEventId(
      at,
      `gateway:alert.raised:budget:${input.raiser}:${input.owner}:${period}:${window}${share}`,
    ),
    schema: EVENT_SCHEMA,
    ts: now.toISOString(),
    source: input.raiser === "selfhost" ? "server" : "gateway",
    kind: "alert.raised",
    actor: input.person
      ? { kind: "person", id: input.person }
      : // One actor per share, so the review list keeps a 50% and an 80% alert apart.
        { kind: "system", id: `${input.raiser}:${input.key_alias ?? `team:${team}`}${share}` },
    team,
    ...(input.run_id ? { run_id: input.run_id } : {}),
    data: {
      alert: partial ? "budget" : BUDGET_SPENT_ALERT,
      message: partial
        ? `${who} spent ${input.percent}% of ${budget}`
        : over !== undefined && input.raiser === "selfhost"
          ? `${who} went over ${budget}: $${round(input.spent_usd ?? 0)} spent, $${round(over)} over`
          : `${who} spent ${budget}`,
      suggestion: !input.enforced
        ? 'Requests go on: raise [budget] in selfhost.toml, or set [budget] mode = "hard" with a gateway to stop them.'
        : period === "run"
          ? "The gateway refuses this run's requests from now on."
          : "The gateway refuses these requests until the budget resets, or until [budget] in selfhost.toml is raised.",
      ...(input.raiser === "selfhost" ? {} : { gateway: input.raiser }),
      scope: input.scope,
      period,
      window,
      ...(input.person ? { owner: input.person } : {}),
      limit_usd: input.limit_usd,
      spent_usd: input.spent_usd,
      ...(input.percent !== undefined ? { percent: input.percent } : {}),
      enforced: input.enforced,
      ...(input.key_alias ? { key_alias: input.key_alias } : {}),
    },
  };
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
  for (const team of teams) {
    for (const budget of team.budgets.filter(spent)) {
      alerts.push(
        budgetAlert(
          {
            raiser: tool,
            owner: `team:${team.id}`,
            team: team.team,
            period: budget.period,
            limit_usd: budget.limit_usd,
            spent_usd: budget.spent_usd,
            scope: "team",
            // The gateway refuses this team's requests until the window resets.
            enforced: true,
          },
          now,
        ),
      );
    }
  }
  for (const key of keys) {
    if (!key.active) continue;
    for (const budget of key.budgets.filter(spent)) {
      alerts.push(
        budgetAlert(
          {
            raiser: tool,
            owner: `key:${key.id}`,
            team: key.team,
            period: budget.period,
            limit_usd: budget.limit_usd,
            spent_usd: budget.spent_usd,
            scope: key.kind,
            enforced: true,
            key_alias: key.name,
            ...(key.person ? { person: key.person } : {}),
            ...(key.run_id ? { run_id: key.run_id } : {}),
          },
          now,
        ),
      );
    }
  }
  return alerts;
}

/** Shares of a [budget] period, in percent, that raise an alert from the ledger's spend. */
export const BUDGET_ALERT_PERCENTS = [50, 80, 100] as const;

/**
 * The alerts a team's spend in the ledger raises against its [budget]: one at 50%, 80% and 100%
 * of each period's budget, each once per window, built like the gateway's own alerts. They come
 * from the spend selfhost records whether or not a gateway carries the traffic; requests go on.
 */
export function spendAlerts(
  team: string,
  budget: { daily_usd?: number; weekly_usd?: number; monthly_usd?: number } | undefined,
  spentUsd: (period: "day" | "week" | "month") => number,
  now: Date,
): LedgerEvent[] {
  if (!budget) return [];
  const limits = [
    ["day", budget.daily_usd],
    ["week", budget.weekly_usd],
    ["month", budget.monthly_usd],
  ] as const;
  const alerts: LedgerEvent[] = [];
  for (const [period, limit] of limits) {
    if (limit === undefined || limit <= 0) continue;
    const spent = spentUsd(period);
    for (const percent of BUDGET_ALERT_PERCENTS) {
      if (spent < (limit * percent) / 100) continue;
      alerts.push(
        budgetAlert(
          {
            raiser: "selfhost",
            owner: `team:${team}`,
            team,
            period,
            limit_usd: limit,
            spent_usd: spent,
            scope: "team",
            percent,
            enforced: false,
          },
          now,
        ),
      );
    }
  }
  return alerts;
}

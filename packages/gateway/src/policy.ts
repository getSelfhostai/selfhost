import {
  AGENT_VENDORS,
  type Budget,
  type BudgetMode,
  type GatewayBudget,
  type GatewayKeyKind,
  type ResolvedSelfhostConfig,
} from "@selfhost/schema";
import type { BudgetLimit, KeyOwner, KeySettings } from "./types.js";

/** Every name selfhost gives on the gateway starts with this; anything else is left alone. */
export const NAME_PREFIX = "selfhost:";

/** A run's key works this long, then the gateway refuses it. */
export const RUN_KEY_TTL_MS = 24 * 60 * 60 * 1000;

export const teamName = (team: string) => `${NAME_PREFIX}${team}`;

export function keyName(owner: KeyOwner): string {
  const tail =
    owner.kind === "person" ? `:${owner.person}` : owner.kind === "run" ? `:${owner.run_id}` : "";
  return `${NAME_PREFIX}${owner.kind}:${owner.team}${tail}`;
}

/**
 * Metadata put on each key. Bifrost copies it onto every request log of the key, which is how
 * usage reaches the ledger with its person, team and run.
 */
export function keyMetadata(owner: KeyOwner): Record<string, string> {
  return {
    selfhost_kind: owner.kind,
    selfhost_team: owner.team,
    ...(owner.person ? { selfhost_person: owner.person } : {}),
    ...(owner.run_id ? { selfhost_run: owner.run_id } : {}),
    ...(owner.agent ? { selfhost_agent: owner.agent } : {}),
  };
}

const KINDS: readonly GatewayKeyKind[] = ["person", "team", "run"];

/** The owner a managed key's metadata names, or undefined for a key selfhost did not make. */
export function ownerFromMetadata(metadata: unknown): KeyOwner | undefined {
  if (metadata === null || typeof metadata !== "object") return undefined;
  const m = metadata as Record<string, unknown>;
  const kind = KINDS.find((k) => k === m.selfhost_kind);
  const team = typeof m.selfhost_team === "string" ? m.selfhost_team : undefined;
  if (!kind || !team) return undefined;
  const person = typeof m.selfhost_person === "string" ? m.selfhost_person : undefined;
  const run = typeof m.selfhost_run === "string" ? m.selfhost_run : undefined;
  if (kind === "person" && !person) return undefined;
  if (kind === "run" && !run) return undefined;
  const agent = AGENT_VENDORS.find((vendor) => vendor === m.selfhost_agent);
  return {
    kind,
    team,
    ...(person ? { person } : {}),
    ...(run ? { run_id: run } : {}),
    ...(agent ? { agent } : {}),
  };
}

export const budgetMode = (budget: Budget | undefined): BudgetMode => budget?.mode ?? "alert";

function periods(budget: Pick<Budget, "daily_usd" | "weekly_usd" | "monthly_usd"> | undefined) {
  const limits: BudgetLimit[] = [];
  if (budget?.daily_usd !== undefined) limits.push({ period: "day", limit_usd: budget.daily_usd });
  if (budget?.weekly_usd !== undefined)
    limits.push({ period: "week", limit_usd: budget.weekly_usd });
  if (budget?.monthly_usd !== undefined)
    limits.push({ period: "month", limit_usd: budget.monthly_usd });
  return limits;
}

/** The team's hard limits on the gateway: none unless [budget] mode = hard. */
export function teamLimits(config: ResolvedSelfhostConfig | undefined): BudgetLimit[] {
  if (budgetMode(config?.budget) !== "hard") return [];
  return periods(config?.budget);
}

/**
 * The cap of a background run's key when [budget] sets no run_usd, or does not set mode = hard:
 * a run key always has one, so an agent in a sandbox cannot spend without a limit.
 */
export const DEFAULT_RUN_KEY_USD = 20;

/**
 * What a key should look like under the team's policy. Person keys get [budget.person], run keys
 * [budget] run_usd (DEFAULT_RUN_KEY_USD when unset, in any mode), team keys no limit of their own
 * (the team's limits cover them). A person key whose person left the team is turned off.
 */
export function keySettings(
  owner: KeyOwner,
  config: ResolvedSelfhostConfig | undefined,
  options: { inTeam?: boolean; fallbackProviders?: string[] } = {},
): KeySettings {
  const budget = config?.budget;
  const hard = budgetMode(budget) === "hard";
  let budgets: BudgetLimit[] = [];
  if (hard && owner.kind === "person") budgets = periods(budget?.person);
  if (owner.kind === "run") {
    budgets = [{ period: "run", limit_usd: budget?.run_usd ?? DEFAULT_RUN_KEY_USD }];
  }
  return {
    budgets,
    providers: config?.integrations?.router?.providers ?? options.fallbackProviders ?? [],
    active: owner.kind !== "person" || options.inTeam !== false,
  };
}

const sameLimits = (a: readonly { period: string; limit_usd: number }[], b: BudgetLimit[]) =>
  a.length === b.length &&
  [...a]
    .sort((x, y) => x.period.localeCompare(y.period))
    .every((limit, i) => {
      const other = [...b].sort((x, y) => x.period.localeCompare(y.period))[i];
      return other?.period === limit.period && Math.abs(other.limit_usd - limit.limit_usd) < 1e-9;
    });

export function sameBudgets(current: GatewayBudget[], wanted: BudgetLimit[]): boolean {
  return sameLimits(current, wanted);
}

export function sameSettings(
  current: { budgets: GatewayBudget[]; providers: string[]; active: boolean },
  wanted: KeySettings,
): boolean {
  return (
    current.active === wanted.active &&
    sameLimits(current.budgets, wanted.budgets) &&
    current.providers.join("\n") === wanted.providers.join("\n")
  );
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Ledger } from "@selfhost/ledger";
import {
  BUDGET_PERIODS,
  type Budget,
  type BudgetPeriod,
  type BudgetQuery,
  type BudgetResponse,
  type LedgerEvent,
  PAGE_LIMIT_MAX,
} from "@selfhost/schema";
import {
  BUDGET_KEY,
  budgetLine,
  budgetResponse,
  oneSourcePerSession,
  periodRange,
  sortBudgetLines,
} from "@selfhost/spend";
import { feedDir } from "../tail/feed.js";

/** Spend in the current day, week and month: everything in the ledger, and one person's. */
export type PeriodSpend = Record<BudgetPeriod, { all: number; person: number }>;

/**
 * What `selfhost import --watch` saves for the selfhost MCP server while it holds the embedded
 * ledger, which takes one process at a time: the spend get_budget answers from. Written after
 * each check, a few times a minute.
 */
export interface SpendSnapshot {
  schema: "selfhost.spend_snapshot/v1";
  written_at: string;
  pid: number;
  person: string;
  spent: PeriodSpend;
}

export const spendSnapshotPath = (env: NodeJS.ProcessEnv, configPath: string) =>
  join(feedDir(env, configPath), "spend.json");

async function costsSince(ledger: Ledger, from: Date, person?: string): Promise<LedgerEvent[]> {
  const costs: LedgerEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await ledger.query({
      kind: "cost.recorded",
      from: from.toISOString(),
      limit: PAGE_LIMIT_MAX,
      ...(person ? { person } : {}),
      ...(cursor ? { cursor } : {}),
    });
    costs.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor);
  return oneSourcePerSession(costs);
}

/** Spend in each period holding `now`, of everyone and of `person`. */
export async function periodSpend(ledger: Ledger, person: string, now: Date): Promise<PeriodSpend> {
  // The month holds the week's and the day's spend, except a week that began last month.
  const from = new Date(
    Math.min(periodRange("week", now).from.getTime(), periodRange("month", now).from.getTime()),
  );
  const [all, own] = await Promise.all([
    costsSince(ledger, from),
    costsSince(ledger, from, person),
  ]);
  const sum = (events: LedgerEvent[], period: BudgetPeriod) => {
    const start = periodRange(period, now).from.getTime();
    return events
      .filter((event) => Date.parse(event.ts) >= start)
      .reduce((total, event) => total + (event.cost?.usd ?? 0), 0);
  };
  return Object.fromEntries(
    BUDGET_PERIODS.map((period) => [period, { all: sum(all, period), person: sum(own, period) }]),
  ) as PeriodSpend;
}

/** Written to a temporary file and renamed, so a reader never sees half of it. */
export async function writeSpendSnapshot(
  ledger: Ledger,
  person: string,
  path: string,
  now: Date,
): Promise<void> {
  const snapshot: SpendSnapshot = {
    schema: "selfhost.spend_snapshot/v1",
    written_at: now.toISOString(),
    pid: process.pid,
    person,
    spent: await periodSpend(ledger, person, now),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function readSpendSnapshot(path: string): SpendSnapshot | undefined {
  try {
    const snapshot = JSON.parse(readFileSync(path, "utf8")) as SpendSnapshot;
    return snapshot?.schema === "selfhost.spend_snapshot/v1" ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

/**
 * get_budget on a solo laptop: the spend asked about against [budget] of the selfhost.toml the
 * hooks use here, which is the person's own. Nothing stops requests on a laptop, so every budget
 * is an alert; `where` names the file that sets it.
 */
export function soloBudget(
  query: BudgetQuery,
  spent: PeriodSpend,
  person: string,
  budget: Budget | undefined,
  now: Date,
  where: string,
): BudgetResponse {
  const period = query.period ?? "month";
  const own = query.person === undefined || query.person.toLowerCase() === person.toLowerCase();
  const response = budgetResponse(
    period,
    now,
    query.person === undefined ? spent[period].all : spent[period].person,
    own ? budget?.[BUDGET_KEY[period]] : undefined,
  );
  const lines = BUDGET_PERIODS.flatMap((p) => {
    const limit = budget?.[BUDGET_KEY[p]];
    if (limit === undefined) return [];
    return [
      budgetLine({
        scope: "person",
        owner: person,
        period: p,
        now,
        limitUsd: limit,
        spentUsd: spent[p].person,
        enforcement: "alert",
        raise: `You can raise it: [budget] ${BUDGET_KEY[p]} in ${where}.`,
      }),
    ];
  });
  if (lines.length > 0) response.budgets = sortBudgetLines(lines);
  return response;
}

export interface SpendSnapshots {
  /** Writes again unless a write is going or the last one was under the interval ago. */
  kick(): void;
  close(): Promise<void>;
}

/**
 * For `selfhost import --watch` with the embedded ledger: saves the spend snapshot now, every
 * `intervalMs` and after batches at most that often, so get_budget answers while it runs.
 */
export function startSpendSnapshots(
  ledger: Ledger,
  person: string,
  path: string,
  options: { intervalMs: number; warn: (line: string) => void },
): SpendSnapshots {
  let writing: Promise<void> | undefined;
  let wroteAt = Number.NEGATIVE_INFINITY;
  let failed: string | undefined;
  let closed = false;
  const run = (throttled: boolean) => {
    if (closed || writing || (throttled && Date.now() - wroteAt < options.intervalMs)) return;
    wroteAt = Date.now();
    writing = writeSpendSnapshot(ledger, person, path, new Date())
      .then(
        () => {
          failed = undefined;
        },
        (error: unknown) => {
          const text = error instanceof Error ? error.message : String(error);
          if (text !== failed) options.warn(`Saving spend for selfhost mcp failed: ${text}`);
          failed = text;
        },
      )
      .finally(() => {
        writing = undefined;
      });
  };
  const timer = setInterval(() => run(false), options.intervalMs);
  timer.unref?.();
  run(false);
  return {
    kick: () => run(true),
    async close() {
      closed = true;
      clearInterval(timer);
      await writing;
    },
  };
}

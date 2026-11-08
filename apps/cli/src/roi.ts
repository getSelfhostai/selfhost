import { databaseOf, type Ledger, openLedger } from "@selfhost/ledger";
import { ROI_RULES, type RoiBaseline, type RoiResponse, roiBaselinePeriod } from "@selfhost/schema";
import { roiReport, utcDay } from "@selfhost/spend";
import type { Command } from "commander";
import { percent, plural, roiSummary, table, usd } from "./format.js";
import { parseSince } from "./import.js";
import { loadConfig } from "./review.js";
import { type Fetch, serverUrl, TeamClient } from "./team/client.js";
import { readMembership } from "./team/config.js";

export interface RoiCommandOptions {
  since?: string;
  baseline?: boolean;
  json?: boolean;
  config?: string;
  database?: string;
  dataDir?: string;
}

export interface RoiIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  write: (line: string) => void;
  now?: Date;
  configPath: string;
  fetch?: Fetch;
}

const perPr = (value: number | null) => (value === null ? "no value" : usd(value));

function baselineLine(baseline: RoiBaseline | null): string {
  if (!baseline) return "not yet: its period has not ended, or there is no data";
  const how = baseline.period === "first_week" ? "first week of data" : "[roi] period";
  return `${roiSummary(baseline)}, ${utcDay(baseline.from)} to ${utcDay(baseline.to)} (${how}, frozen ${utcDay(baseline.computed_at)})`;
}

/** The change from the baseline, as a signed percentage, when both have a value. */
export function roiChange(report: RoiResponse): string | undefined {
  const now = report.cost_per_merged_pr;
  const before = report.baseline?.cost_per_merged_pr ?? null;
  if (now === null || before === null || before === 0) return undefined;
  const change = (now - before) / before;
  return `${change > 0 ? "+" : ""}${percent(change)}`;
}

export function roiText(report: RoiResponse, baselineOnly = false): string[] {
  const lines: string[] = [];
  const write = (line: string) => lines.push(line);
  const who = report.team === null ? "this machine" : `team ${report.team}`;
  if (baselineOnly) {
    write(`Baseline cost per merged agent PR, ${who}: ${baselineLine(report.baseline)}`);
    return lines;
  }
  write(`Cost per merged agent PR, ${utcDay(report.from)} to ${utcDay(report.to)}, ${who}`);
  table(
    [
      ["  This range", roiSummary(report)],
      ["  Baseline", baselineLine(report.baseline)],
      ...(roiChange(report) ? [["  Change", roiChange(report) ?? ""]] : []),
    ],
    write,
  );
  if (report.by_agent.length > 0) {
    write("");
    table(
      [
        ["agent", "model", "PRs", "cost", "per PR"],
        ...report.by_agent.map((row) => [
          row.agent,
          row.model,
          String(row.merged_prs),
          usd(row.cost_usd),
          perPr(row.cost_per_merged_pr),
        ]),
      ],
      write,
      3,
    );
  }
  write("");
  write(
    `Joined sessions ${usd(report.attributed_usd)}, shared ${usd(report.shared_usd)} ` +
      `(no pull request ${usd(report.unattributed_usd)}, closed unmerged ${usd(report.closed_usd)}), ` +
      `unallocated ${usd(report.unallocated_usd)}. ` +
      `${plural(report.human_prs, "human PR")} merged, ${plural(report.closed_prs, "agent PR")} closed unmerged.`,
  );
  write("");
  write("How it is counted:");
  for (const rule of ROI_RULES) write(`  - ${rule}`);
  return lines;
}

/**
 * `selfhost roi`: what each merged pull request cost next to the frozen baseline. In team mode
 * the server answers for the team; in solo mode this machine's ledger and selfhost.toml do.
 */
export async function runRoi(
  options: RoiCommandOptions,
  io: RoiIo,
  ledger?: Ledger,
): Promise<RoiResponse> {
  const now = io.now ?? new Date();
  const from = parseSince(options.since ?? "7d", now) ?? now;
  if (from >= now) throw new Error("--since: expected a time in the past");
  const membership = ledger ? undefined : readMembership(io.configPath);
  let report: RoiResponse;
  if (membership) {
    const fetch = io.fetch ?? ((url, init) => globalThis.fetch(url, init));
    const client = new TeamClient(serverUrl(membership.server), membership.token, fetch);
    report = await client.roi(membership.team, {
      from: from.toISOString(),
      to: now.toISOString(),
    });
  } else {
    const { config } = loadConfig(io.cwd, options.config, io);
    const period = roiBaselinePeriod(config.roi);
    const target =
      ledger ??
      (await openLedger({
        url: options.database ?? io.env.DATABASE_URL,
        dataDir: options.dataDir,
      }));
    try {
      report = await roiReport(databaseOf(target), {
        team: null,
        from,
        to: now,
        now,
        ...(period ? { period } : {}),
      });
    } finally {
      if (!ledger) await target.close();
    }
  }
  if (options.json) io.write(JSON.stringify(options.baseline ? report.baseline : report, null, 2));
  else for (const line of roiText(report, options.baseline)) io.write(line);
  return report;
}

export function registerRoi(
  program: Command,
  io: () => RoiIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  program
    .command("roi")
    .description("cost per merged agent pull request, by agent and model, next to the baseline")
    .option("--since <when>", "merges since, like 7d, 30d or a date", "7d")
    .option("--baseline", "print only the baseline and how it was picked")
    .option("--json", "print the report as JSON (with --baseline, the baseline alone)")
    .option("-c, --config <path>", "path to selfhost.toml, for [roi] (solo mode)")
    .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
    .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
    .action(async (options: RoiCommandOptions) => {
      try {
        await runRoi(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}

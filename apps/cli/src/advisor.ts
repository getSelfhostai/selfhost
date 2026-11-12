import { isPostgresUrl, openLedger } from "@selfhost/ledger";
import { advisorLines, advisorReport, readAdvisorData } from "@selfhost/notify";
import { ADVISOR_DAYS, type AdvisorReport } from "@selfhost/schema";
import type { Command } from "commander";
import { type Fetch, serverUrl, TeamClient } from "./team/client.js";
import { readMembership } from "./team/config.js";

export interface AdvisorOptions {
  team?: string;
  database?: string;
  dataDir?: string;
  json?: boolean;
}

export interface AdvisorIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  write: (line: string) => void;
  configPath: string;
  fetch: Fetch;
  now?: Date;
}

const DAY_MS = 86_400_000;

/**
 * `selfhost advisor`: the weekly advisor report for the last 7 days, now. In a team, the team
 * server's answer for the teams this person reads (a member's is about their own work); on a
 * laptop that joined no team, the local ledger's.
 */
export async function runAdvisor(options: AdvisorOptions, io: AdvisorIo): Promise<AdvisorReport> {
  const now = io.now ?? new Date();
  const membership = readMembership(io.configPath);
  let report: AdvisorReport;
  if (membership && !options.database && !options.dataDir) {
    const client = new TeamClient(serverUrl(membership.server), membership.token, io.fetch);
    report = await client.advisor({
      ...(options.team ? { team: options.team } : {}),
      to: now.toISOString(),
    });
  } else {
    if (options.team) throw new Error("--team needs a team: join one with selfhost join");
    const url = options.database ?? io.env.DATABASE_URL;
    const ledger = await openLedger(
      url !== undefined && isPostgresUrl(url) ? { url } : { dataDir: options.dataDir },
    );
    try {
      const from = new Date(now.getTime() - ADVISOR_DAYS * DAY_MS);
      const data = await readAdvisorData(ledger, { from, to: now, teams: null });
      report = advisorReport(data, { teams: null, from, to: now });
    } finally {
      await ledger.close();
    }
  }
  if (options.json) io.write(JSON.stringify(report, null, 2));
  else for (const line of advisorLines(report)) io.write(line);
  return report;
}

export function registerAdvisor(
  program: Command,
  io: () => AdvisorIo,
  fail: (error: unknown, json?: boolean) => void,
): void {
  program
    .command("advisor")
    .description(
      "the weekly agent advisor, now: what shipped, what got blocked, where money went, reverts, who worked where, and up to 3 changes to make",
    )
    .option("--team <team>", "only this team (default: every team you can read)")
    .option("--database <url>", "read this Postgres ledger instead of the team server")
    .option("--data-dir <path>", "read this embedded ledger folder instead of the team server")
    .option("--json", "print the report as JSON")
    .action(async (options: AdvisorOptions) => {
      try {
        await runAdvisor(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}

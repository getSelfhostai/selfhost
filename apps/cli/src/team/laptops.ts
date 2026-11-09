import type { LaptopRow, TeamLaptopsResponse } from "@selfhost/schema";
import type { Command } from "commander";
import { plural, table } from "../format.js";
import { type AdminOptions, needTeam, type TeamIo, teamTarget } from "./commands.js";

/** `selfhost team laptops --json`. */
export interface TeamLaptopsReport extends TeamLaptopsResponse {
  schema: "selfhost.team_laptops/v1";
  server: string;
}

const shortTime = (iso: string) => iso.replace("T", " ").replace(/:\d{2}(\.\d+)?Z$/, " UTC");

const FILES: Record<LaptopRow["managed"]["state"], string> = {
  current: "installed",
  pending: "pending",
  off: "off",
  none: "none",
};

function files(row: LaptopRow): string {
  const { state, pending } = row.managed;
  return state === "pending" ? `${pending} pending` : FILES[state];
}

/** Parses --silent-days. */
function silentDays(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 999) {
    throw new Error(`--silent-days: expected a whole number of days from 1 to 999, got "${value}"`);
  }
  return days;
}

/**
 * The laptop coverage of a team: every laptop that reported a heartbeat, with the config version
 * it runs and whether its managed settings are installed, flagged when behind or silent.
 */
export async function teamLaptops(
  options: AdminOptions & { silentDays?: string },
  io: TeamIo,
): Promise<TeamLaptopsReport> {
  const days = silentDays(options.silentDays);
  const { server, client, team: target } = teamTarget(options, io, "team laptops");
  const team = needTeam(target, "team laptops");
  const response = await client.laptops(team, days);
  const report: TeamLaptopsReport = { schema: "selfhost.team_laptops/v1", server, ...response };
  if (options.json) {
    io.write(JSON.stringify(report, null, 2));
    return report;
  }
  const flagged = report.laptops.filter((row) => row.flags.length > 0).length;
  io.write(
    `Team ${team} on ${server}: ${plural(report.laptops.length, "laptop")}, ${flagged} flagged. ` +
      (report.policy_hash
        ? `Team policy ${report.policy_hash.slice(0, 12)}.`
        : "The team has no policy yet."),
  );
  if (report.laptops.length > 0) {
    table(
      [
        ["status", "person", "laptop", "platform", "policy", "files", "last heartbeat"],
        ...report.laptops.map((row) => [
          row.status === "not_installed" ? "not installed" : row.status,
          row.person,
          row.hostname ?? row.machine.slice(0, 8),
          row.platform,
          row.policy_hash ? row.policy_hash.slice(0, 12) : "none",
          files(row),
          shortTime(row.last_heartbeat),
        ]),
      ],
      io.write,
    );
  }
  if (report.people_without_heartbeat.length > 0) {
    io.write(
      `No heartbeat from: ${report.people_without_heartbeat.join(", ")}. Their laptops report one on selfhost join and on each sync.`,
    );
  }
  io.write(
    `behind: runs another policy than the team's. silent: nothing for ${report.silent_days} days. not installed: managed settings pending or turned off.`,
  );
  return report;
}

/** Adds `team laptops` to the `team` command group. */
export function registerTeamLaptops(
  program: Command,
  io: () => TeamIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  const team = program.commands.find((c) => c.name() === "team");
  if (!team) return;
  team
    .command("laptops")
    .description(
      "list the team's laptops with the config version each runs, flagging ones behind or silent",
    )
    .option(
      "--silent-days <days>",
      "days without a heartbeat before a laptop is silent (default: 7)",
    )
    .option("--server <url>", "the selfhost server (default: the one this machine joined)")
    .option("--team <id>", "team id (default: the one this machine joined)")
    .option(
      "--token <token>",
      "the server's admin token (default: SELFHOST_TOKEN, else this machine's team token)",
    )
    .option("--json", "print JSON")
    .action(async (options: AdminOptions & { silentDays?: string }) => {
      try {
        await teamLaptops(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}

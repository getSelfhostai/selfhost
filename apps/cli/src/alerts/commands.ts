import type { Command } from "commander";
import { type AlarmsCommandOptions, runAlarms } from "./alarms.js";
import {
  type ForecastCommandOptions,
  type PlanCommandOptions,
  runForecast,
  runPlan,
} from "./forecast.js";
import type { AlertIo } from "./settings.js";
import { runStatusline, type StatuslineOptions } from "./statusline.js";

type Fail = (error: unknown, json: boolean | undefined) => void;

const LEDGER_OPTIONS = [
  ["--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)"],
  ["--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)"],
] as const;

function withLedger(command: Command): Command {
  for (const [flags, description] of LEDGER_OPTIONS) command.option(flags, description);
  return command;
}

/**
 * `selfhost spend forecast`, `selfhost spend plan`, `selfhost spend alarms` and
 * `selfhost statusline`. Registered after `selfhost spend`, whose command they extend.
 */
export function registerAlerts(program: Command, deps: () => AlertIo, fail: Fail): void {
  const spend = program.commands.find((command) => command.name() === "spend");
  if (!spend) throw new Error("registerAlerts needs the spend command registered first");
  // Options after a subcommand name belong to the subcommand: `spend alarms --since 1h`.
  spend.enablePositionalOptions();

  withLedger(
    spend
      .command("forecast")
      .description("when each person's Claude and Codex plan limits run out this week")
      .option("--person <id>", "only this person (default: everyone with usage in the last 7 days)")
      .option("--plan <plan=tier>", "tiers for this run, like claude=max_5x,codex=plus")
      .option("--warn-hours <hours>", "warn when a limit runs out within this many hours")
      .option("-c, --config <path>", "path to selfhost.toml")
      .option("--json", "print the report as JSON"),
  ).action(async (options: ForecastCommandOptions) => {
    try {
      await runForecast(options, deps());
    } catch (error) {
      fail(error, options.json);
    }
  });

  spend
    .command("plan")
    .description("show or set your plan tiers, like selfhost spend plan claude=max_5x codex=plus")
    .argument("[tiers...]", "plan=tier pairs; none clears a plan")
    .option("-c, --config <path>", "path to selfhost.toml")
    .option("--json", "print JSON")
    .action((tiers: string[], options: PlanCommandOptions) => {
      try {
        runPlan(tiers, options, deps());
      } catch (error) {
        fail(error, options.json);
      }
    });

  withLedger(
    spend
      .command("alarms")
      .description("raise possible stolen key alarms for spend spikes; exits 2 when there is one")
      .option("--since <when>", "evaluate the 15-minute slots since, like 15m, 1h or a date", "1h")
      .option("-c, --config <path>", "path to selfhost.toml")
      .option("--json", "print the report as JSON"),
  ).action(async (options: AlarmsCommandOptions) => {
    try {
      await runAlarms(options, deps());
    } catch (error) {
      fail(error, options.json);
    }
  });

  withLedger(
    program
      .command("statusline")
      .description("one line for an agent status bar: spend spike, plan limit or spend today")
      .option("--person <id>", "whose plan limits (default: the person selfhost import uses)")
      .option("--plan <plan=tier>", "tiers, like claude=max_5x,codex=plus")
      .option("--cache <path>", "cache file (default: ~/.selfhost/statusline.json)")
      .option("--refresh", "recompute even when the cache is fresh")
      .option("-c, --config <path>", "path to selfhost.toml"),
  ).action(async (options: StatuslineOptions) => {
    try {
      await runStatusline(options, deps());
    } catch (error) {
      fail(error, false);
    }
  });
}

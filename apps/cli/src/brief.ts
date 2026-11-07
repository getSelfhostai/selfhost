import { gatherBrief, renderBrief } from "@selfhost/brief";
import { compare, ledgerEvents, parseChangeTarget } from "@selfhost/pr";
import type { LedgerEvent } from "@selfhost/schema";
import type { Command } from "commander";
import { existingLedger, loadConfig, type ReviewIo } from "./review.js";
import { repoDir } from "./scan/index.js";
import { readMembership } from "./team/config.js";

export interface BriefIo extends ReviewIo {
  /** ~/.selfhost/config.json: the team server, when this machine joined one. */
  configPath: string;
}

export interface ReviewBriefCommandOptions {
  base?: string;
  head?: string;
  repo?: string;
  config?: string;
  database?: string;
  dataDir?: string;
  json?: boolean;
}

export const REVIEW_TRACE_SCHEMA = "selfhost.review_trace/v1";

export interface ReviewTraceCommandOptions {
  database?: string;
  dataDir?: string;
  json?: boolean;
}

/** `selfhost review brief`: the brief for a pull request or local commits. Writes nothing. */
export async function reviewBriefCommand(
  pr: string | undefined,
  options: ReviewBriefCommandOptions,
  io: BriefIo,
): Promise<void> {
  const target = parseChangeTarget({ pr, base: options.base, head: options.head });
  const repo = repoDir(options.repo, io.cwd);
  if (!repo) throw new Error("Not in a git repository. Run it inside one, or pass --repo.");
  const { config } = loadConfig(repo, options.config, io);
  const server = readMembership(io.configPath)?.server;
  const ledger = await existingLedger(options, io);
  try {
    const brief = await gatherBrief({
      repoDir: repo,
      target,
      highRiskPaths: config.review.high_risk_paths,
      ...(ledger ? { ledger } : {}),
      ...(server ? { server } : {}),
    });
    io.write(options.json ? JSON.stringify(brief, null, 2) : renderBrief(brief).trimEnd());
  } finally {
    await ledger?.close();
  }
}

function outcome(event: LedgerEvent): string | undefined {
  const data = event.data ?? {};
  if (typeof data.exit_code === "number") return `exit ${data.exit_code}`;
  if (typeof data.success === "boolean") return data.success ? "succeeded" : "failed";
  return undefined;
}

/** One event on one line: time, kind, tool, verdict, what it touched, result or cost. */
export function traceLine(event: LedgerEvent): string {
  const parts: string[] = [event.ts, event.kind];
  if (event.tool) parts.push(event.tool.name);
  const decision = event.decision;
  if (decision) {
    const mode = decision.mode ? ` (${decision.mode})` : "";
    parts.push(`${decision.verdict}${mode}${decision.rule_id ? ` ${decision.rule_id}` : ""}`);
  }
  const what = event.target?.value ?? event.tool?.input_summary;
  if (what) parts.push(what);
  if (event.kind === "tool.result") {
    const result = outcome(event);
    if (result) parts.push(result);
  }
  if (event.kind === "prompt.submitted" && typeof event.data?.prompt === "string") {
    parts.push(event.data.prompt.split("\n")[0]?.slice(0, 120) ?? "");
  }
  if (event.cost)
    parts.push(`$${event.cost.usd.toFixed(4)}${event.model ? ` ${event.model}` : ""}`);
  if (event.links?.commit_sha) parts.push(event.links.commit_sha);
  return parts.join("  ");
}

/** `selfhost review trace <session>`: every event of one session, oldest first. */
export async function reviewTraceCommand(
  session: string,
  options: ReviewTraceCommandOptions,
  io: ReviewIo,
): Promise<void> {
  const ledger = await existingLedger(options, io);
  if (!ledger) {
    throw new Error(
      "No ledger on this machine. Run selfhost import, or pass --database or --data-dir.",
    );
  }
  try {
    const events: LedgerEvent[] = [];
    for await (const event of ledgerEvents(ledger, { session })) events.push(event);
    if (events.length === 0) throw new Error(`No events for session ${session} in this ledger`);
    events.sort((a, b) => compare(a.ts, b.ts) || compare(a.id, b.id));
    if (options.json) {
      io.write(JSON.stringify({ schema: REVIEW_TRACE_SCHEMA, session, events }, null, 2));
    } else {
      for (const event of events) io.write(traceLine(event));
    }
  } finally {
    await ledger.close();
  }
}

export function registerBrief(
  program: Command,
  io: () => BriefIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  const review =
    program.commands.find((command) => command.name() === "review") ??
    program.command("review").description("score and route agent pull requests");

  review
    .command("brief")
    .description(
      "print the review brief for an agent pull request: task, plan, files, commands, tests, blocks, cost, trace and the lines to look at",
    )
    .argument("[pr]", "pull request number, read through gh")
    .option("--base <ref>", "brief the local commits since this ref instead of a pull request")
    .option("--head <ref>", "last commit with --base (default: HEAD)")
    .option("--repo <dir>", "git repository (default: the one here)")
    .option("-c, --config <path>", "path to selfhost.toml")
    .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
    .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
    .option("--json", "print the brief as JSON instead of the Markdown comment")
    .action(async (pr: string | undefined, options: ReviewBriefCommandOptions) => {
      try {
        await reviewBriefCommand(pr, options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });

  review
    .command("trace")
    .description("print every event of one agent session from the ledger, oldest first")
    .argument("<session>", "session id, as the review brief lists it")
    .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
    .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
    .option("--json", "print JSON")
    .action(async (session: string, options: ReviewTraceCommandOptions) => {
      try {
        await reviewTraceCommand(session, options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CODEOWNERS_PATHS,
  type CodeOwners,
  explainRoutes,
  openReviewList,
  parseCodeOwners,
  type RouteExplanation,
  type RouteInput,
  routeInputOf,
} from "@selfhost/review";
import {
  REVIEW_ITEM_KINDS,
  type ResolvedSelfhostConfig,
  type ReviewItemKind,
} from "@selfhost/schema";
import type { Command } from "commander";
import { existingLedger } from "./review.js";
import { type ReviewListIo, reviewConfig } from "./review-list.js";
import { repoDir } from "./scan/index.js";

export interface ReviewRoutesCommandOptions {
  item?: string;
  kind?: string;
  repo?: string;
  path?: string[];
  risk?: string;
  rule?: string;
  tool?: string;
  team?: string;
  person?: string;
  config?: string;
  database?: string;
  dataDir?: string;
  json?: boolean;
}

/** `selfhost review routes --json`. */
export interface ReviewRoutesReport extends RouteExplanation {
  schema: "selfhost.review_routes/v1";
  /** What routing read about the item. */
  input: RouteInput;
  /** The item's id, with --item. */
  item?: string;
  /** Where CODEOWNERS was read from, when it was. */
  codeowners?: string;
}

function parseKind(value: string | undefined): ReviewItemKind {
  const kind = value ?? "pr";
  if (!(REVIEW_ITEM_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`--kind: expected one of ${REVIEW_ITEM_KINDS.join(", ")}, got "${kind}"`);
  }
  return kind as ReviewItemKind;
}

function parseRisk(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const risk = Number(value);
  if (!/^\d+$/.test(value.trim()) || risk > 100) {
    throw new Error(`--risk: expected a score from 0 to 100, got "${value}"`);
  }
  return risk;
}

/**
 * The repository's CODEOWNERS, where GitHub would read it, from the working tree; else why
 * there is none.
 */
function localCodeowners(
  cwd: string,
): { path: string; codeowners: CodeOwners } | { missing: string } {
  const root = repoDir(undefined, cwd);
  if (!root) return { missing: "not in a git repository here, so there is no CODEOWNERS file" };
  for (const path of CODEOWNERS_PATHS) {
    const file = join(root, path);
    if (existsSync(file)) return { path, codeowners: parseCodeOwners(readFileSync(file, "utf8")) };
  }
  return { missing: `No CODEOWNERS file in the repository (${CODEOWNERS_PATHS.join(", ")})` };
}

async function itemInput(
  id: string,
  config: ResolvedSelfhostConfig,
  options: ReviewRoutesCommandOptions,
  io: ReviewListIo,
): Promise<RouteInput> {
  const ledger = await existingLedger(options, io);
  if (!ledger) throw new Error("No ledger on this laptop yet, so there is no review item to read.");
  try {
    const found = await routeInputOf(openReviewList(ledger, { config }), id);
    if (!found) throw new Error(`No review item ${id}. selfhost review list shows their ids.`);
    return found.input;
  } finally {
    await ledger.close();
  }
}

const people = (owners: string[]) => (owners.length > 0 ? owners.join(", ") : "nobody");

function print(report: ReviewRoutesReport, config: ResolvedSelfhostConfig, io: ReviewListIo) {
  const { input } = report;
  const about = [
    input.kind ?? "item",
    input.repo ? `in ${input.repo}` : undefined,
    input.risk !== undefined ? `risk ${input.risk}` : undefined,
    input.ruleId ? `rule ${input.ruleId}` : undefined,
    input.tool ? `tool ${input.tool}` : undefined,
    `${input.paths.length} file${input.paths.length === 1 ? "" : "s"}`,
  ].filter(Boolean);
  io.write(`${report.item ? `Item ${report.item}: ` : ""}${about.join(", ")}`);
  if (config.review.routes.length === 0) {
    io.write("selfhost.toml has no [[review.routes]], so the default steps route it.");
  } else {
    io.write("");
    io.write("[[review.routes]], checked in order:");
    report.routes.forEach((route, index) => {
      const head = `  ${index + 1}. ${route.id}`;
      if (!route.matched) {
        io.write(`${head}: no match, ${route.why}`);
      } else if (route.empty) {
        io.write(`${head}: matches (${route.why}) but names nobody here: ${route.empty}`);
      } else {
        const github = [
          ...route.github.users.map((user) => `@${user}`),
          ...route.github.teams.map((team) => `team ${team}`),
        ];
        const extra = github.length > 0 ? `; on GitHub ${github.join(", ")}` : "";
        const wait = route.escalate_after_minutes
          ? `; escalates after ${route.escalate_after_minutes} min`
          : "";
        io.write(`${head}: matches (${route.why}) -> ${people(route.owners)}${extra}${wait}`);
      }
    });
  }
  io.write("");
  const { route, ...routing } = report.routing;
  io.write(
    `Goes to ${people(routing.owners)}, from ${route.from}${route.why ? ` (${route.why})` : ""}.`,
  );
  if (route.github) {
    const named = [...route.github.users.map((u) => `@${u}`), ...route.github.teams];
    io.write(`GitHub reviewers for a pull request: ${named.join(", ")}.`);
  }
  if (routing.owners.length === 0) {
    const later = report.routes.find((r) => r.matched && r.empty?.includes("needs a team server"));
    if (later) {
      io.write(
        `On the team server, which knows each person's role, [[review.routes]] ${JSON.stringify(later.id)} takes it.`,
      );
    }
  }
  if (report.escalation.length > 0) {
    io.write(`Nobody answers: it escalates to ${report.escalation.join(", then ")}.`);
  }
  if (report.codeowners) io.write(`CODEOWNERS read from ${report.codeowners}.`);
}

/**
 * `selfhost review routes`: which route an item or a pull request would take under the
 * selfhost.toml the other commands find, every route checked in order with what it matched or
 * why not, and where it escalates. `--item` reads an item from the local review list; otherwise
 * the flags describe one (a pull request by default). Writes nothing.
 */
export async function runReviewRoutes(
  options: ReviewRoutesCommandOptions,
  io: ReviewListIo,
): Promise<ReviewRoutesReport> {
  const config = reviewConfig(options, io);
  const risk = parseRisk(options.risk);
  const input: RouteInput = options.item
    ? await itemInput(options.item, config, options, io)
    : {
        kind: parseKind(options.kind),
        paths: options.path ?? [],
        ...(options.repo ? { repo: options.repo } : {}),
        ...(risk !== undefined ? { risk } : {}),
        ...(options.rule ? { ruleId: options.rule } : {}),
        ...(options.tool ? { tool: options.tool } : {}),
        ...(options.team ? { team: options.team } : {}),
        ...(options.person ? { person: options.person } : {}),
      };
  const local = localCodeowners(io.cwd);
  const explained = explainRoutes(
    config,
    input,
    "missing" in local ? { codeownersNote: local.missing } : { codeowners: local.codeowners },
  );
  const report: ReviewRoutesReport = {
    schema: "selfhost.review_routes/v1",
    ...(options.item ? { item: options.item } : {}),
    input,
    ...explained,
    ...("missing" in local ? {} : { codeowners: local.path }),
  };
  if (options.json) io.write(JSON.stringify(report, null, 2));
  else print(report, config, io);
  return report;
}

const collect = (value: string, previous: string[] = []) => [...previous, value];

/** Adds `review routes`, creating the `review` group if it is not there. */
export function registerReviewRoutes(
  program: Command,
  io: () => ReviewListIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  const review =
    program.commands.find((command) => command.name() === "review") ??
    program.command("review").description("score and route agent pull requests");

  review
    .command("routes")
    .description(
      "explain which [[review.routes]] entry an item or pull request takes, and where it escalates",
    )
    .option("--item <id>", "a review item on this laptop, from selfhost review list")
    .option("--kind <kind>", "item kind when there is no --item (default: pr)")
    .option("--repo <owner/name>", "repository")
    .option("--path <file>", "a changed file; repeat for more", collect)
    .option("--risk <score>", "risk score from 0 to 100")
    .option("--rule <id>", "the rule that raised the item")
    .option("--tool <name>", "the tool an approval waits on")
    .option("--team <name>", "the item's team in [teams]")
    .option("--person <id>", "the person whose session raised it")
    .option("-c, --config <path>", "path to selfhost.toml")
    .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
    .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
    .option("--json", "print JSON")
    .action(async (options: ReviewRoutesCommandOptions) => {
      try {
        await runReviewRoutes(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}

import { existsSync, readFileSync } from "node:fs";
import { type Ledger, openLedger } from "@selfhost/ledger";
import {
  openReviewList,
  type RefreshResult,
  type ReviewList,
  refreshReviewList,
} from "@selfhost/review";
import {
  formatConfigError,
  parseConfig,
  REVIEW_ITEM_STATES,
  type ResolvedSelfhostConfig,
  type ReviewItem,
  type ReviewItemState,
  type ReviewItemsPage,
} from "@selfhost/schema";
import type { Command } from "commander";
import { findConfig } from "./find-config.js";
import { plural, table } from "./format.js";

export interface ReviewListIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  write: (line: string) => void;
  now?: Date;
  /** ~/.selfhost/config.json: the pulled team policy when the repository has no selfhost.toml. */
  configPath?: string;
}

export interface ReviewListCommandOptions {
  state?: string;
  owner?: string;
  limit?: string;
  cursor?: string;
  config?: string;
  database?: string;
  dataDir?: string;
  json?: boolean;
}

/** `selfhost review list --json`: one page of the list, ranked, after a refresh. */
export interface ReviewListReport extends ReviewItemsPage {
  schema: "selfhost.review_list/v1";
  /** What the refresh before the read changed. */
  refreshed: RefreshResult;
}

const TITLE_WIDTH = 60;

/** selfhost.toml as the other commands find it, or the defaults when there is none. */
function loadConfig(options: ReviewListCommandOptions, io: ReviewListIo): ResolvedSelfhostConfig {
  const location = findConfig(io.cwd, options.config, io.env, io.configPath);
  if (location && !existsSync(location.path)) throw new Error(`${location.path} does not exist`);
  const parsed = parseConfig(location ? readFileSync(location.path, "utf8") : "version = 1\n");
  if (parsed.ok) return parsed.config;
  const lines = parsed.errors.map((error) => `  ${formatConfigError(error, location?.path)}`);
  throw new Error([`${location?.path} is invalid. Run selfhost doctor.`, ...lines].join("\n"));
}

function parseState(value: string | undefined): ReviewItemState | undefined {
  if (value === undefined) return undefined;
  if (!(REVIEW_ITEM_STATES as readonly string[]).includes(value)) {
    throw new Error(`--state: expected one of ${REVIEW_ITEM_STATES.join(", ")}, got "${value}"`);
  }
  return value as ReviewItemState;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value.trim())) throw new Error(`--limit: expected a number, got "${value}"`);
  return Number(value);
}

const clip = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, width - 3)}...` : text;

function row(item: ReviewItem, rank: number): string[] {
  return [
    String(rank),
    item.kind,
    String(item.risk.score),
    item.blocking ? "blocks" : "",
    clip(item.title, TITLE_WIDTH),
    item.owners.join(", ") || "-",
    item.id,
  ];
}

function print(page: ReviewItemsPage, state: ReviewItemState, io: ReviewListIo): void {
  if (page.items.length === 0) {
    io.write(`No ${state} review items.`);
    return;
  }
  io.write(`${plural(page.items.length, `${state} item`)}, blocking first, then by risk.`);
  io.write("");
  table(
    [
      ["#", "KIND", "RISK", "AGENT", "TITLE", "OWNERS", "ID"],
      ...page.items.map((item, index) => row(item, index + 1)),
    ],
    io.write,
  );
  if (page.next_cursor) {
    io.write("");
    io.write(`next_cursor: ${page.next_cursor}`);
  }
}

/**
 * `selfhost review list`: brings the local review list up to date with the local ledger, then
 * prints one page of it in rank order. Pass a ledger to reuse an open one.
 */
export async function runReviewList(
  options: ReviewListCommandOptions,
  io: ReviewListIo,
  ledger?: Ledger,
): Promise<ReviewListReport> {
  const state = parseState(options.state) ?? "open";
  const limit = parseLimit(options.limit);
  const config = loadConfig(options, io);
  const target =
    ledger ??
    (await openLedger({ url: options.database ?? io.env.DATABASE_URL, dataDir: options.dataDir }));
  try {
    const now = () => io.now ?? new Date();
    const list = openReviewList(target, { config, now });
    const refreshed = await refreshReviewList(target, list);
    const page = await list.list({
      state,
      ...(options.owner !== undefined ? { owner: options.owner } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    });
    const report: ReviewListReport = { schema: "selfhost.review_list/v1", ...page, refreshed };
    if (options.json) io.write(JSON.stringify(report, null, 2));
    else print(page, state, io);
    return report;
  } finally {
    if (!ledger) await target.close();
  }
}

/**
 * The local review list for solo mode, brought up to date with the ledger before each use, with
 * routing and timeouts from the selfhost.toml the other commands find.
 */
export function localReviewList(io: ReviewListIo) {
  return async (ledger: Ledger): Promise<ReviewList> => {
    const config = loadConfig({}, io);
    const list = openReviewList(ledger, { config, now: () => io.now ?? new Date() });
    await refreshReviewList(ledger, list);
    return list;
  };
}

/** Adds `review list`, creating the `review` group if it is not there. */
export function registerReviewList(
  program: Command,
  io: () => ReviewListIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  const review =
    program.commands.find((command) => command.name() === "review") ??
    program.command("review").description("score and route agent pull requests");

  review
    .command("list")
    .description(
      "the review list on this laptop: what needs a person, blocking first, then by risk",
    )
    .option("--state <state>", "open (default), answered, dismissed or expired")
    .option("--owner <person>", "only items this person owns")
    .option("--limit <n>", "items per page (default 100)")
    .option("--cursor <cursor>", "next_cursor from the previous page")
    .option("-c, --config <path>", "path to selfhost.toml, for routing and timeouts")
    .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
    .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
    .option("--json", "print JSON")
    .action(async (options: ReviewListCommandOptions) => {
      try {
        await runReviewList(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}

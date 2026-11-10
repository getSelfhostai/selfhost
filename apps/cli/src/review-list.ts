import { existsSync } from "node:fs";
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
import { findConfig, policyText } from "./find-config.js";
import { plural, table } from "./format.js";
import { oneCopyPerFact } from "./hooks/dedupe.js";
import { drainSpool } from "./hooks/drain.js";
import { spoolDir } from "./hooks/receive.js";
import { defaultPerson } from "./import.js";
import { httpReviewList } from "./inbox/http.js";
import type { Fetch } from "./team/client.js";
import { readMembership } from "./team/config.js";

export interface ReviewListIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  write: (line: string) => void;
  now?: Date;
  /** ~/.selfhost/config.json: the pulled team policy when the repository has no selfhost.toml. */
  configPath?: string;
  /** For the team server's list in team mode. Default: the global fetch. */
  fetch?: Fetch;
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
  /** What the refresh before the read changed. The team server refreshes its own list. */
  refreshed: RefreshResult;
  /** Where the list was read: the team server in team mode, else the local ledger. */
  source?: "server" | "local";
}

const TITLE_WIDTH = 60;

/** selfhost.toml as the other commands find it, or the defaults when there is none. */
export function reviewConfig(
  options: Pick<ReviewListCommandOptions, "config">,
  io: ReviewListIo,
): ResolvedSelfhostConfig {
  const location = findConfig(io.cwd, options.config, io.env, io.configPath);
  if (location && !existsSync(location.path)) throw new Error(`${location.path} does not exist`);
  const parsed = parseConfig(location ? policyText(location).text : "version = 1\n");
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

const AGENT_NAMES: Partial<Record<string, string>> = {
  claude_code: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  goose: "Goose",
  copilot: "Copilot",
};

function row(item: ReviewItem, rank: number): string[] {
  const vendor = item.agent?.vendor;
  return [
    String(rank),
    item.kind,
    String(item.risk.score),
    vendor ? (AGENT_NAMES[vendor] ?? vendor) : "-",
    item.blocking ? "yes" : "",
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
      ["#", "KIND", "RISK", "AGENT", "WAITING", "TITLE", "OWNERS", "ID"],
      ...page.items.map((item, index) => row(item, index + 1)),
    ],
    io.write,
  );
  if (page.next_cursor) {
    io.write("");
    io.write(`next_cursor: ${page.next_cursor}`);
  }
}

function query(
  options: ReviewListCommandOptions,
  state: ReviewItemState,
  limit: number | undefined,
) {
  return {
    state,
    ...(options.owner !== undefined ? { owner: options.owner } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
  };
}

function report(
  page: ReviewItemsPage,
  refreshed: RefreshResult,
  source: "server" | "local",
  state: ReviewItemState,
  options: ReviewListCommandOptions,
  io: ReviewListIo,
): ReviewListReport {
  const out: ReviewListReport = { schema: "selfhost.review_list/v1", ...page, refreshed, source };
  if (options.json) io.write(JSON.stringify(out, null, 2));
  else print(page, state, io);
  return out;
}

/**
 * `selfhost review list`: in team mode, one page of the team server's list, the one
 * `selfhost inbox` reads; otherwise brings the local review list up to date with the local
 * ledger, then prints one page of it in rank order. --database or --data-dir read a ledger even
 * in team mode. Pass a ledger to reuse an open one.
 */
export async function runReviewList(
  options: ReviewListCommandOptions,
  io: ReviewListIo,
  ledger?: Ledger,
): Promise<ReviewListReport> {
  const state = parseState(options.state) ?? "open";
  const limit = parseLimit(options.limit);
  const membership = io.configPath ? readMembership(io.configPath) : undefined;
  const local =
    ledger !== undefined || options.database !== undefined || options.dataDir !== undefined;
  if (membership && !local) {
    const fetcher: Fetch = io.fetch ?? ((url, init) => fetch(url, init));
    const list = httpReviewList(membership.server, membership.token, fetcher);
    const page = await list.list(query(options, state, limit));
    return report(page, { created: 0, updated: 0 }, "server", state, options, io);
  }
  const config = reviewConfig(options, io);
  const target =
    ledger ??
    (await openLedger({ url: options.database ?? io.env.DATABASE_URL, dataDir: options.dataDir }));
  try {
    const now = () => io.now ?? new Date();
    // Blocked calls not imported yet go in first, so their exception items are on the list.
    await drainSpool(oneCopyPerFact(target), spoolDir(io.env), {
      person: membership?.person ?? defaultPerson(io.env),
      now: now(),
      exceptionsOnly: true,
    });
    const list = openReviewList(target, { config, now });
    const refreshed = await refreshReviewList(target, list);
    const page = await list.list(query(options, state, limit));
    return report(page, refreshed, "local", state, options, io);
  } finally {
    if (!ledger) await target.close();
  }
}

/** A list used again within this long is not refreshed again: a paged read is one use. */
const REFRESH_EVERY_MS = 1000;

/**
 * The local review list for solo mode, brought up to date with the ledger before each use (at
 * most once a second), with routing and timeouts from the selfhost.toml the other commands find.
 * So `import --watch`, which keeps one list open, sees new items and answers recorded elsewhere.
 */
export function localReviewList(io: ReviewListIo) {
  return async (ledger: Ledger): Promise<ReviewList> => {
    const config = reviewConfig({}, io);
    const list = openReviewList(ledger, { config, now: () => io.now ?? new Date() });
    let last = Number.NEGATIVE_INFINITY;
    const fresh = async () => {
      if (Date.now() - last < REFRESH_EVERY_MS) return;
      await refreshReviewList(ledger, list);
      last = Date.now();
    };
    const refreshed =
      <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        await fresh();
        return fn(...args);
      };
    await fresh();
    return {
      ...list,
      list: refreshed(list.list),
      get: refreshed(list.get),
      decide: refreshed(list.decide),
      snooze: refreshed(list.snooze),
    };
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
      "the review list: what needs a person, blocking first, then by risk (the team server's in team mode)",
    )
    .option("--state <state>", "open (default), answered, dismissed or expired")
    .option("--owner <person>", "only items this person owns")
    .option("--limit <n>", "items per page (default 100)")
    .option("--cursor <cursor>", "next_cursor from the previous page")
    .option("-c, --config <path>", "path to selfhost.toml, for routing and timeouts")
    .option(
      "--database <url>",
      "Postgres url (default: DATABASE_URL, else the embedded ledger); reads it even in team mode",
    )
    .option(
      "--data-dir <path>",
      "embedded ledger folder (default: ~/.selfhost/data); reads it even in team mode",
    )
    .option("--json", "print JSON")
    .action(async (options: ReviewListCommandOptions) => {
      try {
        await runReviewList(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}

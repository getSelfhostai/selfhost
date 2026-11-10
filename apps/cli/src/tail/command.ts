import { existsSync } from "node:fs";
import {
  connect,
  type Database,
  isPostgresUrl,
  resolveDataDir,
  type TailRow,
  tailEvents,
} from "@selfhost/ledger";
import {
  AGENT_VENDORS,
  type LedgerEvent,
  type ReviewItem,
  TAIL_WINDOW_HOURS,
} from "@selfhost/schema";
import type { Command } from "commander";
import { parseAlarmSince } from "../alerts/alarms.js";
import { DEFAULT_CONSOLE_PORT } from "../console.js";
import { drainSpool } from "../hooks/drain.js";
import { spoolDir } from "../hooks/receive.js";
import { defaultPerson } from "../import.js";
import { inboxPaths, readInboxCache } from "../inbox/store.js";
import { type Fetch, TeamApiError, TeamClient } from "../team/client.js";
import { type Membership, readMembership } from "../team/config.js";
import { FeedReader, feedDir, feedEvent, watcherAlive } from "./feed.js";
import {
  type Clock,
  clockIn,
  formatLine,
  lineOf,
  matches,
  REVIEW_OPENED,
  reviewLine,
  SessionCache,
  TAIL_KINDS,
  type TailFilter,
  type TailLine,
  zoneText,
} from "./line.js";

export interface TailCommandOptions {
  agent?: string;
  repo?: string;
  person?: string;
  kind?: string;
  session?: string;
  run?: string;
  since?: string;
  json?: boolean;
  database?: string;
  dataDir?: string;
  /** In a team, follow this machine's own feed instead of the team server. */
  local?: boolean;
}

export interface TailIo {
  env: NodeJS.ProcessEnv;
  write: (line: string) => void;
  /** Notes for a person (no watcher running, server unreachable); stderr, never in --json. */
  note: (line: string) => void;
  configPath: string;
  now?: () => Date;
  fetch?: Fetch;
  /** Waits between polls; tests pass their own. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Stops the tail. Default: Ctrl-C or SIGTERM. */
  signal?: AbortSignal;
  /** Seconds the team server holds each request. Default 20; tests pass 0. */
  serverWaitSeconds?: number;
  /** The time zone of the times printed. Default: TZ, else this machine's. */
  timeZone?: string;
}

/** How often the embedded feed and the spool are read. */
export const FEED_POLL_MS = 500;
/** How often a database is polled directly (DATABASE_URL). */
export const DB_POLL_MS = 1000;
/** How often the review list is read for new items. */
export const REVIEW_POLL_MS = 5000;
/** Seconds the team server holds each request. */
const SERVER_WAIT_SECONDS = 20;
const RETRY_MS = 5000;
/** Ids remembered to drop an event seen twice (a backfill, then the feed). */
const SEEN_MAX = 20_000;
/** Events per page while reading back --since. */
const BACKFILL_PAGE = 1000;

const AGENT_ALIASES: Record<string, string> = {
  claude: "claude_code",
  "claude-code": "claude_code",
};

/** --kind as a list: event kinds, their first part, or review. */
export function parseKinds(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const kinds = value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== "");
  const unknown = kinds.filter((kind) => !TAIL_KINDS.includes(kind));
  if (unknown.length > 0) {
    throw new Error(
      `--kind: unknown ${unknown.join(", ")}; expected event kinds like tool.called, their first part (session, tool, policy, cost, alert ...) or review`,
    );
  }
  return [...new Set(kinds)];
}

export function parseAgent(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const agent = AGENT_ALIASES[value.trim().toLowerCase()] ?? value.trim().toLowerCase();
  if (!(AGENT_VENDORS as readonly string[]).includes(agent)) {
    throw new Error(`--agent: expected one of ${AGENT_VENDORS.join(", ")}, got "${value}"`);
  }
  return agent;
}

function parseRepo(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.trim())) {
    throw new Error(`--repo: expected owner/name, got "${value}"`);
  }
  return value.trim();
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });

function untilSignal(): AbortSignal {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  return controller.signal;
}

/** Turns events into printed lines: dedupes, tracks cache rates, filters and prints. */
class Printer {
  private readonly cache = new SessionCache();
  private readonly seen = new Set<string>();
  /** The person of each session, from its events with a person actor. */
  private readonly sessions = new Map<string, string>();

  constructor(
    private readonly filter: TailFilter,
    private readonly console: string,
    private readonly write: (line: string) => void,
    private readonly json: boolean,
    private readonly since: Date | undefined,
    private readonly clock: Clock,
  ) {}

  event(event: LedgerEvent, repo?: string | null, person?: string | null): void {
    if (this.seen.has(event.id)) return;
    this.remember(event.id);
    const rate = this.cache.add(event);
    const session = event.session_id;
    if (session && event.actor.kind === "person" && this.sessions.size < SEEN_MAX) {
      this.sessions.set(session, event.actor.id);
    }
    if (this.since && Date.parse(event.ts) < this.since.getTime()) return;
    const sentBy = typeof event.data?.sent_by === "string" ? event.data.sent_by : undefined;
    const owner = person ?? sentBy ?? (session ? this.sessions.get(session) : undefined);
    this.print(
      lineOf(event, {
        console: this.console,
        repo: repo ?? null,
        cacheHitRate: rate,
        ...(owner ? { person: owner } : {}),
      }),
    );
  }

  /** Events read back from before the tail started, printed in the order they happened. */
  backfill(rows: { event: LedgerEvent; repo?: string | null; person?: string | null }[]): void {
    const sorted = [...rows].sort(
      (a, b) =>
        Date.parse(a.event.ts) - Date.parse(b.event.ts) || (a.event.id < b.event.id ? -1 : 1),
    );
    for (const row of sorted) this.event(row.event, row.repo, row.person);
  }

  review(item: ReviewItem): void {
    const id = `review:${item.id}`;
    if (this.seen.has(id)) return;
    this.remember(id);
    this.print(reviewLine(item, this.console));
  }

  /** An item that was already open: remembered, not printed. */
  knownReview(item: ReviewItem): void {
    this.remember(`review:${item.id}`);
  }

  private print(line: TailLine): void {
    if (!matches(line, this.filter)) return;
    this.write(this.json ? JSON.stringify(line) : formatLine(line, this.clock));
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > SEEN_MAX) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}

interface Context {
  filter: TailFilter;
  since?: Date;
  printer: Printer;
  io: TailIo;
  signal: AbortSignal;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

/** Event kinds the event sources are asked for: none when only review items are wanted. */
const eventKinds = (kinds: string[] | undefined) => kinds?.filter((kind) => kind !== "review");
const wantsEvents = (kinds: string[] | undefined) => !kinds || (eventKinds(kinds)?.length ?? 0) > 0;
const wantsReview = (kinds: string[] | undefined) =>
  !kinds || kinds.includes("review") || kinds.includes(REVIEW_OPENED);

/** Polls the review list and prints the items that were not open before. */
async function followReview(ctx: Context, read: () => Promise<ReviewItem[] | undefined>) {
  let first = true;
  while (!ctx.signal.aborted) {
    let items: ReviewItem[] | undefined;
    try {
      items = await read();
    } catch {
      items = undefined;
    }
    for (const item of items ?? []) {
      const old = ctx.since === undefined || Date.parse(item.created_at) < ctx.since.getTime();
      // Items open when the tail started are not new; with --since, the recent ones show.
      if (first && old) ctx.printer.knownReview(item);
      else ctx.printer.review(item);
    }
    if (items) first = false;
    await ctx.sleep(REVIEW_POLL_MS);
  }
}

/** Team mode: the team server's long poll, as this person's token sees it. */
async function followServer(ctx: Context, membership: Membership): Promise<void> {
  const client = new TeamClient(membership.server, membership.token, ctx.io.fetch ?? fetch);
  const kinds = eventKinds(ctx.filter.kinds);
  const base = {
    ...(kinds && kinds.length > 0 ? { kind: kinds.join(",") } : {}),
    ...(ctx.filter.person ? { person: ctx.filter.person } : {}),
    ...(ctx.filter.agent ? { agent: ctx.filter.agent as (typeof AGENT_VENDORS)[number] } : {}),
    ...(ctx.filter.repo ? { repo: ctx.filter.repo } : {}),
    ...(ctx.filter.session ? { session: ctx.filter.session } : {}),
    ...(ctx.filter.run ? { run: ctx.filter.run } : {}),
  };
  let after: string | undefined;
  let down = false;
  // With --since, the pages that read back what already happened are printed in time order.
  let backfilling = ctx.since !== undefined;
  const held: { event: LedgerEvent; person?: string | null }[] = [];
  const wait = ctx.io.serverWaitSeconds ?? SERVER_WAIT_SECONDS;
  const events = async () => {
    while (!ctx.signal.aborted) {
      try {
        const page = await client.tailEvents({
          ...base,
          ...(after ? { after } : ctx.since ? { since: ctx.since.toISOString() } : {}),
          ...(after && wait > 0 && !backfilling ? { wait } : {}),
          ...(backfilling ? { limit: BACKFILL_PAGE } : {}),
        });
        if (down) ctx.io.note(`Back in touch with ${membership.server}.`);
        down = false;
        after = page.cursor;
        const people = page.people ?? {};
        if (backfilling) {
          held.push(...page.events.map((event) => ({ event, person: people[event.id] ?? null })));
          if (page.events.length >= BACKFILL_PAGE) continue;
          backfilling = false;
          ctx.printer.backfill(held.splice(0));
          continue;
        }
        for (const event of page.events) ctx.printer.event(event, null, people[event.id] ?? null);
        // The server held the request; without a wait, pause like a poll.
        if (wait === 0 && page.events.length === 0) await ctx.sleep(DB_POLL_MS);
      } catch (error) {
        if (error instanceof TeamApiError && error.status !== 0 && error.status < 500) throw error;
        if (!down) {
          ctx.io.note(`${(error as Error).message}. Trying again every ${RETRY_MS / 1000} s.`);
        }
        down = true;
        await ctx.sleep(RETRY_MS);
      }
    }
  };
  const review = async () => {
    const read = async () => {
      const items: ReviewItem[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.reviewItems({ state: "open", limit: 200, cursor });
        items.push(...page.items);
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
      return items;
    };
    await followReview(ctx, read);
  };
  await Promise.all([
    wantsEvents(ctx.filter.kinds) ? events() : undefined,
    wantsReview(ctx.filter.kinds) ? review() : undefined,
  ]);
}

/** DATABASE_URL: Postgres takes any number of readers, so the tail polls it directly. */
async function followDatabase(ctx: Context, url: string): Promise<void> {
  const db = await connect({ url });
  try {
    const kinds = eventKinds(ctx.filter.kinds);
    let after: string | undefined;
    let backfilling = ctx.since !== undefined;
    const held: TailRow[] = [];
    while (!ctx.signal.aborted) {
      const from = ctx.since ?? new Date(ctx.now().getTime() - TAIL_WINDOW_HOURS * 3_600_000);
      const page = await tailEvents(db, {
        from: from.toISOString(),
        ...(after ? { after } : { backfill: ctx.since !== undefined }),
        ...(kinds && kinds.length > 0 ? { kinds } : {}),
        ...(ctx.filter.person ? { person: ctx.filter.person } : {}),
        ...(ctx.filter.agent ? { agent: ctx.filter.agent } : {}),
        ...(ctx.filter.repo ? { repo: ctx.filter.repo } : {}),
        ...(ctx.filter.session ? { session: ctx.filter.session } : {}),
        ...(ctx.filter.run ? { run: ctx.filter.run } : {}),
        limit: BACKFILL_PAGE,
        settleMs: 1000,
      });
      after = page.cursor;
      if (backfilling) {
        held.push(...page.rows);
        if (page.rows.length >= BACKFILL_PAGE) continue;
        backfilling = false;
        ctx.printer.backfill(held.splice(0));
        await ctx.sleep(DB_POLL_MS);
        continue;
      }
      for (const row of page.rows) ctx.printer.event(row.event, row.repo, row.person);
      if (page.rows.length < BACKFILL_PAGE) await ctx.sleep(DB_POLL_MS);
    }
  } finally {
    await db.close();
  }
}

/**
 * Reads what the embedded ledger already has since --since: open, read, close at once, without
 * migrating it, so nothing is written.
 */
async function backfillEmbedded(
  ctx: Context,
  dataDir: string | undefined,
): Promise<{ event: LedgerEvent; person?: string | null }[]> {
  if (!ctx.since) return [];
  const dir = resolveDataDir(dataDir, ctx.io.env);
  if (!existsSync(dir)) return [];
  const rows: TailRow[] = [];
  let db: Database | undefined;
  try {
    db = await connect({ dataDir: dir });
    let after: string | undefined;
    for (;;) {
      const page = await tailEvents(db, {
        from: ctx.since.toISOString(),
        ...(after ? { after } : { backfill: true }),
        limit: BACKFILL_PAGE,
      });
      rows.push(...page.rows);
      if (page.rows.length < BACKFILL_PAGE) break;
      after = page.cursor;
    }
  } catch (error) {
    ctx.io.note(`The ledger in ${dir} could not be read: ${(error as Error).message}`);
  } finally {
    await db?.close();
  }
  return rows.map((row) => ({
    event: feedEvent(row.event, row.repo ?? undefined),
    person: row.person,
  }));
}

/**
 * Solo mode on the embedded ledger. With `selfhost import --watch` running, the tail follows the
 * live feed it writes and never opens the ledger, which the watcher holds. Without one, it
 * reads the hook spool itself (sessions, tool calls, rule decisions, approvals; model costs
 * come from the session logs, which only the watcher imports) and switches to the feed as soon
 * as a watcher starts. The ledger is opened only for --since, and only when no watcher runs.
 */
async function followEmbedded(ctx: Context, options: TailCommandOptions): Promise<void> {
  const dir = feedDir(ctx.io.env, ctx.io.configPath);
  const reader = new FeedReader(dir);
  const live = watcherAlive(dir);
  // What --since reads back from the ledger and the spool, printed together in time order.
  const earlier: { event: LedgerEvent; person?: string | null }[] = [];
  if (live) {
    if (!ctx.since) reader.skipToEnd();
  } else {
    earlier.push(...(await backfillEmbedded(ctx, options.dataDir)));
    reader.skipToEnd();
  }
  const spool = spoolDir(ctx.io.env);
  const offsets = new Map<string, number>();
  // The person selfhost import gives these events, so the lines match what the ledger gets.
  const person = readMembership(ctx.io.configPath)?.person ?? defaultPerson(ctx.io.env);
  const capture = (print: boolean | "hold") => ({
    async append(events: LedgerEvent[]) {
      if (print === "hold")
        earlier.push(...events.map((event) => ({ event: feedEvent(event, undefined) })));
      else if (print) for (const event of events) ctx.printer.event(feedEvent(event, undefined));
      return { accepted: events.map((event) => event.id), duplicates: [] };
    },
  });
  const readSpool = (print: boolean | "hold") =>
    drainSpool(capture(print), spool, {
      person,
      logPrompts: false,
      keep: true,
      offsets,
      now: ctx.now(),
    });
  let watching = live;
  if (!live) {
    // Skip what the spool already held, unless --since asked for it.
    await readSpool(ctx.since !== undefined ? "hold" : false);
    ctx.io.note(
      "No selfhost import --watch is running: showing hook events from the spool. Start it to see model costs too.",
    );
  }
  ctx.printer.backfill(earlier.splice(0));
  const events = async () => {
    while (!ctx.signal.aborted) {
      const alive = watcherAlive(dir);
      if (alive && !watching) {
        ctx.io.note("selfhost import --watch started: following its live feed.");
        reader.skipToEnd();
      } else if (!alive && watching) {
        ctx.io.note("selfhost import --watch stopped: showing hook events from the spool.");
        await readSpool(false);
      }
      watching = alive;
      if (alive) for (const event of reader.read()) ctx.printer.event(event);
      else await readSpool(true);
      await ctx.sleep(FEED_POLL_MS);
    }
  };
  const review = () =>
    followReview(ctx, async () => {
      // The copy import --watch keeps of the open review list; no ledger needed.
      const path = inboxPaths(ctx.io.configPath).cache;
      return readInboxCache(path, { server: null, team: null })?.items;
    });
  await Promise.all([
    wantsEvents(ctx.filter.kinds) ? events() : undefined,
    wantsReview(ctx.filter.kinds) ? review() : undefined,
  ]);
}

/**
 * `selfhost tail`: agent activity as it lands, one line per event (or one JSON object with
 * --json): who, which agent, the tool, the cost with the session's cache hit rate, the rule
 * decision with its rule id, alerts and new review items, each with a link to its run. In a
 * team it follows the team server, which shows only the teams the person is in.
 */
export async function runTail(options: TailCommandOptions, io: TailIo): Promise<void> {
  const now = io.now ?? (() => new Date());
  const kinds = parseKinds(options.kind);
  const filter: TailFilter = {
    ...(kinds ? { kinds } : {}),
    ...(options.person ? { person: options.person.trim() } : {}),
    ...(options.agent ? { agent: parseAgent(options.agent) } : {}),
    ...(options.repo ? { repo: parseRepo(options.repo) } : {}),
    ...(options.session ? { session: options.session.trim() } : {}),
    ...(options.run ? { run: options.run.trim() } : {}),
  };
  const since = options.since ? parseAlarmSince(options.since, now()) : undefined;
  const signal = io.signal ?? untilSignal();
  const sleep = (ms: number) => (io.sleep ?? defaultSleep)(ms, signal);
  const membership = options.local ? undefined : readMembership(io.configPath);
  const url = options.database ?? io.env.DATABASE_URL;
  const console = membership?.server ?? `http://127.0.0.1:${DEFAULT_CONSOLE_PORT}`;
  const clock = clockIn(io.timeZone ?? (io.env.TZ?.trim() || undefined));
  const printer = new Printer(filter, console, io.write, options.json === true, since, clock);
  const ctx: Context = { filter, ...(since ? { since } : {}), printer, io, signal, sleep, now };
  if (!options.json) {
    const where = membership
      ? `team ${membership.team} on ${membership.server}`
      : url && isPostgresUrl(url)
        ? "Postgres (DATABASE_URL)"
        : "this laptop";
    io.note(`Tailing ${where}, times in ${zoneText(clock)}. Press Ctrl-C to stop.`);
  }
  if (membership) return followServer(ctx, membership);
  if (url?.trim() && isPostgresUrl(url)) return followDatabase(ctx, url);
  return followEmbedded(ctx, options);
}

export function registerTail(
  program: Command,
  io: () => TailIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  program
    .command("tail")
    .description(
      "stream agent activity as it lands: sessions, tool calls, rule blocks and asks, costs with cache hit rates, alerts and new review items",
    )
    .option("--agent <agent>", "only this agent: claude_code, codex, cursor ...")
    .option("--repo <owner/name>", "only this repository")
    .option("--person <id>", "only this person (actor id)")
    .option(
      "--kind <kinds>",
      "event kinds or groups: session, tool, policy, cost, alert, review ...",
    )
    .option("--session <id>", "only this session")
    .option("--run <id>", "only this background run: its states, output, health and gate")
    .option("--since <when>", "start with what happened since, like 15m, 2h or a date")
    .option("--json", "one JSON object per line")
    .option("--local", "in a team, follow this machine instead of the team server")
    .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
    .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
    .action(async (options: TailCommandOptions) => {
      try {
        await runTail(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isPostgresUrl, type Ledger, openLedger } from "@selfhost/ledger";
import type { Handoff, LedgerEvent, ReviewItem } from "@selfhost/schema";
import type { Command } from "commander";
import { isAlive, readCache } from "../alerts/cache.js";
import { localPerson } from "../alerts/person.js";
import { statuslineCachePath } from "../alerts/settings.js";
import { clock, duration } from "../alerts/text.js";
import { plural } from "../format.js";
import { oneCopyPerFact } from "../hooks/dedupe.js";
import { drainSpool } from "../hooks/drain.js";
import type { AnyGrant, GrantsReport } from "../hooks/exceptions.js";
import { spoolDir } from "../hooks/receive.js";
import { requireHuman } from "../human.js";
import { type Fetch, TeamApiError, TeamClient } from "../team/client.js";
import { readMembership } from "../team/config.js";
import { type GrantSource, grantLine, refreshGrants, serverGrants } from "./grants.js";
import { closedItem, httpReviewList } from "./http.js";
import type { ReviewList } from "./review-list.js";
import {
  appendQueue,
  type InboxAction,
  type InboxPaths,
  type InboxScope,
  inboxPaths,
  pendingItems,
  type QueuedAction,
  queuedFor,
  readInboxCache,
  readQueue,
  replaceItem,
  updateInboxCache,
} from "./store.js";
import {
  isOffline,
  listAll,
  type OpenLocalReviewList,
  type ReplayReport,
  refreshCache,
  replayQueue,
} from "./sync.js";
import {
  closedText,
  fullId,
  itemLines,
  needsAnotherApprover,
  queuedText,
  replayLines,
  resolveId,
  SOLE_APPROVER_REFUSAL,
  shortIds,
  writeItems,
} from "./text.js";

/** What the inbox commands read and write; tests pass fixtures instead of the real machine. */
export interface InboxIo {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  write: (line: string) => void;
  setExitCode: (code: number) => void;
  now?: Date;
  /** ~/.selfhost/config.json: the team membership, with the saved copy and queue next to it. */
  configPath: string;
  /** HTTP for the team server, used only in team mode. */
  fetch: Fetch;
  /** Solo mode's review list over the local ledger. */
  localReviewList?: OpenLocalReviewList;
  /** Whether stdout is a terminal. Default: process.stdout.isTTY. */
  isTTY?: boolean;
  /** Opens a link in the browser. Default: the OS opener. */
  openUrl?: (url: string) => void;
  /** Whether stdin is a terminal; approve and deny refuse without one. */
  stdinIsTTY?: boolean;
}

interface CommonOptions {
  database?: string;
  dataDir?: string;
  json?: boolean;
}

export interface InboxListOptions extends CommonOptions {
  all?: boolean;
}

export interface InboxDecideOptions extends CommonOptions {
  reason?: string;
}

export interface InboxSnoozeOptions extends CommonOptions {
  for?: string;
  until?: string;
}

export interface InboxOpenOptions extends CommonOptions {
  /** false with --no-open. */
  open?: boolean;
}

/** `selfhost inbox --json`. */
export interface InboxReport {
  schema: "selfhost.inbox/v1";
  mode: "solo" | "team";
  person: string;
  /** true when the list could not be reached and the items come from the saved copy. */
  offline: boolean;
  /** When the items were read: now, or when the saved copy was written. */
  as_of: string;
  /** Ranked: blocking first, then by risk, then oldest first. */
  items: ReviewItem[];
  /** Actions taken offline, sent when the list can be reached. */
  queued: QueuedAction[];
  /** What sending the queue did first. */
  sync: ReplayReport;
  /**
   * Runs teammates handed to this person, waiting for selfhost takeover. Team mode only, and
   * only while the server can be reached.
   */
  handoffs?: Handoff[];
}

/** `selfhost inbox approve|deny|snooze --json`. */
export interface InboxActionReport {
  schema: "selfhost.inbox_action/v1";
  action: InboxAction;
  item_id: string;
  /** applied: the list took it; queued: kept to send when the list can be reached. */
  outcome: "applied" | "queued";
  /** The item after the action, when applied. */
  item: ReviewItem | null;
  /** The decision.recorded event of an applied approve or deny. */
  decision_event: LedgerEvent | null;
  /** The queue entry, when queued. */
  queued: QueuedAction | null;
  /**
   * For an approved exception this machine's hook asked for: the grant that lets the agent make
   * the blocked call once. Null otherwise, also when the request came from another machine,
   * which writes its grant on its next import or inbox command.
   */
  grant: AnyGrant | null;
  sync: ReplayReport;
}

/** `selfhost inbox open --json`. */
export interface InboxItemReport {
  schema: "selfhost.inbox_item/v1";
  item: ReviewItem;
  offline: boolean;
  /** Whether the item's link was opened in the browser. */
  opened: boolean;
}

/** `selfhost inbox sync --json`. */
export interface InboxSyncReport extends ReplayReport {
  schema: "selfhost.inbox_sync/v1";
}

interface Session {
  mode: "solo" | "team";
  scope: InboxScope;
  paths: InboxPaths;
  now: Date;
  /** The live list; undefined when it cannot be reached and the saved copy stands in. */
  list?: ReviewList;
  /** Why the live list cannot be reached. */
  offline?: string;
  sync: ReplayReport;
  /** Where the exception grants come from: the local list, or the team server's grants. */
  lookup?: GrantSource;
  /** The grants this session wrote, once looked for. */
  grants?: Promise<GrantsReport | undefined>;
  configPath: string;
  close(): Promise<void>;
}

const NOTHING_SYNCED: ReplayReport = { results: [], remaining: 0, offline: false };
const HELD = "selfhost import --watch holds the local ledger";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function goOffline(session: Session, error: unknown): void {
  if (!isOffline(error)) throw error;
  session.offline = message(error);
  session.list = undefined;
}

/** A watcher holds the embedded ledger, which takes one process at a time. */
function watcherHolds(io: InboxIo, paths: InboxPaths): boolean {
  const inbox = readInboxCache(paths.cache, { server: null, team: null });
  return isAlive(inbox?.pid) || isAlive(readCache(statuslineCachePath(io))?.pid);
}

async function openSolo(
  options: CommonOptions,
  io: InboxIo,
  base: Omit<Session, "mode" | "scope" | "close" | "lookup">,
  given?: Ledger,
): Promise<Session> {
  const open = io.localReviewList;
  if (!open) {
    throw new Error(
      "Solo mode has no review list in this build yet. Join a team with selfhost join.",
    );
  }
  const scope = { server: null, team: null, person: localPerson(undefined, io) };
  const solo = { ...base, mode: "solo" as const, scope };
  const url = options.database ?? io.env.DATABASE_URL;
  const embedded = !(url && isPostgresUrl(url));
  if (!given && embedded && watcherHolds(io, base.paths)) {
    return { ...solo, offline: HELD, close: async () => {} };
  }
  const ledger = given ?? (await openLedger({ url, dataDir: options.dataDir }));
  const close = async () => {
    if (!given) await ledger.close();
  };
  try {
    // Blocked calls not imported yet go in first, so an exception asked for a moment ago is on
    // the list.
    await drainSpool(oneCopyPerFact(ledger), spoolDir(io.env), {
      person: scope.person,
      now: base.now,
      exceptionsOnly: true,
    });
    const list = await open(ledger);
    return { ...solo, list, lookup: (id) => list.get(id), close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * The review list for this machine: the team server's in team mode, the local ledger's in solo
 * mode. Actions queued earlier are sent first, in order, so a new one never overtakes them.
 */
async function openSession(options: CommonOptions, io: InboxIo, ledger?: Ledger) {
  const base = {
    paths: inboxPaths(io.configPath),
    now: io.now ?? new Date(),
    sync: NOTHING_SYNCED,
    configPath: io.configPath,
  };
  const membership = readMembership(io.configPath);
  const client = membership && new TeamClient(membership.server, membership.token, io.fetch);
  const session: Session =
    membership && client
      ? {
          ...base,
          mode: "team",
          scope: { server: membership.server, team: membership.team, person: membership.person },
          list: httpReviewList(membership.server, membership.token, io.fetch),
          lookup: serverGrants(client),
          close: async () => {},
        }
      : await openSolo(options, io, base, ledger);
  if (session.list) {
    try {
      session.sync = await replayQueue(session.list, session.paths, session.scope, session.now);
    } catch (error) {
      await session.close();
      throw error;
    }
    if (session.sync.offline) {
      session.offline = session.sync.error;
      session.list = undefined;
    }
  }
  return session;
}

/**
 * Writes the grants for this machine's approved exception requests, once per session and only
 * while the list can be reached. A failure leaves the requests for the next command.
 */
function sessionGrants(session: Session): Promise<GrantsReport | undefined> {
  const { list, lookup } = session;
  if (!list || !lookup) return Promise.resolve(undefined);
  session.grants ??= refreshGrants(session.configPath, lookup, session.now).catch(() => undefined);
  return session.grants;
}

async function withSession<T>(
  options: CommonOptions,
  io: InboxIo,
  ledger: Ledger | undefined,
  fn: (session: Session) => Promise<T>,
): Promise<T> {
  const session = await openSession(options, io, ledger);
  try {
    const result = await fn(session);
    await sessionGrants(session);
    return result;
  } finally {
    await session.close();
  }
}

const savedCopy = (session: Session) => readInboxCache(session.paths.cache, session.scope);

/** Whether an item is the caller's to answer: on a team server, one they own; solo, any. */
function mineIn(session: Session): (item: ReviewItem) => boolean {
  if (session.mode !== "team") return () => true;
  const person = session.scope.person.toLowerCase();
  return (item) => item.owners.some((owner) => owner.toLowerCase() === person);
}

/** The full id for what was typed: a full id, or the start or end of one open item's. */
async function resolveItem(session: Session, arg: string): Promise<string> {
  const full = fullId(arg);
  if (full) return full;
  const mine = mineIn(session);
  if (session.list) {
    try {
      return resolveId(arg, await listAll(session.list, { state: "open" }), "on the list", mine);
    } catch (error) {
      goOffline(session, error);
    }
  }
  const open = savedCopy(session)?.items.filter((item) => item.state === "open") ?? [];
  return resolveId(arg, open, "in the saved copy", mine);
}

function noCopyError(session: Session): Error {
  const why = session.offline ?? "the list could not be read";
  return new Error(
    session.mode === "team"
      ? `${why}, and there is no saved copy of the review list yet. Run selfhost inbox once online.`
      : `${why} and has not saved the review list yet. Try again in a minute.`,
  );
}

function syncLines(session: Session): string[] {
  const lines = replayLines(session.sync.results);
  if (session.sync.error && !session.sync.offline) {
    lines.push(
      `${plural(session.sync.remaining, "queued action")} not sent: ${session.sync.error}`,
    );
  }
  return lines;
}

/** Why the live list is not used: offline in team mode, a watcher holding the ledger in solo. */
const notLive = (session: Session) =>
  session.mode === "team" ? `Offline: ${session.offline}` : `${session.offline}`;

const ago = (iso: string, now: Date) =>
  `${clock(iso, now)} (${duration(now.getTime() - Date.parse(iso))} ago)`;

function whereQueued(session: Session): string {
  return session.mode === "team"
    ? `when ${session.scope.server} answers (any inbox command, or selfhost inbox sync)`
    : "by selfhost import --watch within a minute";
}

/** `selfhost inbox`: the person's pending items, from the live list or the saved copy. */
export async function runInboxList(
  options: InboxListOptions,
  io: InboxIo,
  ledger?: Ledger,
): Promise<InboxReport> {
  return withSession(options, io, ledger, async (session) => {
    const { scope, paths, now } = session;
    const all = options.all ?? false;
    if (session.list) {
      try {
        await refreshCache(session.list, paths.cache, scope, { all, now, stuck: true });
      } catch (error) {
        goOffline(session, error);
      }
    }
    const cache = savedCopy(session);
    if (!cache) throw noCopyError(session);
    const queued = queuedFor(readQueue(paths.queue), scope);
    const handoffs = session.offline === undefined ? await pendingHandoffs(io) : undefined;
    const report: InboxReport = {
      schema: "selfhost.inbox/v1",
      mode: session.mode,
      person: scope.person,
      offline: session.offline !== undefined,
      as_of: session.offline === undefined ? now.toISOString() : cache.written_at,
      items: pendingItems(cache, queued, now, all),
      queued,
      sync: session.sync,
      ...(handoffs ? { handoffs } : {}),
    };
    if (options.json) {
      io.write(JSON.stringify(report, null, 2));
      return report;
    }
    for (const line of syncLines(session)) io.write(line);
    if (session.offline) {
      io.write(`${notLive(session)}. Showing the copy saved ${ago(cache.written_at, now)}.`);
    }
    writeItems(report.items, now, io.write, session.mode === "team" ? scope.person : undefined);
    if (handoffs && handoffs.length > 0) {
      io.write("");
      io.write("Handed to you:");
      const short = shortIds(handoffs.map((handoff) => handoff.id));
      for (const handoff of handoffs) {
        io.write(`  ${handoffLine(handoff, short.get(handoff.id) ?? handoff.id, now)}`);
      }
      io.write("Take one over in a clone of its repository: selfhost takeover <id>");
    }
    if (queued.length > 0) {
      io.write("");
      io.write(`Queued, sent ${whereQueued(session)}:`);
      for (const action of queued) io.write(`  ${queuedText(action)}`);
    }
    return report;
  });
}

/** Runs handed to this person and not taken over yet; undefined when they cannot be read. */
async function pendingHandoffs(io: InboxIo): Promise<Handoff[] | undefined> {
  const membership = readMembership(io.configPath);
  if (!membership) return undefined;
  try {
    const client = new TeamClient(membership.server, membership.token, io.fetch);
    return (await client.handoffs({ to: "me", state: "pending" })).handoffs;
  } catch {
    // An older server without handoffs, or a blip: the review list is what the inbox is for.
    return undefined;
  }
}

function handoffLine(handoff: Handoff, id: string, now: Date): string {
  const note = handoff.note?.split("\n")[0]?.trim();
  const where = [handoff.repo, handoff.branch].filter(Boolean).join(" ");
  return `${id}  run ${handoff.run_id.slice(0, 8)} from ${handoff.from}, ${duration(now.getTime() - Date.parse(handoff.created_at))} ago${where ? `, ${where}` : ""}${note ? `: ${note}` : ""}`;
}

interface Applied {
  item: ReviewItem;
  decision_event?: LedgerEvent;
}

/**
 * Applies one action on the live list, or queues it when the list cannot be reached. An item
 * that is no longer open is an error, and nothing is queued for it.
 */
async function act(
  session: Session,
  arg: string,
  action: InboxAction,
  fields: { reason?: string; until?: string },
  apply: (list: ReviewList, id: string) => Promise<Applied>,
): Promise<InboxActionReport> {
  const { scope, paths, now } = session;
  const id = await resolveItem(session, arg);
  const report = (outcome: "applied" | "queued"): InboxActionReport => ({
    schema: "selfhost.inbox_action/v1",
    action,
    item_id: id,
    outcome,
    item: null,
    decision_event: null,
    queued: null,
    grant: null,
    sync: session.sync,
  });
  const closed = (item: ReviewItem) => {
    updateInboxCache(paths.cache, scope, (cache) => replaceItem(cache, item));
    return new Error(`${id} was ${closedText(item)}. Nothing changed.`);
  };
  if (session.list) {
    try {
      const applied = await apply(session.list, id);
      // With no saved copy yet, save one now so the snooze and the statusline count stick.
      if (!savedCopy(session)) {
        await refreshCache(session.list, paths.cache, scope, { now }).catch(() => {});
      }
      updateInboxCache(paths.cache, scope, (cache) => {
        replaceItem(cache, applied.item);
        if (fields.until) cache.snoozed[id] = fields.until;
      });
      return {
        ...report("applied"),
        item: applied.item,
        decision_event: applied.decision_event ?? null,
      };
    } catch (error) {
      const item = closedItem(error);
      if (item) throw closed(item);
      goOffline(session, error);
    }
  }
  const saved = savedCopy(session)?.items.find((item) => item.id === id);
  if (saved && saved.state !== "open") throw closed(saved);
  const queued: QueuedAction = {
    id: randomUUID(),
    action,
    item_id: id,
    by: scope.person,
    at: now.toISOString(),
    ...(fields.reason === undefined ? {} : { reason: fields.reason }),
    ...(fields.until === undefined ? {} : { until: fields.until }),
    server: scope.server,
    team: scope.team,
  };
  appendQueue(paths.queue, queued);
  return { ...report("queued"), queued };
}

function printAction(
  report: InboxActionReport,
  session: Session,
  json: boolean | undefined,
  io: InboxIo,
): void {
  if (json) {
    io.write(JSON.stringify(report, null, 2));
    return;
  }
  for (const line of syncLines(session)) io.write(line);
  if (report.queued) {
    io.write(`${notLive(session)}.`);
    io.write(`Queued ${queuedText(report.queued)}, sent ${whereQueued(session)}.`);
    return;
  }
  const title = report.item ? `: ${report.item.title}` : "";
  const done = { approve: "Approved", deny: "Denied", snooze: "Snoozed" }[report.action];
  io.write(`${done} ${report.item_id}${title}.`);
  if (report.decision_event) io.write(`Recorded decision ${report.decision_event.id}.`);
  if (report.grant) io.write(grantLine(report.grant, session.now));
  else if (report.action === "approve" && report.item?.kind === "exception") {
    io.write(
      "The machine that asked allows the call once it next runs selfhost import or selfhost inbox.",
    );
  }
}

/**
 * The server's 403 for approving one's own exception says only that it is not allowed. When the
 * person is also the team's only owner or admin, nobody can approve it: say so, with the ways on.
 */
async function soleApprover(
  error: unknown,
  list: ReviewList,
  id: string,
  person: string,
): Promise<unknown> {
  if (!(error instanceof TeamApiError) || error.status !== 403) return error;
  const item = await list.get(id).catch(() => undefined);
  return item && needsAnotherApprover(item, person) ? new Error(SOLE_APPROVER_REFUSAL) : error;
}

/** `selfhost inbox approve|deny <id>`: answers an item; the list records the decision. */
export async function runInboxDecide(
  verdict: "approve" | "deny",
  arg: string,
  options: InboxDecideOptions,
  io: InboxIo,
  ledger?: Ledger,
): Promise<InboxActionReport> {
  return withSession(options, io, ledger, async (session) => {
    const reason = options.reason?.trim() || undefined;
    const report = await act(session, arg, verdict, { reason }, async (list, id) => {
      const at = session.now.toISOString();
      const by = session.scope.person;
      try {
        const response = await list.decide(id, { verdict, by, at, ...(reason ? { reason } : {}) });
        return { item: response.item, decision_event: response.decision_event };
      } catch (error) {
        throw await soleApprover(error, list, id, by);
      }
    });
    if (report.outcome === "applied" && report.item?.kind === "exception") {
      const grants = await sessionGrants(session);
      report.grant = grants?.issued.find((grant) => grant.id === report.item_id) ?? null;
    }
    printAction(report, session, options.json, io);
    return report;
  });
}

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** When a snooze ends: --until, else now plus --for (default 1h). */
export function snoozeUntil(options: InboxSnoozeOptions, now: Date): string {
  if (options.for !== undefined && options.until !== undefined) {
    throw new Error("Pass --for or --until, not both");
  }
  if (options.until !== undefined) {
    const until = new Date(options.until);
    if (Number.isNaN(until.getTime())) {
      throw new Error(`--until: expected a date and time, got "${options.until}"`);
    }
    if (until <= now) throw new Error(`--until: ${options.until} is not in the future`);
    return until.toISOString();
  }
  const value = options.for ?? "1h";
  const match = /^(\d+)([mhdw])$/.exec(value.trim());
  const ms = match ? Number(match[1]) * (UNIT_MS[match[2] ?? ""] ?? 0) : 0;
  if (!(ms > 0)) {
    throw new Error(`--for: expected a duration like 30m, 2h, 1d or 1w, got "${value}"`);
  }
  return new Date(now.getTime() + ms).toISOString();
}

/** `selfhost inbox snooze <id>`: hides an item until later. */
export async function runInboxSnooze(
  arg: string,
  options: InboxSnoozeOptions,
  io: InboxIo,
  ledger?: Ledger,
): Promise<InboxActionReport> {
  const until = snoozeUntil(options, io.now ?? new Date());
  return withSession(options, io, ledger, async (session) => {
    const report = await act(session, arg, "snooze", { until }, async (list, id) => ({
      item: await list.snooze(id, { by: session.scope.person, until }),
    }));
    if (!options.json && report.outcome === "applied") {
      printAction(report, session, false, io);
      io.write(`It comes back ${clock(until, session.now)}.`);
    } else {
      printAction(report, session, options.json, io);
    }
    return report;
  });
}

/** Opens a link with the OS opener, detached, ignoring a missing opener. */
export function systemOpener(platform: NodeJS.Platform): (url: string) => void {
  return (url) => {
    const [command, args] =
      platform === "darwin"
        ? ["open", [url]]
        : platform === "win32"
          ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
          : ["xdg-open", [url]];
    const child = spawn(command as string, args as string[], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  };
}

const webLink = (url: string | undefined): url is string => {
  if (!url) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

/**
 * `selfhost inbox open <id>`: prints the item with its brief, and opens its link in the
 * browser when stdout is a terminal (never with --json or --no-open).
 */
export async function runInboxOpen(
  arg: string,
  options: InboxOpenOptions,
  io: InboxIo,
  ledger?: Ledger,
): Promise<InboxItemReport> {
  return withSession(options, io, ledger, async (session) => {
    const id = await resolveItem(session, arg);
    let item: ReviewItem | undefined;
    if (session.list) {
      try {
        item = await session.list.get(id);
      } catch (error) {
        goOffline(session, error);
      }
    }
    if (!session.list) item = savedCopy(session)?.items.find((saved) => saved.id === id);
    if (!item) {
      throw new Error(
        session.list ? `No item ${id}` : `No item ${id} in the saved copy (${session.offline})`,
      );
    }
    const tty = io.isTTY ?? process.stdout.isTTY === true;
    const opened = !options.json && options.open !== false && tty && webLink(item.url);
    const report: InboxItemReport = {
      schema: "selfhost.inbox_item/v1",
      item,
      offline: session.offline !== undefined,
      opened,
    };
    if (options.json) {
      io.write(JSON.stringify(report, null, 2));
      return report;
    }
    for (const line of syncLines(session)) io.write(line);
    if (session.offline) io.write(`${notLive(session)}. From the saved copy.`);
    for (const line of itemLines(item, session.now)) io.write(line);
    if (opened && item.url) (io.openUrl ?? systemOpener(io.platform))(item.url);
    return report;
  });
}

/**
 * `selfhost inbox sync`: sends the actions queued offline, then refreshes the saved copy.
 * Exits 1 while actions stay queued.
 */
export async function runInboxSync(
  options: CommonOptions,
  io: InboxIo,
  ledger?: Ledger,
): Promise<InboxSyncReport> {
  return withSession(options, io, ledger, async (session) => {
    if (session.list) {
      try {
        await refreshCache(session.list, session.paths.cache, session.scope, { now: session.now });
      } catch (error) {
        goOffline(session, error);
      }
    }
    const remaining = queuedFor(readQueue(session.paths.queue), session.scope).length;
    const error = session.sync.error ?? session.offline;
    const report: InboxSyncReport = {
      schema: "selfhost.inbox_sync/v1",
      ...session.sync,
      offline: session.offline !== undefined,
      remaining,
      ...(remaining > 0 && error !== undefined ? { error } : {}),
    };
    if (remaining > 0) io.setExitCode(1);
    if (options.json) {
      io.write(JSON.stringify(report, null, 2));
      return report;
    }
    for (const line of replayLines(report.results)) io.write(line);
    if (remaining > 0) {
      io.write(
        `${plural(remaining, "queued action")} not sent yet: ${error}. They go ${whereQueued(session)}.`,
      );
    } else if (report.results.length === 0) {
      io.write("Nothing queued.");
    }
    const cache = savedCopy(session);
    if (cache && !session.offline) {
      const pending = pendingItems(cache, [], session.now).length;
      io.write(`${pending} to review. Run selfhost inbox to see them.`);
    }
    return report;
  });
}

type Fail = (error: unknown, json: boolean | undefined) => void;

function withLedger(command: Command): Command {
  return command
    .option("--json", "print JSON")
    .option("--database <url>", "solo mode: Postgres url (default: DATABASE_URL)")
    .option("--data-dir <path>", "solo mode: embedded ledger folder (default: ~/.selfhost/data)");
}

const ID_HELP = "item id, or enough of its start to tell it apart";

/** approve or deny from the command line: only a person at a terminal, never an agent. */
function decideAsPerson(
  what: string,
  verdict: "approve" | "deny",
  id: string,
  options: InboxDecideOptions,
  io: InboxIo,
): Promise<InboxActionReport> {
  requireHuman(what, { env: io.env, stdinIsTTY: io.stdinIsTTY === true });
  return runInboxDecide(verdict, id, options, io);
}

/**
 * `selfhost inbox` and its approve, deny, snooze, open and sync commands, and `selfhost review
 * approve|deny`, the same answers under the review command.
 */
export function registerInbox(program: Command, io: () => InboxIo, fail: Fail): void {
  const inbox = withLedger(
    program
      .command("inbox")
      .description("your pending review items; approve, deny, snooze or open one by id")
      .option("--all", "every open item, not only yours, snoozed ones included"),
  )
    .enablePositionalOptions()
    .action(async (options: InboxListOptions) => {
      try {
        await runInboxList(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });

  for (const verdict of ["approve", "deny"] as const) {
    withLedger(
      inbox
        .command(verdict)
        .description(`${verdict} an item; records your decision in the decision log`)
        .argument("<id>", ID_HELP)
        .option("--reason <text>", "why, in your own words"),
    ).action(async (id: string, options: InboxDecideOptions) => {
      try {
        await decideAsPerson(`selfhost inbox ${verdict}`, verdict, id, options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
  }

  const review =
    program.commands.find((command) => command.name() === "review") ??
    program.command("review").description("score and route agent pull requests");
  for (const verdict of ["approve", "deny"] as const) {
    withLedger(
      review
        .command(verdict)
        .description(`${verdict} a review item, as selfhost inbox ${verdict} does`)
        .argument("<id>", ID_HELP)
        .option("--reason <text>", "why, in your own words"),
    ).action(async (id: string, options: InboxDecideOptions) => {
      try {
        await decideAsPerson(`selfhost review ${verdict}`, verdict, id, options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
  }

  withLedger(
    inbox
      .command("snooze")
      .description("hide an item from your list until later")
      .argument("<id>", ID_HELP)
      .option("--for <duration>", "how long, like 30m, 2h, 1d or 1w (default 1h)")
      .option("--until <time>", "until a date and time, like 2026-11-09T09:00"),
  ).action(async (id: string, options: InboxSnoozeOptions) => {
    try {
      await runInboxSnooze(id, options, io());
    } catch (error) {
      fail(error, options.json);
    }
  });

  withLedger(
    inbox
      .command("open")
      .description("print an item with its brief and open its link in the browser")
      .argument("<id>", ID_HELP)
      .option("--no-open", "print the item without opening its link"),
  ).action(async (id: string, options: InboxOpenOptions) => {
    try {
      await runInboxOpen(id, options, io());
    } catch (error) {
      fail(error, options.json);
    }
  });

  withLedger(
    inbox
      .command("sync")
      .description("send the actions queued while offline, then refresh the saved copy"),
  ).action(async (options: CommonOptions) => {
    try {
      await runInboxSync(options, io());
    } catch (error) {
      fail(error, options.json);
    }
  });
}

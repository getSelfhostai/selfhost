import type { Ledger } from "@selfhost/ledger";
import { PAGE_LIMIT_MAX, type ReviewItem } from "@selfhost/schema";
import type { LookupItem } from "../hooks/exceptions.js";
import { type Fetch, TeamApiError, TeamClient } from "../team/client.js";
import type { Membership } from "../team/config.js";
import { grantLine, refreshGrants } from "./grants.js";
import { closedItem, httpReviewList } from "./http.js";
import type { ReviewList } from "./review-list.js";
import {
  type InboxPaths,
  type InboxScope,
  inboxPaths,
  liveSnoozes,
  type QueuedAction,
  queuedFor,
  readInboxCache,
  readQueue,
  removeQueued,
  replaceItem,
  updateInboxCache,
  writeInboxCache,
} from "./store.js";
import { closedText, replayLines } from "./text.js";

/** Solo mode's review list over the local ledger. */
export type OpenLocalReviewList = (ledger: Ledger) => ReviewList | Promise<ReviewList>;

/** No answer from the team server: unreachable, timed out, or a proxy saying it is down. */
export function isOffline(error: unknown): boolean {
  return error instanceof TeamApiError && [0, 502, 503, 504].includes(error.status);
}

/** A queued action is kept for later, not dropped, on these: offline, refused token, overload. */
function keepForLater(error: TeamApiError): boolean {
  const { status } = error;
  return isOffline(error) || [401, 403, 408, 429].includes(status) || status >= 500;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Every page of a query. */
export async function listAll(
  list: ReviewList,
  query: { state?: "open"; owner?: string },
): Promise<ReviewItem[]> {
  const items: ReviewItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await list.list({ ...query, limit: PAGE_LIMIT_MAX, cursor });
    items.push(...page.items);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return items;
}

/** Reads the open items (the person's, or everyone's with `all`) and saves them as the copy. */
export async function refreshCache(
  list: ReviewList,
  path: string,
  scope: InboxScope,
  options: { all?: boolean; now: Date; pid?: number | null },
): Promise<ReviewItem[]> {
  const all = options.all ?? false;
  const items = await listAll(list, { state: "open", ...(all ? {} : { owner: scope.person }) });
  const previous = readInboxCache(path, scope);
  writeInboxCache(path, {
    schema: "selfhost.inbox_cache/v1",
    written_at: options.now.toISOString(),
    pid: options.pid ?? previous?.pid ?? null,
    ...scope,
    all,
    items,
    snoozed: liveSnoozes(previous?.snoozed ?? {}, options.now),
  });
  return items;
}

/** What replaying one queued action did. */
export interface ReplayEntry {
  queued: QueuedAction;
  /** applied: the list took it; conflict: someone answered first; dropped: it could not apply. */
  outcome: "applied" | "conflict" | "dropped";
  /** The item as it is now, when known. */
  item?: ReviewItem;
  message: string;
}

export interface ReplayReport {
  results: ReplayEntry[];
  /** Actions still queued for this team. */
  remaining: number;
  /** true when the list could not be reached, so the rest stays queued. */
  offline: boolean;
  /** Why the replay stopped before the end of the queue. */
  error?: string;
}

async function applyQueued(
  list: ReviewList,
  queued: QueuedAction,
  now: Date,
): Promise<ReplayEntry> {
  const { item_id: id, by, at } = queued;
  if (queued.action === "snooze") {
    const until = queued.until ?? at;
    if (Date.parse(until) <= now.getTime()) {
      return { queued, outcome: "dropped", message: "the snooze ended before it could sync" };
    }
    const item = await list.snooze(id, { by, until });
    return { queued, outcome: "applied", item, message: "snoozed" };
  }
  const reason = queued.reason === undefined ? {} : { reason: queued.reason };
  const response = await list.decide(id, { verdict: queued.action, by, at, ...reason });
  return { queued, outcome: "applied", item: response.item, message: queued.action };
}

/** How a failed replay settles: a conflict or a drop, or undefined to keep it for later. */
async function settle(
  list: ReviewList,
  queued: QueuedAction,
  error: unknown,
): Promise<ReplayEntry | undefined> {
  const closed = closedItem(error);
  if (closed) return { queued, outcome: "conflict", item: closed, message: closedText(closed) };
  if (error instanceof TeamApiError) {
    if (keepForLater(error)) return undefined;
    const why = error.status === 404 ? "no such item" : error.message;
    return { queued, outcome: "dropped", message: why };
  }
  // The local list: look the item up to tell a closed or missing item from a passing failure.
  const current = await list.get(queued.item_id).catch(() => null);
  if (current === undefined) return { queued, outcome: "dropped", message: "no such item" };
  if (current && current.state !== "open") {
    return { queued, outcome: "conflict", item: current, message: closedText(current) };
  }
  return undefined;
}

/**
 * Sends the queued actions for this team (or solo mode) in the order they were taken. An item
 * someone else answered first is reported as a conflict and dropped, never applied. The first
 * action that cannot be sent now (no network, a refused token, a server error) stops the
 * replay, and it and the ones after it stay queued. The saved copy is updated as items settle.
 */
export async function replayQueue(
  list: ReviewList,
  paths: InboxPaths,
  scope: Omit<InboxScope, "person">,
  now: Date,
): Promise<ReplayReport> {
  const queue = readQueue(paths.queue);
  const mine = queuedFor(queue, scope);
  const settled = new Set<string>();
  const results: ReplayEntry[] = [];
  let error: string | undefined;
  let offline = false;
  for (const queued of mine) {
    let entry: ReplayEntry | undefined;
    try {
      entry = await applyQueued(list, queued, now);
    } catch (failure) {
      entry = await settle(list, queued, failure);
      if (!entry) {
        error = message(failure);
        offline = isOffline(failure);
        break;
      }
    }
    results.push(entry);
    settled.add(queued.id);
  }
  removeQueued(paths.queue, settled);
  if (results.length > 0) {
    updateInboxCache(paths.cache, scope, (cache) => {
      for (const { queued, outcome, item } of results) {
        if (item) replaceItem(cache, item);
        else cache.items = cache.items.filter((saved) => saved.id !== queued.item_id);
        if (outcome === "applied" && queued.action === "snooze" && queued.until) {
          cache.snoozed[queued.item_id] = queued.until;
        }
      }
    });
  }
  return {
    results,
    remaining: mine.length - settled.size,
    offline,
    ...(error === undefined ? {} : { error }),
  };
}

export interface InboxRefreshOptions {
  list: ReviewList;
  scope: InboxScope;
  configPath: string;
  write: (line: string) => void;
  json?: boolean;
  /** Refresh this often with no batches landing. Default 60 s. */
  intervalMs?: number;
  /** A refresh runs at most this often while batches keep coming. Default 15 s. */
  minIntervalMs?: number;
  now?: () => Date;
  /**
   * Reads one item for the exception grants: each refresh writes a grant for every request of
   * this machine's hooks a person approved. Without it no grants are written.
   */
  lookup?: LookupItem;
}

export interface InboxRefresh {
  /** Schedules a refresh: right away, or once the minimum interval has passed. */
  refresh(): void;
  /** Waits for a running refresh and stops scheduling new ones. */
  close(): Promise<void>;
}

/**
 * Keeps the saved copy fresh for `selfhost import --watch`, so the statusline count follows new
 * items without a network call of its own: replays the queue, then rereads the person's open
 * items, at start, after batches and once a minute.
 */
export async function startInboxRefresh(opts: InboxRefreshOptions): Promise<InboxRefresh> {
  const clock = opts.now ?? (() => new Date());
  const paths = inboxPaths(opts.configPath);
  const minInterval = opts.minIntervalMs ?? 15_000;
  let last = Number.NEGATIVE_INFINITY;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  let closed = false;
  let failed: string | undefined;

  const say = (report: object, lines: string[]) => {
    if (opts.json) opts.write(JSON.stringify({ schema: "selfhost.inbox_sync/v1", ...report }));
    else for (const line of lines) opts.write(line);
  };

  async function run(): Promise<void> {
    last = Date.now();
    try {
      const replay = await replayQueue(opts.list, paths, opts.scope, clock());
      if (replay.results.length > 0) say(replay, replayLines(replay.results));
      if (replay.error !== undefined) throw new Error(replay.error);
      await refreshCache(opts.list, paths.cache, opts.scope, { now: clock(), pid: process.pid });
      if (opts.lookup) {
        const grants = await refreshGrants(opts.configPath, opts.lookup, clock());
        if (grants?.issued.length) {
          say(
            { grants: grants.issued.map((grant) => grant.id) },
            grants.issued.map((grant) => grantLine(grant, clock())),
          );
        }
      }
      failed = undefined;
    } catch (error) {
      const text = message(error);
      if (text !== failed) say({ error: text }, [`Inbox refresh failed: ${text}`]);
      failed = text;
    }
  }

  function schedule(): void {
    if (closed || timer) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        running = running.then(run);
      },
      Math.max(0, last + minInterval - Date.now()),
    );
    timer.unref?.();
  }

  const interval = setInterval(schedule, opts.intervalMs ?? 60_000);
  interval.unref?.();
  running = run();
  await running;

  return {
    refresh: schedule,
    async close() {
      closed = true;
      clearInterval(interval);
      if (timer) clearTimeout(timer);
      timer = undefined;
      await running;
    },
  };
}

/** The refresh for `import --watch`: the server's list in team mode, else the local one. */
export async function watchInbox(
  ledger: Ledger,
  options: {
    membership: Membership | undefined;
    person: string;
    configPath: string;
    fetch: Fetch;
    localReviewList?: OpenLocalReviewList;
    write: (line: string) => void;
    json?: boolean;
  },
): Promise<InboxRefresh | undefined> {
  const { membership } = options;
  const list = membership
    ? httpReviewList(membership.server, membership.token, options.fetch)
    : await options.localReviewList?.(ledger);
  if (!list) return undefined;
  const client = membership && new TeamClient(membership.server, membership.token, options.fetch);
  const lookup: LookupItem = client ? (id) => client.reviewItem(id) : (id) => list.get(id);
  return startInboxRefresh({
    list,
    scope: {
      server: membership?.server ?? null,
      team: membership?.team ?? null,
      person: membership?.person ?? options.person,
    },
    configPath: options.configPath,
    write: options.write,
    json: options.json,
    lookup,
  });
}

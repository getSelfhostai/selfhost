import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ReviewItem } from "@selfhost/schema";

/** Whose review list: a team on a server, or solo mode (server and team null). */
export interface InboxScope {
  server: string | null;
  team: string | null;
  person: string;
}

/**
 * The last copy of the review list read from the server or the local ledger, kept next to the
 * config file. `selfhost inbox` falls back to it with no network, and `selfhost statusline` counts
 * pending items from it, so neither needs a network call to show them.
 */
export interface InboxCache extends InboxScope {
  schema: "selfhost.inbox_cache/v1";
  written_at: string;
  /** The `import --watch` process keeping it fresh, or null. */
  pid: number | null;
  /** true when `items` holds every open item, not only the person's. */
  all: boolean;
  /** Open items, ranked as the list returned them. */
  items: ReviewItem[];
  /** Items the person snoozed from this machine, and until when. */
  snoozed: Record<string, string>;
}

export type InboxAction = "approve" | "deny" | "snooze";

/** One line of the queue: an action taken while the review list could not be reached. */
export interface QueuedAction {
  /** Id of the queue entry. */
  id: string;
  action: InboxAction;
  item_id: string;
  by: string;
  /** When the person acted. */
  at: string;
  reason?: string;
  /** For snooze. */
  until?: string;
  server: string | null;
  team: string | null;
}

export interface InboxPaths {
  cache: string;
  queue: string;
}

export function inboxPaths(configPath: string): InboxPaths {
  const dir = dirname(configPath);
  return { cache: join(dir, "inbox.json"), queue: join(dir, "inbox-queue.jsonl") };
}

const sameScope = (a: Omit<InboxScope, "person">, b: Omit<InboxScope, "person">) =>
  a.server === b.server && a.team === b.team;

/** The saved copy for this team (or solo mode); one left by another membership is ignored. */
export function readInboxCache(
  path: string,
  scope: Omit<InboxScope, "person">,
): InboxCache | undefined {
  try {
    const cache = JSON.parse(readFileSync(path, "utf8")) as InboxCache;
    return cache?.schema === "selfhost.inbox_cache/v1" && sameScope(cache, scope)
      ? cache
      : undefined;
  } catch {
    return undefined;
  }
}

/** Written to a temporary file and renamed, so a reader never sees half of it. */
function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

export function writeInboxCache(path: string, cache: InboxCache): void {
  writeAtomically(path, `${JSON.stringify(cache)}\n`);
}

/** Changes the saved copy in place, when there is one for this scope. */
export function updateInboxCache(
  path: string,
  scope: Omit<InboxScope, "person">,
  change: (cache: InboxCache) => void,
): void {
  const cache = readInboxCache(path, scope);
  if (!cache) return;
  change(cache);
  writeInboxCache(path, cache);
}

/** Puts the item as it is now in place of the saved one. */
export function replaceItem(cache: InboxCache, item: ReviewItem): void {
  cache.items = cache.items.map((saved) => (saved.id === item.id ? item : saved));
}

/** Every queued action, oldest first; a malformed line is skipped. */
export function readQueue(path: string): QueuedAction[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const actions: QueuedAction[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const action = JSON.parse(line) as QueuedAction;
      if (typeof action?.id === "string" && typeof action.item_id === "string") {
        actions.push(action);
      }
    } catch {
      // A line cut short by a crash; the rest of the queue still counts.
    }
  }
  return actions;
}

/** The queued actions for this team (or solo mode). */
export const queuedFor = (queue: QueuedAction[], scope: Omit<InboxScope, "person">) =>
  queue.filter((action) => sameScope(action, scope));

export function appendQueue(path: string, action: QueuedAction): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(action)}\n`, { mode: 0o600 });
}

/** Takes settled actions out, keeping any queued since they were read. */
export function removeQueued(path: string, ids: ReadonlySet<string>): void {
  if (ids.size === 0) return;
  const rest = readQueue(path).filter((action) => !ids.has(action.id));
  if (rest.length === 0) rmSync(path, { force: true });
  else writeAtomically(path, rest.map((action) => `${JSON.stringify(action)}\n`).join(""));
}

/**
 * What still waits on the person: open items they own (all open items with `all`), less those
 * answered in the queue and, without `all`, those snoozed until later.
 */
export function pendingItems(
  cache: InboxCache,
  queue: QueuedAction[],
  now: Date,
  all = false,
): ReviewItem[] {
  const answered = new Set(
    queue.filter((action) => action.action !== "snooze").map((action) => action.item_id),
  );
  const snoozed = new Map(Object.entries(cache.snoozed));
  for (const action of queue) {
    if (action.action === "snooze" && action.until) snoozed.set(action.item_id, action.until);
  }
  const ms = now.getTime();
  return cache.items.filter((item) => {
    if (item.state !== "open" || answered.has(item.id)) return false;
    if (all) return true;
    if (cache.all && !item.owners.includes(cache.person)) return false;
    const until = snoozed.get(item.id);
    return until === undefined || Date.parse(until) <= ms;
  });
}

/** Snoozes still running, from `snoozed`. */
export function liveSnoozes(snoozed: Record<string, string>, now: Date): Record<string, string> {
  return Object.fromEntries(
    Object.entries(snoozed).filter(([, until]) => Date.parse(until) > now.getTime()),
  );
}

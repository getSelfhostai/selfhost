import { isPostgresUrl, type Ledger, openLedger } from "@selfhost/ledger";
import { oneSourcePerSession } from "@selfhost/spend";
import { inboxPaths, pendingItems, queuedFor, readInboxCache, readQueue } from "../inbox/store.js";
import { readMembership } from "../team/config.js";
import {
  cacheFrom,
  isAlive,
  isUsable,
  readCache,
  renderStatusline,
  type StatuslineCache,
  writeCache,
} from "./cache.js";
import { check, historyStart } from "./check.js";
import { localPerson } from "./person.js";
import {
  type AlertIo,
  effectiveTiers,
  type LedgerOptions,
  loadAlertSettings,
  parsePlanTiers,
  readEvents,
  readTiers,
  statuslineCachePath,
  type Tiers,
} from "./settings.js";

export interface StatuslineOptions extends LedgerOptions {
  person?: string;
  plan?: string;
  config?: string;
  /** The cache file. Default: SELFHOST_STATUSLINE_CACHE, else statusline.json next to the config. */
  cache?: string;
  /** Recompute even when the cache is fresh (never while a watcher holds the embedded ledger). */
  refresh?: boolean;
}

const NO_DATA = "selfhost: no data yet, run selfhost import";

/** A saved review list older than this, with no live watcher, is left off the line. */
const REVIEW_SHOWN_MS = 24 * 3_600_000;

/**
 * "3 to review", "3 to review, 1 blocking", or undefined when nothing waits: from the copy that
 * `selfhost inbox` and `import --watch` save, less what the person queued since. Local files only.
 */
export function reviewCount(configPath: string, now: Date): string | undefined {
  const membership = readMembership(configPath);
  const scope = { server: membership?.server ?? null, team: membership?.team ?? null };
  const paths = inboxPaths(configPath);
  const cache = readInboxCache(paths.cache, scope);
  if (!cache) return undefined;
  if (!isAlive(cache.pid) && now.getTime() - Date.parse(cache.written_at) > REVIEW_SHOWN_MS) {
    return undefined;
  }
  const items = pendingItems(cache, queuedFor(readQueue(paths.queue), scope), now);
  if (items.length === 0) return undefined;
  const blocking = items.filter((item) => item.blocking).length;
  return `${items.length} to review${blocking > 0 ? `, ${blocking} blocking` : ""}`;
}

async function recompute(
  options: StatuslineOptions,
  io: AlertIo,
  now: Date,
  flag: Tiers,
  ledger?: Ledger,
): Promise<StatuslineCache> {
  const settings = loadAlertSettings(io, options.config, false);
  const tiers = effectiveTiers(readTiers(io.configPath), flag);
  const person = localPerson(options.person, io);
  const target =
    ledger ??
    (await openLedger({ url: options.database ?? io.env.DATABASE_URL, dataDir: options.dataDir }));
  try {
    const from = historyStart(settings, now);
    const events = oneSourcePerSession([
      ...(await readEvents(target, "cost.recorded", from)),
      ...(await readEvents(target, "alert.raised", from)),
    ]);
    const since = new Date(now.getTime() - 60 * 60_000);
    return cacheFrom(check(events, { person, now, since, settings, tiers }), person, now, null);
  } finally {
    if (!ledger) await target.close();
  }
}

/**
 * Prints one short line for an agent's status bar: the pending review count, then a spend spike
 * from the last hour, else a plan limit about to run out, else spend today. It reads the caches
 * `selfhost import --watch` keeps and never calls the network; it opens the ledger only when
 * there is no fresh cache and no watcher holding it (the embedded ledger takes one process at a
 * time). Missing data never fails it: it says so instead. Only a malformed --plan is an error.
 */
export async function runStatusline(
  options: StatuslineOptions,
  io: AlertIo,
  ledger?: Ledger,
): Promise<string> {
  const now = io.now ?? new Date();
  // A mistyped --plan in the agent's settings should show up, not read as "no data".
  const flag = parsePlanTiers(options.plan);
  const path = options.cache ?? statuslineCachePath(io);
  const cached = readCache(path);
  const url = options.database ?? io.env.DATABASE_URL;
  const embedded = !(url && isPostgresUrl(url));
  const held = embedded && isAlive(cached?.pid);
  const review = reviewCount(io.configPath, now);
  let line: string;
  if (cached && (held || (!options.refresh && isUsable(cached, now)))) {
    line = renderStatusline(cached, now, review);
  } else {
    try {
      const fresh = await recompute(options, io, now, flag, ledger);
      try {
        writeCache(path, fresh);
      } catch {
        // A read-only home still gets a line, just not a cached one.
      }
      line = renderStatusline(fresh, now, review);
    } catch {
      line = cached ? renderStatusline(cached, now, review) : (review ?? NO_DATA);
    }
  }
  io.write(line);
  return line;
}

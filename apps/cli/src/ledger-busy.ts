import { resolve } from "node:path";
import { isPostgresUrl, resolveDataDir } from "@selfhost/ledger";
import { isAlive } from "./alerts/cache.js";
import { feedDir, readWatcher } from "./tail/feed.js";

export interface BusyCheck {
  env: NodeJS.ProcessEnv;
  /** ~/.selfhost/config.json: the watcher's record is in the feed folder next to it. */
  configPath: string;
  /** --database, else DATABASE_URL: a Postgres ledger is never refused here. */
  database?: string;
  dataDir?: string;
}

/**
 * Throws when `selfhost import --watch` holds the embedded ledger these commands would replace,
 * snapshot or rewrite: PGlite allows one process at a time, and a watcher keeps writing to the
 * folder it opened, even after a restore moved it aside. The watcher's record (watcher.json in the
 * feed folder) names its pid and, since this release, its ledger folder; a record without one
 * counts as the default folder's.
 */
export function refuseWhileWatching(what: string, check: BusyCheck | undefined): void {
  if (!check) return;
  const url = check.database ?? check.env.DATABASE_URL;
  if (url?.trim() && isPostgresUrl(url)) return;
  const dataDir = resolve(resolveDataDir(check.dataDir, check.env));
  const watcher = readWatcher(feedDir(check.env, check.configPath));
  if (!watcher || watcher.pid === process.pid || !isAlive(watcher.pid)) return;
  const held = resolve(watcher.data_dir ?? resolveDataDir(undefined, check.env));
  if (held !== dataDir) return;
  throw new Error(
    `selfhost import --watch (pid ${watcher.pid}) has the ledger at ${dataDir} open, so ${what} was refused: the watcher would go on writing to the folder it opened. Stop it first (Ctrl-C in its terminal, or kill ${watcher.pid}), run ${what} again, then start the watcher again.`,
  );
}

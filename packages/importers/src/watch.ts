import { stat } from "node:fs/promises";
import type { LedgerEvent } from "@selfhost/schema";
import { discoverLogFiles } from "./discover.js";
import { defaultSince } from "./events.js";
import { writeEvents } from "./import.js";
import { createFileState, type FileState, readChunk } from "./parse.js";
import { EventSelector } from "./select.js";
import type { LedgerWriter, WatchOptions } from "./types.js";

const DEFAULT_POLL_MS = 1000;
/** New log files are looked for every few polls, at least this often. */
const MAX_DISCOVER_EVERY_MS = 5000;
const POLLS_PER_DISCOVERY = 10;

/**
 * Imports the window like importAll, then tails every log: lines appended later are written
 * within one poll, without a restart. New files are picked up, truncated or rewritten files are
 * read again from the start (their ids repeat, so nothing doubles), and sessions that go quiet
 * get their session.ended. A failed append is retried on the next poll.
 */
export function watchLogs(
  writer: LedgerWriter,
  opts: WatchOptions,
  onBatch?: (n: number) => void,
): { close(): Promise<void> } {
  const since = opts.since ?? defaultSince();
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const discoverEveryMs = Math.min(MAX_DISCOVER_EVERY_MS, pollMs * POLLS_PER_DISCOVERY);
  const files = new Map<string, FileState>();
  const selector = new EventSelector();
  let queue: LedgerEvent[] = [];
  let lastDiscovery = Number.NEGATIVE_INFINITY;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  async function discover() {
    lastDiscovery = Date.now();
    for (const file of await discoverLogFiles(opts)) {
      if (files.has(file.path)) continue;
      const info = await stat(file.path).catch(() => undefined);
      if (!info?.isFile() || info.mtimeMs < since.getTime()) continue;
      files.set(file.path, createFileState(file.vendor, file.path, opts));
    }
  }

  async function poll(state: FileState) {
    const info = await stat(state.path).catch(() => undefined);
    if (!info) {
      files.delete(state.path);
      return;
    }
    if (info.size < state.offset) {
      // Truncated or rewritten: start over with fresh state.
      const fresh = createFileState(state.vendor, state.path, opts);
      files.set(state.path, fresh);
      state = fresh;
    }
    if (info.size === state.offset) {
      // Nothing new; still lets quiet sessions end.
      selector.add(state.mapper.flush(Date.now()));
      return;
    }
    selector.add(await readChunk(state).catch(() => []));
  }

  async function tick() {
    if (Date.now() - lastDiscovery >= discoverEveryMs) await discover();
    for (const state of [...files.values()]) {
      if (closed) return;
      await poll(state);
    }
    queue.push(...selector.drain(since));
    if (queue.length === 0) return;
    try {
      const { accepted } = await writeEvents(writer, queue);
      queue = [];
      onBatch?.(accepted);
    } catch {
      // Kept in the queue for the next poll; the ledger drops ids it already has.
    }
  }

  function schedule() {
    if (closed) return;
    timer = setTimeout(() => {
      running = run();
    }, pollMs);
  }

  function run() {
    return tick()
      .catch(() => undefined)
      .finally(schedule);
  }

  running = run();

  return {
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      await running.catch(() => undefined);
    },
  };
}

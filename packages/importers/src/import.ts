import { stat } from "node:fs/promises";
import { type LedgerEvent, MAX_EVENT_BATCH } from "@selfhost/schema";
import { discoverLogFiles } from "./discover.js";
import { defaultSince } from "./events.js";
import { createFileState, readChunk } from "./parse.js";
import { EventSelector } from "./select.js";
import type { ImportOptions, LedgerWriter } from "./types.js";

export interface WriteResult {
  accepted: number;
  duplicates: number;
}

/** Appends in batches the ledger accepts. Events arrive deduped, so no batch repeats an id. */
export async function writeEvents(
  writer: LedgerWriter,
  events: LedgerEvent[],
): Promise<WriteResult> {
  const result = { accepted: 0, duplicates: 0 };
  for (let start = 0; start < events.length; start += MAX_EVENT_BATCH) {
    const batch = await writer.append(events.slice(start, start + MAX_EVENT_BATCH));
    result.accepted += batch.accepted.length;
    result.duplicates += batch.duplicates.length;
  }
  return result;
}

/**
 * Reads every discovered log touched inside the window (default: the last 30 days) and appends
 * its events. Ids are deterministic, so a second run over the same files adds nothing.
 */
export async function importAll(
  writer: LedgerWriter,
  opts: ImportOptions,
): Promise<{ files: number; accepted: number; duplicates: number }> {
  const since = opts.since ?? defaultSince();
  const selector = new EventSelector();
  let files = 0;
  for (const file of await discoverLogFiles(opts)) {
    const info = await stat(file.path).catch(() => undefined);
    // A file last written before the window cannot hold events inside it.
    if (!info?.isFile() || info.mtimeMs < since.getTime()) continue;
    const events = await readChunk(createFileState(file.vendor, file.path, opts)).catch(
      () => undefined, // removed since discovery
    );
    if (!events) continue;
    selector.add(events);
    files++;
  }
  const written = await writeEvents(writer, selector.drain(since));
  return { files, ...written };
}

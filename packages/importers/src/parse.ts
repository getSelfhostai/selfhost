import { open } from "node:fs/promises";
import type { LedgerEvent } from "@selfhost/schema";
import { ClaudeCodeMapper } from "./claude-code.js";
import { CodexMapper } from "./codex.js";
import { defaultActorId } from "./events.js";
import { EventSelector } from "./select.js";
import type { ImportOptions, LineMapper, ParsedEvent, Vendor } from "./types.js";

const CHUNK_BYTES = 1 << 20;
const NEWLINE = 0x0a;

/** Read position and mapper state for one log file, kept between reads while tailing. */
export interface FileState {
  vendor: Vendor;
  path: string;
  offset: number;
  mapper: LineMapper;
  /** Complete lines read, blank ones aside. */
  lines: number;
  /** Complete lines that are not a JSON object, skipped. */
  skipped: number;
}

export function createFileState(vendor: Vendor, path: string, opts: ImportOptions): FileState {
  const ctx = {
    vendor,
    path,
    person: { kind: "person" as const, id: opts.actorId ?? defaultActorId() },
    logPrompts: opts.logPrompts === true,
  };
  const mapper = vendor === "claude_code" ? new ClaudeCodeMapper(ctx) : new CodexMapper(ctx);
  return { vendor, path, offset: 0, mapper, lines: 0, skipped: 0 };
}

/** A line's JSON object; "blank" for an empty line, undefined for one that is not an object. */
function parseLine(bytes: Buffer): Record<string, unknown> | "blank" | undefined {
  let text = bytes.toString("utf8");
  if (text.endsWith("\r")) text = text.slice(0, -1);
  if (text.trim() === "") return "blank";
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Feeds complete lines from `state.offset` up to `end` (default: end of file) to the mapper and
 * advances the offset past them. A final line without a newline is consumed only when it parses,
 * so a line still being written is read again next time.
 */
export async function readChunk(
  state: FileState,
  opts: { end?: number; now?: number } = {},
): Promise<ParsedEvent[]> {
  const out: ParsedEvent[] = [];
  const handle = await open(state.path, "r");
  try {
    const end = opts.end ?? (await handle.stat()).size;
    let position = state.offset;
    let carry: Buffer = Buffer.alloc(0);
    let carryStart = position;
    const buffer = Buffer.alloc(CHUNK_BYTES);
    while (position < end) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(CHUNK_BYTES, end - position),
        position,
      );
      if (bytesRead === 0) break;
      position += bytesRead;
      const data =
        carry.length > 0
          ? Buffer.concat([carry, buffer.subarray(0, bytesRead)])
          : buffer.subarray(0, bytesRead);
      let lineStart = 0;
      for (
        let index = data.indexOf(NEWLINE);
        index >= 0;
        index = data.indexOf(NEWLINE, lineStart)
      ) {
        const json = parseLine(data.subarray(lineStart, index));
        if (json !== "blank") {
          state.lines += 1;
          if (json) out.push(...state.mapper.line(json, carryStart + lineStart));
          else state.skipped += 1;
        }
        lineStart = index + 1;
      }
      carryStart += lineStart;
      carry = Buffer.from(data.subarray(lineStart));
    }
    state.offset = carryStart;
    if (carry.length > 0) {
      const json = parseLine(carry);
      if (json && json !== "blank") {
        state.lines += 1;
        out.push(...state.mapper.line(json, carryStart));
        state.offset = carryStart + carry.length;
      }
    }
  } finally {
    await handle.close();
  }
  out.push(...state.mapper.flush(opts.now ?? Date.now()));
  return out;
}

/**
 * Maps one log file to ledger events, from `fromOffset` (a line boundary, default 0) to the end.
 * Lines before `fromOffset` are read for context only, so ids match a full read. `since`, when
 * given, drops older events. Pure: the same file content gives the same events and ids.
 */
export async function parseLogFile(
  vendor: Vendor,
  path: string,
  opts: ImportOptions & { fromOffset?: number },
): Promise<{ events: LedgerEvent[]; nextOffset: number }> {
  const state = createFileState(vendor, path, opts);
  const fromOffset = opts.fromOffset ?? 0;
  const selector = new EventSelector();
  if (fromOffset > 0) {
    selector.remember(await readChunk(state, { end: fromOffset }));
    state.offset = fromOffset;
  }
  selector.add(await readChunk(state));
  return { events: selector.drain(opts.since), nextOffset: state.offset };
}

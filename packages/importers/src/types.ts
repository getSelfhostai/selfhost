import type { Actor, EventKind, LedgerEvent } from "@selfhost/schema";

export type Vendor = "claude_code" | "codex";

export interface ImportOptions {
  /** Only this vendor. Default: both. */
  vendor?: Vendor;
  /** Oldest event to import. Default for imports and watching: 30 days ago. */
  since?: Date;
  /** Store prompt text in `prompt.submitted` events. Default false: no prompt events at all. */
  logPrompts?: boolean;
  /** Claude config dir (holding `projects/`) or the `projects/` dir itself. */
  claudeDir?: string;
  /** Codex home (holding `sessions/` and `archived_sessions/`). */
  codexDir?: string;
  /** Person the sessions belong to. Default: the OS user name. */
  actorId?: string;
  /**
   * owner/name of the repository at a session's working folder. The CLI passes one that reads
   * the folder's git origin remote, as the MCP server's get_policy does. Without it, events of
   * sessions whose log names no repository carry none.
   */
  repoOf?: (cwd: string) => string | undefined;
}

export interface WatchOptions extends ImportOptions {
  /** How often tailed files are checked for new lines. Default 1000 ms. */
  pollIntervalMs?: number;
}

export interface LogFile {
  vendor: Vendor;
  path: string;
}

export interface LedgerWriter {
  append(events: LedgerEvent[]): Promise<{ accepted: string[]; duplicates: string[] }>;
}

/** A mapped event plus what the importer needs to dedupe it across files and runs. */
export interface ParsedEvent {
  event: LedgerEvent;
  /** Events with the same key describe the same fact, wherever they were read. */
  key: string;
  /** Which copy wins when several carry the same key: the earliest or the latest. */
  keep: "first" | "last";
  /** Claude sidechain replays: a sidechain copy loses to a main-thread entry in its group. */
  replay?: { group: string; sidechain: boolean };
}

export interface MapContext {
  vendor: Vendor;
  path: string;
  person: Actor;
  logPrompts: boolean;
  repoOf?: (cwd: string) => string | undefined;
}

export interface EventInput {
  kind: EventKind;
  /** "" for vendor ids that are unique across sessions, else the session id. */
  scope: string;
  identity: string;
  ts: string;
  sessionId: string;
  actor: Actor;
  version?: string;
  model?: string;
  keep?: "first" | "last";
  fields?: Partial<Omit<LedgerEvent, "id" | "schema" | "ts" | "source" | "kind" | "actor">>;
}

/** Turns transcript lines into events. One instance per file, fed lines in order. */
export interface LineMapper {
  line(json: Record<string, unknown>, offset: number): ParsedEvent[];
  /** End of a read: emits buffered events, and session.ended for sessions idle at `now`. */
  flush(now: number): ParsedEvent[];
}

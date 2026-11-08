import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { LedgerWriter } from "@selfhost/importers";
import {
  LedgerValidationError,
  mapClaudeCodeHook,
  mapCodexHook,
  mapCodexNotify,
  type SourceContext,
  stableEventId,
  toolDetails,
} from "@selfhost/ledger";
import { POLICY_ACTOR_ID } from "@selfhost/policy";
import {
  type Decision,
  EVENT_SCHEMA,
  type LedgerEvent,
  MAX_EVENT_BATCH,
  validateEvent,
} from "@selfhost/schema";
import { type GuardRecord, type HookAgent, SPOOL_FILE_PATTERN, type SpoolLine } from "./receive.js";
import { type PreToolCall, preToolCall } from "./vendors.js";

/** What one pass over the hook spool did; part of `selfhost import --json`. */
export interface SpoolReport {
  files: number;
  lines: number;
  accepted: number;
  /** Events the ledger already had: lines read on an earlier pass. */
  duplicates: number;
  /** Lines that are not a payload the mappers accept, skipped. */
  malformed: number;
  /** Files of finished days, fully imported and deleted. */
  removed: number;
}

export interface DrainOptions {
  /** actor.id for the events, the same person `selfhost import` uses. */
  person: string;
  logPrompts?: boolean;
  now?: Date;
  /** Leave every spool file in place. */
  keep?: boolean;
  /** Bytes already imported per file; --watch keeps it between passes. */
  offsets?: Map<string, number>;
}

/** A past day's file left untouched this long gets no more lines: hooks write today's file. */
const SETTLED_MS = 60_000;

/**
 * Ledger events for each agent's payloads. Cursor and OpenCode payloads map to no events of
 * their own yet; their pre-tool decisions are still recorded, from the guard record.
 */
const MAPPERS: Record<HookAgent, (payload: unknown, ctx: SourceContext) => LedgerEvent[]> = {
  claude: mapClaudeCodeHook,
  codex: mapCodexHook,
  "codex-notify": mapCodexNotify,
  cursor: () => [],
  opencode: () => [],
};

/** The tool input as toolDetails reads it, from the agent-neutral call. */
function inputOf(call: PreToolCall): Record<string, unknown> {
  if (call.command !== undefined) return { command: call.command };
  if (call.file !== undefined) return { file_path: call.file };
  if (call.url !== undefined) return { url: call.url };
  return {};
}

/** The verdict a decision records: what was applied, or for observe what enforcing would do. */
function verdictOf(guard: GuardRecord): Decision["verdict"] {
  const hit = guard.hit;
  if (!hit) return "allow";
  if (hit.mode === "observe") return hit.verdict;
  return guard.answer === "ask" ? "ask" : "block";
}

/**
 * The policy.evaluated event for a pre-tool decision: one per call the hook checked, allow
 * included. It copies agent, session, model, tool and target from the call's tool.called event
 * when the line has one, so the ledger masks secrets in them the same way. decision.mode is
 * enforce when an enforce hit decided, observe when only observe hits fired (the verdict then
 * says what enforcing would do, and the call went ahead), and absent for a plain allow.
 */
export function guardEvent(
  agent: HookAgent,
  payload: unknown,
  guard: GuardRecord,
  toolEvent: LedgerEvent | undefined,
  ts: string,
): LedgerEvent {
  const call =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? preToolCall(agent, payload as Record<string, unknown>)
      : undefined;
  const details = toolEvent
    ? { tool: toolEvent.tool, target: toolEvent.target }
    : call
      ? toolDetails(call.tool, inputOf(call), call.cwd)
      : {};
  const hit = guard.hit;
  const decision: Decision = {
    verdict: verdictOf(guard),
    by: POLICY_ACTOR_ID,
    ...(hit ? { reason: hit.message, rule_id: hit.rule_id, mode: hit.mode } : {}),
    ...(guard.policy ? { policy_hash: guard.policy.hash } : {}),
  };
  const key = toolEvent?.id ?? createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const agentRef = toolEvent?.agent ?? (call ? { vendor: call.vendor } : undefined);
  const sessionId = toolEvent?.session_id ?? call?.sessionId;
  const model = toolEvent?.model ?? call?.model;
  const data: Record<string, unknown> = {
    hook_event: call?.event,
    answer: guard.answer,
    hits: guard.hits,
    ...(toolEvent ? { tool_event_id: toolEvent.id } : {}),
    ...(call?.toolUseId ? { tool_use_id: call.toolUseId } : {}),
    ...(hit?.irreversible ? { irreversible: true } : {}),
    ...(guard.policy ? { policy_path: guard.policy.path } : {}),
    ...(guard.failures?.length ? { failures: guard.failures } : {}),
    ...(guard.fail_open ? { fail_open: true } : {}),
    check_ms: guard.ms,
  };
  return {
    id: stableEventId(ts, `policy.evaluated\nhook\n${key}`),
    schema: EVENT_SCHEMA,
    ts,
    source: "hook",
    kind: "policy.evaluated",
    actor: { kind: "system", id: POLICY_ACTOR_ID },
    ...(agentRef ? { agent: agentRef } : {}),
    ...(model ? { model } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(details.tool ? { tool: details.tool } : {}),
    ...(details.target ? { target: details.target } : {}),
    decision,
    data: Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
    ...(toolEvent?.redacted ? { redacted: toolEvent.redacted } : {}),
  };
}

/**
 * The events for one spool line, or undefined when it is malformed. The event time is the time
 * the hook received the payload, so reading the same line again gives the same ids.
 */
function mapLine(text: string, ctx: SourceContext): LedgerEvent[] | undefined {
  try {
    const line = JSON.parse(text) as Partial<SpoolLine>;
    const agent = line.agent;
    const ms = typeof line.received_at === "string" ? Date.parse(line.received_at) : Number.NaN;
    if (typeof agent !== "string" || !Object.hasOwn(MAPPERS, agent) || Number.isNaN(ms)) {
      return undefined;
    }
    const ts = new Date(ms).toISOString();
    const events = MAPPERS[agent](line.payload, { ...ctx, ts });
    if (line.guard) {
      const toolEvent = events.find((event) => event.kind === "tool.called");
      events.push(guardEvent(agent, line.payload, line.guard, toolEvent, ts));
    }
    return events.every((event) => validateEvent(event).ok) ? events : undefined;
  } catch {
    return undefined;
  }
}

interface Pending {
  event: LedgerEvent;
  /** file:line, to count a rejected line once. */
  line: string;
}

async function append(writer: LedgerWriter, batch: Pending[], rejected: Set<string>) {
  try {
    return await writer.append(batch.map(({ event }) => event));
  } catch (error) {
    // Values the schema allows but Postgres refuses, such as a NUL character: skip those lines.
    if (!(error instanceof LedgerValidationError)) throw error;
    const bad = new Set(error.errors.map(({ index }) => index));
    for (const index of bad) {
      const entry = batch[index];
      if (entry) rejected.add(entry.line);
    }
    return writer.append(batch.filter((_, index) => !bad.has(index)).map(({ event }) => event));
  }
}

/**
 * Maps the hook spool (`selfhost hook` lines) into the ledger. Only complete lines are read.
 * Ids are deterministic, so a line read twice is a duplicate. A file for a finished UTC day
 * is deleted once everything in it is imported; today's file stays, as hooks still append to it.
 */
export async function drainSpool(
  writer: LedgerWriter,
  dir: string | undefined,
  options: DrainOptions,
): Promise<SpoolReport> {
  const report: SpoolReport = {
    files: 0,
    lines: 0,
    accepted: 0,
    duplicates: 0,
    malformed: 0,
    removed: 0,
  };
  if (!dir) return report;
  const now = options.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const ctx: SourceContext = { person: options.person, logPrompts: options.logPrompts };
  const names = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => SPOOL_FILE_PATTERN.test(name))
    .sort();

  const pending = new Map<string, Pending>();
  const read: { path: string; end: number; settled: boolean }[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => undefined);
    const buffer = info?.isFile() ? await readFile(path).catch(() => undefined) : undefined;
    if (!info || !buffer) continue;
    const day = SPOOL_FILE_PATTERN.exec(name)?.[1] ?? today;
    const settled = day < today && now.getTime() - info.mtimeMs > SETTLED_MS;
    const offset = options.offsets?.get(path) ?? 0;
    const start = offset > buffer.length ? 0 : offset;
    // A settled file's cut-off last line never completes, so it is read (and counted) now.
    const end = settled ? buffer.length : buffer.lastIndexOf(0x0a) + 1;
    report.files += 1;
    const lines = buffer.subarray(start, Math.max(start, end)).toString("utf8").split("\n");
    for (const [n, text] of lines.entries()) {
      if (text.trim() === "") continue;
      report.lines += 1;
      const events = mapLine(text, ctx);
      if (!events) {
        report.malformed += 1;
        continue;
      }
      for (const event of events) pending.set(event.id, { event, line: `${name}:${n}` });
    }
    read.push({ path, end: Math.max(start, end), settled });
  }

  const rejected = new Set<string>();
  const all = [...pending.values()];
  for (let start = 0; start < all.length; start += MAX_EVENT_BATCH) {
    const result = await append(writer, all.slice(start, start + MAX_EVENT_BATCH), rejected);
    report.accepted += result.accepted.length;
    report.duplicates += result.duplicates.length;
  }
  report.malformed += rejected.size;

  for (const { path, end, settled } of read) {
    if (settled && !options.keep) {
      await rm(path, { force: true });
      options.offsets?.delete(path);
      report.removed += 1;
    } else {
      options.offsets?.set(path, end);
    }
  }
  return report;
}

/** For `selfhost import --watch`: drains the spool every poll until closed. */
export function watchSpool(
  writer: LedgerWriter,
  dir: string | undefined,
  options: Pick<DrainOptions, "person" | "logPrompts">,
  onBatch: (accepted: number) => void,
  pollMs = 1000,
): { close(): Promise<void> } {
  const offsets = new Map<string, number>();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  const tick = async (): Promise<void> => {
    try {
      const report = await drainSpool(writer, dir, { ...options, offsets });
      if (report.accepted + report.duplicates > 0) onBatch(report.accepted);
    } catch {
      // Left in the spool; the next poll tries again.
    }
    if (closed) return;
    timer = setTimeout(() => {
      running = tick();
    }, pollMs);
  };
  running = tick();
  return {
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}

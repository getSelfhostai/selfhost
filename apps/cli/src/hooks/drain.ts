import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { egressBlockedEvent } from "@selfhost/credentials";
import type { LedgerWriter } from "@selfhost/importers";
import {
  LedgerValidationError,
  mapClaudeCodeHook,
  mapCodexHook,
  mapCodexNotify,
  mapOpenCodePlugin,
  type SourceContext,
  stableEventId,
  toolDetails,
} from "@selfhost/ledger";
import { POLICY_ACTOR_ID } from "@selfhost/policy";
import {
  type Decision,
  EGRESS_ALLOW_RULE_ID,
  EVENT_SCHEMA,
  type ExecutionLocation,
  type LedgerEvent,
  MAX_EVENT_BATCH,
  namedAgentActor,
  validateEvent,
} from "@selfhost/schema";
import {
  type GuardRecord,
  type HookAgent,
  type McpSpoolLine,
  PULL_REQUEST_URL,
  SPOOL_FILE_PATTERN,
  type SpoolLine,
} from "./receive.js";
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
  /**
   * Lines skipped as the same hook call written twice: two hook entries (the managed settings'
   * and the user's) that both ran `selfhost hook` for one tool call or one event.
   */
  repeated: number;
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
  /**
   * Only the lines of calls that asked for or used a one-time exception, and every file is kept:
   * the inbox reads those in early so the item is on the list, and `selfhost import` later maps
   * the rest (those lines again as duplicates), with its own prompt setting.
   */
  exceptionsOnly?: boolean;
  /** The hook calls already read, for skipping the same call written twice; --watch keeps it. */
  seen?: Map<string, number>;
  /**
   * owner/name of the repository at a payload's cwd, set as each event's repo. Default: none,
   * so a caller that never looks at git (tests, a background run's sandbox) stays fast.
   */
  repoOf?: (cwd: string) => string | undefined;
  /**
   * Called after a pass that imported requests selfhost mcp spooled (an agent's question or
   * exception request): --watch sends their pushes right away.
   */
  onRequests?: () => void;
}

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A past day's file left untouched this long gets no more lines: hooks write today's file. */
const SETTLED_MS = 60_000;
/** Two lines of one hook call arrive this close together: both hooks run at once. */
const REPEAT_MS = 5_000;
/** --watch forgets hook calls older than this once it remembers more than SEEN_MAX. */
const SEEN_KEEP_MS = 10 * 60_000;
const SEEN_MAX = 10_000;

/**
 * Ledger events for each agent's payloads. Cursor payloads map to no events of their own yet;
 * their pre-tool decisions are still recorded, from the guard record. OpenCode's plugin sends
 * each tool call before it runs, recorded as tool.called with the person and the agent.
 */
const MAPPERS: Record<HookAgent, (payload: unknown, ctx: SourceContext) => LedgerEvent[]> = {
  claude: mapClaudeCodeHook,
  codex: mapCodexHook,
  "codex-notify": mapCodexNotify,
  cursor: () => [],
  opencode: mapOpenCodePlugin,
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
  if (!hit || guard.exception?.used) return "allow";
  if (hit.mode === "observe") return hit.verdict;
  return guard.answer === "ask" ? "ask" : "block";
}

/**
 * The policy.evaluated event for a pre-tool decision: one per call the hook checked, allow
 * included. It copies agent, session, model, tool and target from the call's tool.called event
 * when the line has one, so the ledger masks secrets in them the same way. decision.mode is
 * enforce when an enforce hit decided, observe when only observe hits fired (the verdict then
 * says what enforcing would do, and the call went ahead), and absent for a plain allow.
 *
 * A block carries its one-time exception request in data.exception and links.item_id: the
 * review list makes the exception item from it. A call an approved exception let through is an
 * allow under the rule it got past, with data.exception.used, who approved it and the decision.
 * So the ledger holds the request, the approval (decision.recorded) and the use.
 */
export function guardEvent(
  agent: HookAgent,
  payload: unknown,
  guard: GuardRecord,
  toolEvent: LedgerEvent | undefined,
  ts: string,
  repo?: string,
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
  const exception =
    guard.exception && UUIDV7.test(guard.exception.id) ? guard.exception : undefined;
  const reason =
    hit && exception?.used
      ? `Allowed once: ${exception.approved_by ?? "a person"} approved exception ${exception.id}. ${hit.message}`
      : hit?.message;
  const decision: Decision = {
    verdict: verdictOf(guard),
    by: POLICY_ACTOR_ID,
    ...(hit ? { reason, rule_id: hit.rule_id, mode: hit.mode } : {}),
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
    ...(hit?.alternative ? { alternative: hit.alternative } : {}),
    ...(exception ? { exception } : {}),
    ...(guard.policy ? { policy_path: guard.policy.path } : {}),
    ...(guard.failures?.length ? { failures: guard.failures } : {}),
    ...(guard.fail_open ? { fail_open: true } : {}),
    ...(guard.location ? { location: guard.location } : {}),
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
    ...((toolEvent?.repo ?? repo) ? { repo: toolEvent?.repo ?? repo } : {}),
    ...(details.tool ? { tool: details.tool } : {}),
    ...(details.target ? { target: details.target } : {}),
    decision,
    ...(exception ? { links: { item_id: exception.id } } : {}),
    data: Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
    ...(toolEvent?.redacted ? { redacted: toolEvent.redacted } : {}),
  };
}

/**
 * One egress.blocked event per host a call was stopped from reaching: the hook refused it under
 * egress.allow (enforce), with no approved exception letting it through.
 */
function blockedEgress(guard: GuardRecord, decision: LedgerEvent): LedgerEvent[] {
  const hit = guard.hit;
  if (hit?.rule_id !== EGRESS_ALLOW_RULE_ID || hit.mode !== "enforce") return [];
  if (guard.answer === "allow") return [];
  return (hit.hosts ?? []).map((host) =>
    egressBlockedEvent(
      { host, by: "hook" },
      {
        location: (guard.location ?? "laptop") as ExecutionLocation,
        ts: decision.ts,
        ...(decision.session_id ? { session_id: decision.session_id } : {}),
        ...(decision.agent ? { agent: decision.agent } : {}),
      },
    ),
  );
}

/**
 * The events for one spool line, or undefined when it is malformed. The event time is the time
 * the hook received the payload, so reading the same line again gives the same ids.
 */
function mapLine(
  text: string,
  ctx: SourceContext,
  exceptionsOnly = false,
  repoOf?: (cwd: string) => string | undefined,
): { events: LedgerEvent[]; mcp?: true } | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<SpoolLine> & Partial<McpSpoolLine>;
    // An agent's request through selfhost mcp; kept with exceptionsOnly, as it asks for one.
    if (parsed.source === "mcp") {
      const event = parsed.event;
      return event?.kind === "approval.requested" && validateEvent(event).ok
        ? { events: [event], mcp: true }
        : undefined;
    }
    const line: Partial<SpoolLine> = parsed;
    if (exceptionsOnly && !line.guard?.exception) return { events: [] };
    const agent = line.agent;
    const ms = typeof line.received_at === "string" ? Date.parse(line.received_at) : Number.NaN;
    if (typeof agent !== "string" || !Object.hasOwn(MAPPERS, agent) || Number.isNaN(ms)) {
      return undefined;
    }
    const ts = new Date(ms).toISOString();
    const payload = line.payload as Record<string, unknown> | null | undefined;
    const cwd = typeof payload?.cwd === "string" && payload.cwd !== "" ? payload.cwd : undefined;
    const repo = cwd && repoOf ? repoOf(cwd) : undefined;
    const events = MAPPERS[agent](line.payload, { ...ctx, ts, ...(repo ? { repo } : {}) });
    // The pull request the call opened links the run to it: the run view lists it, and
    // selfhost share posts on it. pr.opened itself stays the server's (the GitHub App's).
    const prUrl =
      typeof line.pr_url === "string" ? PULL_REQUEST_URL.exec(line.pr_url)?.[0] : undefined;
    if (prUrl) {
      for (const [index, event] of events.entries()) {
        if (event.kind === "tool.result") {
          events[index] = { ...event, links: { ...event.links, pr_url: prUrl } };
        }
      }
    }
    withLineContext(events, line);
    if (line.guard) {
      const toolEvent = events.find((event) => event.kind === "tool.called");
      const decision = guardEvent(agent, line.payload, line.guard, toolEvent, ts, repo);
      events.push(decision, ...blockedEgress(line.guard, decision));
    }
    return events.every((event) => validateEvent(event).ok) ? { events } : undefined;
  } catch {
    return undefined;
  }
}

const textOf = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

/**
 * What the hook saw beyond the payload: the branch goes into each event's data.branch (presence
 * reads it), and a named agent ([agents.<name>], from SELFHOST_AGENT_NAME) becomes the actor of
 * every event a person or an unnamed agent would otherwise be the actor of.
 */
function withLineContext(events: LedgerEvent[], line: Partial<SpoolLine>): void {
  const branch = textOf(line.branch);
  const named = textOf(line.named_agent);
  if (!branch && !named) return;
  for (const [index, event] of events.entries()) {
    events[index] = {
      ...event,
      ...(named && event.actor.kind !== "system" ? { actor: namedAgentActor(named) } : {}),
      ...(branch && event.data?.branch === undefined ? { data: { ...event.data, branch } } : {}),
    };
  }
}

/**
 * What makes two spool lines the same hook call, when two hook entries both ran `selfhost hook`
 * for it: the agent, session, hook event and the agent's tool call id (for an event with no tool
 * call, such as a prompt or a session start, the whole payload), received within a few seconds
 * of each other, as both hooks run at once.
 */
export function repeatKey(text: string): { key: string; ms: number } | undefined {
  try {
    const line = JSON.parse(text) as Partial<SpoolLine>;
    const ms = typeof line.received_at === "string" ? Date.parse(line.received_at) : Number.NaN;
    const payload = line.payload;
    if (Number.isNaN(ms) || typeof payload !== "object" || payload === null) return undefined;
    const p = payload as Record<string, unknown>;
    const session = textOf(p.session_id) ?? textOf(p.conversation_id) ?? "";
    const event = textOf(p.hook_event_name) ?? textOf(p.type) ?? "";
    const call = textOf(p.tool_use_id) ?? textOf(p.call_id);
    if (call) return { key: `call\n${line.agent}\n${session}\n${event}\n${call}`, ms };
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    return { key: `payload\n${line.agent}\n${hash}`, ms };
  } catch {
    return undefined;
  }
}

/** Whether a line repeats a hook call already read, remembering it when it does not. */
function repeated(text: string, seen: Map<string, number>): boolean {
  const found = repeatKey(text);
  if (!found) return false;
  const before = seen.get(found.key);
  if (before !== undefined && Math.abs(found.ms - before) <= REPEAT_MS) {
    return true;
  }
  seen.set(found.key, found.ms);
  return false;
}

function forgetOld(seen: Map<string, number>, now: Date): void {
  if (seen.size <= SEEN_MAX) return;
  for (const [key, ms] of seen) if (now.getTime() - ms > SEEN_KEEP_MS) seen.delete(key);
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
    repeated: 0,
    removed: 0,
  };
  if (!dir) return report;
  const seen = options.seen ?? new Map<string, number>();
  const now = options.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const ctx: SourceContext = { person: options.person, logPrompts: options.logPrompts };
  const names = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => SPOOL_FILE_PATTERN.test(name))
    .sort();

  const pending = new Map<string, Pending>();
  let requests = 0;
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
      if (repeated(text, seen)) {
        report.repeated += 1;
        continue;
      }
      const mapped = mapLine(text, ctx, options.exceptionsOnly, options.repoOf);
      if (!mapped) {
        report.malformed += 1;
        continue;
      }
      if (mapped.mcp) requests += 1;
      for (const event of mapped.events) pending.set(event.id, { event, line: `${name}:${n}` });
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
  forgetOld(seen, now);
  if (requests > 0) options.onRequests?.();

  for (const { path, end, settled } of read) {
    if (options.exceptionsOnly) continue;
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
  options: Pick<DrainOptions, "person" | "logPrompts" | "repoOf" | "onRequests">,
  onBatch: (accepted: number) => void,
  pollMs = 1000,
): { close(): Promise<void> } {
  const offsets = new Map<string, number>();
  const seen = new Map<string, number>();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  const tick = async (): Promise<void> => {
    try {
      const report = await drainSpool(writer, dir, { ...options, offsets, seen });
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

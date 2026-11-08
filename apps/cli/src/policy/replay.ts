import { readFileSync } from "node:fs";
import type { Ledger } from "@selfhost/ledger";
import {
  mcpServerOf,
  normalizePath,
  type PolicyHit,
  type ToolCall,
  toolCallFromEvent,
} from "@selfhost/policy";
import {
  AGENT_VENDORS,
  type AgentVendor,
  type DecisionMode,
  type LedgerEvent,
  type PolicyDecision,
  type ResolvedSelfhostConfig,
} from "@selfhost/schema";
import { plural, table } from "../format.js";
import { checkCall, decide, describeDecision } from "./decide.js";

/** One recorded call to replay, with where it came from when it is a ledger event. */
export interface RecordedCall {
  call: ToolCall;
  ts?: string;
  eventId?: string;
}

export interface ReplayResult {
  ts: string | null;
  event_id: string | null;
  call: ToolCall;
  decision: PolicyDecision;
  mode: DecisionMode | null;
  rules: string[];
  hits: PolicyHit[];
}

/** `selfhost policy test --replay <file> --json` and `--from-ledger --json`. */
export interface PolicyReplayReport {
  schema: "selfhost.policy_replay/v1";
  config: string;
  team: string | null;
  source:
    | { kind: "file"; path: string }
    | { kind: "ledger"; ledger: string; repo: string; since: string | null };
  calls: number;
  /** File entries that are not tool calls, or ledger tool calls outside the repository. */
  skipped: number;
  decisions: { decision: PolicyDecision; mode: DecisionMode | null; calls: number }[];
  rules: { rule_id: string; calls: number }[];
  /** Every replayed call, in input order (the ledger's: newest first). */
  results: ReplayResult[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function optionalString(entry: Record<string, unknown>, key: string, where: string) {
  const value = entry[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${where}: ${key} must be a string`);
  return value;
}

/** A tool call written by hand, in the fields `selfhost policy test --tool` takes. */
function plainCall(entry: Record<string, unknown>, where: string): ToolCall {
  const tool = optionalString(entry, "tool", where);
  if (!tool) throw new Error(`${where}: expected a tool call with a tool name, or a ledger event`);
  const agent = optionalString(entry, "agent", where);
  if (agent !== undefined && !(AGENT_VENDORS as readonly string[]).includes(agent)) {
    throw new Error(`${where}: agent must be one of ${AGENT_VENDORS.join(", ")}`);
  }
  const command = optionalString(entry, "command", where);
  const path = optionalString(entry, "path", where);
  const url = optionalString(entry, "url", where);
  const model = optionalString(entry, "model", where);
  const mcpServer = mcpServerOf(tool);
  return {
    ...(agent !== undefined ? { agent: agent as AgentVendor } : {}),
    tool,
    ...(command !== undefined ? { command } : {}),
    ...(path !== undefined ? { path: normalizePath(path) } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(mcpServer !== undefined ? { mcpServer } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

/**
 * Reads recorded calls from a JSON array or JSON Lines file. Each entry is a tool call
 * (`{ "tool": "Bash", "command": "..." }`) or a ledger event; events other than tool.called
 * are skipped.
 */
export function readRecordedCalls(path: string): { calls: RecordedCall[]; skipped: number } {
  const text = readFileSync(path, "utf8");
  let entries: unknown[];
  const trimmed = text.trimStart();
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(text);
    entries = Array.isArray(parsed) ? parsed : [parsed];
  } else {
    entries = text
      .split(/\r?\n/)
      .map((line, index) => ({ line: line.trim(), index }))
      .filter(({ line }) => line !== "")
      .map(({ line, index }) => {
        try {
          return JSON.parse(line) as unknown;
        } catch (error) {
          throw new Error(`${path}:${index + 1}: ${(error as Error).message}`);
        }
      });
  }
  const calls: RecordedCall[] = [];
  let skipped = 0;
  entries.forEach((entry, index) => {
    const where = `${path}: entry ${index + 1}`;
    if (!isObject(entry)) throw new Error(`${where}: expected an object`);
    if (typeof entry.kind !== "string") {
      calls.push({ call: plainCall(entry, where) });
      return;
    }
    const event = entry as unknown as LedgerEvent;
    const call = toolCallFromEvent(event);
    if (!call) {
      skipped += 1;
      return;
    }
    calls.push({
      call,
      ...(typeof event.ts === "string" ? { ts: event.ts } : {}),
      ...(typeof event.id === "string" ? { eventId: event.id } : {}),
    });
  });
  return { calls, skipped };
}

const PAGE = 500;

/**
 * The newest tool.called events in the ledger that belong to the repository, at most `limit`,
 * newest first. Like policy observe, a call counts when its session started inside the
 * repository or it touched a file there.
 */
export async function recentLedgerCalls(
  ledger: Pick<Ledger, "query">,
  options: { repoRoot: string; since?: Date; limit: number },
): Promise<{ calls: RecordedCall[]; skipped: number }> {
  const calls: RecordedCall[] = [];
  const cwds = new Map<string, string | undefined>();
  let skipped = 0;
  let cursor: string | undefined;
  do {
    const page = await ledger.query({
      kind: "tool.called",
      from: options.since?.toISOString(),
      limit: PAGE,
      cursor,
    });
    for (const event of page.events) {
      const session = event.session_id;
      if (session !== undefined && !cwds.has(session)) {
        const started = await ledger.query({ kind: "session.started", session, limit: 1 });
        const cwd = started.events[0]?.data?.cwd;
        cwds.set(session, typeof cwd === "string" && cwd !== "" ? cwd : undefined);
      }
      const cwd = session === undefined ? undefined : cwds.get(session);
      const call = toolCallFromEvent(event, options.repoRoot, cwd);
      if (!call) {
        skipped += 1;
        continue;
      }
      calls.push({ call, ts: event.ts, eventId: event.id });
      if (calls.length >= options.limit) return { calls, skipped };
    }
    cursor = page.nextCursor;
  } while (cursor);
  return { calls, skipped };
}

/** Runs each recorded call through the policy check and counts decisions and rules. */
export async function replayCalls(
  config: ResolvedSelfhostConfig,
  recorded: readonly RecordedCall[],
  opts: { team?: string },
): Promise<Pick<PolicyReplayReport, "calls" | "decisions" | "rules" | "results">> {
  const results: ReplayResult[] = [];
  for (const { call, ts, eventId } of recorded) {
    const hits = await checkCall(config, call, opts);
    const { decision, mode, rules } = decide(hits);
    results.push({ ts: ts ?? null, event_id: eventId ?? null, call, decision, mode, rules, hits });
  }
  const decisions = new Map<string, PolicyReplayReport["decisions"][number]>();
  const rules = new Map<string, number>();
  for (const result of results) {
    const key = describeDecision(result);
    const entry = decisions.get(key) ?? { decision: result.decision, mode: result.mode, calls: 0 };
    entry.calls += 1;
    decisions.set(key, entry);
    for (const rule of result.rules) rules.set(rule, (rules.get(rule) ?? 0) + 1);
  }
  const order = (d: { decision: PolicyDecision; mode: DecisionMode | null }) =>
    ["block", "ask", "allow"].indexOf(d.decision) * 2 + (d.mode === "observe" ? 1 : 0);
  return {
    calls: results.length,
    decisions: [...decisions.values()].sort((a, b) => order(a) - order(b)),
    rules: [...rules.entries()]
      .map(([rule_id, calls]) => ({ rule_id, calls }))
      .sort((a, b) => b.calls - a.calls || (a.rule_id < b.rule_id ? -1 : 1)),
    results,
  };
}

const target = (call: ToolCall) => call.command ?? call.path ?? call.url ?? "";

export function printReplay(
  report: PolicyReplayReport,
  from: string,
  write: (line: string) => void,
) {
  const skipped = report.skipped > 0 ? ` (${report.skipped} skipped)` : "";
  write(`Replayed ${plural(report.calls, "tool call")} from ${from}${skipped}.`);
  if (report.calls === 0) return;
  table(
    report.decisions.map((entry) => [`  ${describeDecision(entry)}`, String(entry.calls)]),
    write,
    1,
  );
  if (report.rules.length === 0) {
    write("No rule fires on any of them.");
    return;
  }
  write("Rules that fire:");
  table(
    report.rules.map((rule) => [`  ${rule.rule_id}`, plural(rule.calls, "call")]),
    write,
    1,
  );
  write("Calls a rule fires on:");
  table(
    report.results
      .filter((result) => result.rules.length > 0)
      .map((result) => [
        `  ${result.ts ? result.ts.slice(0, 16).replace("T", " ") : "-"}`,
        describeDecision(result),
        result.rules.join(","),
        result.call.tool,
        target(result.call).slice(0, 100),
      ]),
    write,
  );
}

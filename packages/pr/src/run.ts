import { realpathSync } from "node:fs";
import { sep } from "node:path";
import type { CommitRecord, SessionHint } from "@selfhost/attribution";
import type { EventFilter, Ledger } from "@selfhost/ledger";
import { type ToolCall, toolCallFromEvent } from "@selfhost/policy";
import { AGENT_VENDORS, type AgentVendor, type LedgerEvent } from "@selfhost/schema";
import { compare } from "./dependencies.js";
import type { Run, RunGuardrail } from "./types.js";

const PAGE = 1000;

/** Tools that write or patch files, across claude_code and codex. */
const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
]);

/** Every event matching the filter, newest first, a page at a time. */
export async function* ledgerEvents(
  ledger: Pick<Ledger, "query">,
  filter: EventFilter,
): AsyncGenerator<LedgerEvent> {
  let cursor: string | undefined;
  do {
    const page = await ledger.query({ ...filter, limit: PAGE, cursor });
    yield* page.events;
    cursor = page.nextCursor;
  } while (cursor);
}

function isVendor(value: unknown): value is AgentVendor {
  return typeof value === "string" && (AGENT_VENDORS as readonly string[]).includes(value);
}

/** Working folder of each session, from its session.started event. */
export async function sessionCwd(
  ledger: Pick<Ledger, "query">,
  session: string,
  known: Map<string, string | undefined>,
): Promise<string | undefined> {
  if (known.has(session)) return known.get(session);
  const { events } = await ledger.query({ kind: "session.started", session, limit: 1 });
  const cwd = events[0]?.data?.cwd;
  const value = typeof cwd === "string" && cwd !== "" ? cwd : undefined;
  known.set(session, value);
  return value;
}

/**
 * Sessions that edited files between `from` and `to`, as readCommits matches them to commits by
 * file and time.
 */
export async function sessionHints(
  ledger: Pick<Ledger, "query">,
  from: Date,
  to: Date,
  cwds: Map<string, string | undefined>,
): Promise<SessionHint[]> {
  const sessions = new Map<string, SessionHint>();
  for await (const event of ledgerEvents(ledger, {
    kind: "tool.called",
    from: from.toISOString(),
    to: to.toISOString(),
  })) {
    if (!event.session_id || !isVendor(event.agent?.vendor)) continue;
    let hint = sessions.get(event.session_id);
    if (!hint) {
      hint = {
        sessionId: event.session_id,
        vendor: event.agent.vendor,
        ...(event.model ? { model: event.model } : {}),
        start: event.ts,
        end: event.ts,
        files: [],
      };
      sessions.set(event.session_id, hint);
    }
    if (event.ts < hint.start) hint.start = event.ts;
    if (event.ts > hint.end) hint.end = event.ts;
    if (event.tool && EDIT_TOOLS.has(event.tool.name) && event.target?.type === "file") {
      hint.files.push(event.target.value);
    }
  }
  const hints: SessionHint[] = [];
  for (const hint of sessions.values()) {
    const cwd = await sessionCwd(ledger, hint.sessionId, cwds);
    if (cwd && hint.files.length > 0) hints.push({ ...hint, cwd });
  }
  return hints;
}

const shaMatches = (a: string, b: string) => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
};

/**
 * Block and ask verdicts from a run's policy.evaluated events, once per tool call and rule. A
 * policy file that changed records the same hit again under a new id; the first one in `events`
 * is kept.
 */
export function runGuardrails(events: Iterable<LedgerEvent>): RunGuardrail[] {
  const guardrails = new Map<string, RunGuardrail>();
  for (const event of events) {
    if (event.kind !== "policy.evaluated") continue;
    const decision = event.decision;
    if (!decision?.rule_id || (decision.verdict !== "block" && decision.verdict !== "ask")) {
      continue;
    }
    const toolEvent = event.data?.tool_event_id;
    const key = `${typeof toolEvent === "string" ? toolEvent : event.id}\n${decision.rule_id}`;
    if (guardrails.has(key)) continue;
    guardrails.set(key, {
      rule_id: decision.rule_id,
      verdict: decision.verdict,
      mode: decision.mode === "enforce" ? "enforce" : "observe",
      // Paths count through the diff only, as in the risk score.
      irreversible: event.data?.irreversible === true && event.target?.type !== "file",
      event,
    });
  }
  return [...guardrails.values()];
}

/**
 * The repository root spelled the way the session spelled its folder, so a session that ran in
 * /tmp/repo still matches a root git reports as /private/tmp/repo.
 */
function rootAsSeenFrom(root: string, cwd: string | undefined): string {
  if (cwd === undefined) return root;
  let real: string;
  try {
    real = realpathSync(cwd);
  } catch {
    return root;
  }
  if (real === cwd || !(real === root || real.startsWith(`${root}${sep}`))) return root;
  const inside = real.slice(root.length);
  return cwd.endsWith(inside) ? cwd.slice(0, cwd.length - inside.length) : root;
}

/**
 * The run behind a change: sessions whose commits are in it (commit.created events, or the
 * sessions readCommits matched by session link, file and time), with every event they recorded,
 * their tool calls and the guardrail hits on them. Undefined when no session made the commits.
 */
export async function readRun(
  ledger: Pick<Ledger, "query">,
  root: string,
  commits: string[],
  matched: CommitRecord[],
  window: { from: Date; to: Date },
  cwds: Map<string, string | undefined>,
): Promise<Run | undefined> {
  const sessions = new Set(
    matched.flatMap((commit) => (commit.sessionId ? [commit.sessionId] : [])),
  );
  for await (const event of ledgerEvents(ledger, {
    kind: "commit.created",
    from: window.from.toISOString(),
    to: window.to.toISOString(),
  })) {
    const sha = event.links?.commit_sha;
    if (event.session_id && sha && commits.some((c) => shaMatches(c, sha))) {
      sessions.add(event.session_id);
    }
  }
  if (sessions.size === 0) return undefined;
  const ids = [...sessions].sort(compare);
  const events: LedgerEvent[] = [];
  const toolCalls: ToolCall[] = [];
  // Newest first, as the ledger returns them, so a repeated guardrail hit keeps its latest record.
  const newestFirst: LedgerEvent[] = [];
  for (const session of ids) {
    const cwd = await sessionCwd(ledger, session, cwds);
    const own: LedgerEvent[] = [];
    for await (const event of ledgerEvents(ledger, { session })) own.push(event);
    own.sort((a, b) => compare(a.ts, b.ts) || compare(a.id, b.id));
    for (const event of own) {
      // Calls outside the repository count too: an outside effect rarely touches it.
      const call =
        toolCallFromEvent(event, rootAsSeenFrom(root, cwd), cwd) ?? toolCallFromEvent(event);
      if (call) toolCalls.push(call);
    }
    events.push(...own);
    newestFirst.push(...[...own].reverse());
  }
  events.sort((a, b) => compare(a.ts, b.ts) || compare(a.id, b.id));
  return { sessions: ids, events, toolCalls, guardrails: runGuardrails(newestFirst) };
}

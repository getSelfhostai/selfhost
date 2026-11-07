import type { LedgerEvent } from "@selfhost/schema";
import { dimensionValue } from "@selfhost/spend";
import type { AgentVendor, SessionHint } from "./attribution.js";

/** Tools that write or patch files, across Claude Code and Codex. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
]);

/** One cost.recorded event, cut down to what the scan needs. */
export interface CostRecord {
  id: string;
  ts: string;
  model?: string;
  requestType: string;
  usd: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Input, cache read and cache write tokens: the context sent with the request. */
  context: number;
}

export interface ToolCall {
  ts: string;
  name: string;
  /** Tool name plus its input summary, compared to spot repeats. Never written out. */
  key: string;
}

export interface SessionStats {
  vendor: AgentVendor;
  sessionId: string;
  cwd?: string;
  start: string;
  end: string;
  /** Oldest first. */
  costs: CostRecord[];
  /** Oldest first. */
  tools: ToolCall[];
  /** Files the session wrote or patched, sorted. */
  files: string[];
  /** Commits the session's own git calls reported. */
  commits: number;
  usd: number;
  tokens: number;
  model?: string;
}

interface Draft {
  vendor: AgentVendor;
  sessionId: string;
  cwd?: string;
  start: string;
  end: string;
  costs: CostRecord[];
  tools: ToolCall[];
  files: Set<string>;
  commits: number;
  toolModel?: string;
}

const byTs = <T extends { ts: string }>(a: T, b: T) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);

function costRecord(event: LedgerEvent): CostRecord | undefined {
  const cost = event.cost;
  if (!cost) return undefined;
  return {
    id: event.id,
    ts: event.ts,
    model: event.model,
    requestType: dimensionValue(event, "request_type"),
    usd: cost.usd,
    input: cost.input_tokens,
    output: cost.output_tokens,
    cacheRead: cost.cache_read_tokens,
    cacheWrite: cost.cache_write_tokens,
    context: cost.input_tokens + cost.cache_read_tokens + cost.cache_write_tokens,
  };
}

/**
 * The model that answered most of the session's main requests (then any request), with ties
 * going to the one that cost more, then by name.
 */
function mainModel(costs: CostRecord[]): string | undefined {
  const main = costs.filter((cost) => cost.requestType === "main" && cost.model);
  const pool = main.length > 0 ? main : costs.filter((cost) => cost.model);
  const counts = new Map<string, { requests: number; usd: number }>();
  for (const cost of pool) {
    const model = cost.model as string;
    const entry = counts.get(model) ?? { requests: 0, usd: 0 };
    entry.requests++;
    entry.usd += cost.usd;
    counts.set(model, entry);
  }
  return [...counts.entries()].sort(
    ([a, x], [b, y]) => y.requests - x.requests || y.usd - x.usd || a.localeCompare(b),
  )[0]?.[0];
}

/** Groups events by agent vendor and session id. Events without either are left out. */
export function summarizeSessions(events: Iterable<LedgerEvent>): SessionStats[] {
  const drafts = new Map<string, Draft>();
  for (const event of events) {
    const vendor = event.agent?.vendor;
    const sessionId = event.session_id;
    if (!vendor || !sessionId) continue;
    const key = `${vendor}\n${sessionId}`;
    let draft = drafts.get(key);
    if (!draft) {
      draft = {
        vendor,
        sessionId,
        start: event.ts,
        end: event.ts,
        costs: [],
        tools: [],
        files: new Set(),
        commits: 0,
      };
      drafts.set(key, draft);
    }
    if (event.ts < draft.start) draft.start = event.ts;
    if (event.ts > draft.end) draft.end = event.ts;
    switch (event.kind) {
      case "session.started": {
        const cwd = event.data?.cwd;
        if (typeof cwd === "string" && cwd !== "") draft.cwd ??= cwd;
        break;
      }
      case "cost.recorded": {
        const record = costRecord(event);
        if (record) draft.costs.push(record);
        break;
      }
      case "tool.called": {
        const name = event.tool?.name;
        if (!name) break;
        draft.tools.push({
          ts: event.ts,
          name,
          key: `${name}\n${event.tool?.input_summary ?? ""}`,
        });
        draft.toolModel ??= event.model;
        if (EDIT_TOOLS.has(name) && event.target?.type === "file")
          draft.files.add(event.target.value);
        break;
      }
      case "commit.created":
        draft.commits++;
        break;
    }
  }
  return [...drafts.values()]
    .map((draft): SessionStats => {
      const costs = draft.costs.sort(byTs);
      let usd = 0;
      let tokens = 0;
      for (const cost of costs) {
        usd += cost.usd;
        tokens += cost.context + cost.output;
      }
      const model = mainModel(costs) ?? draft.toolModel;
      return {
        vendor: draft.vendor,
        sessionId: draft.sessionId,
        ...(draft.cwd ? { cwd: draft.cwd } : {}),
        start: draft.start,
        end: draft.end,
        costs,
        tools: draft.tools.sort(byTs),
        files: [...draft.files].sort(),
        commits: draft.commits,
        usd,
        tokens,
        ...(model ? { model } : {}),
      };
    })
    .sort(
      (a, b) => byTs({ ts: a.start }, { ts: b.start }) || a.sessionId.localeCompare(b.sessionId),
    );
}

/**
 * What the git and GitHub join needs from each session: its window (first to last event), vendor,
 * main model, cwd, and the files its tool calls wrote or patched.
 */
export function sessionHintsFromEvents(events: Iterable<LedgerEvent>): SessionHint[] {
  return summarizeSessions(events).map((session) => ({
    sessionId: session.sessionId,
    vendor: session.vendor,
    ...(session.model ? { model: session.model } : {}),
    start: session.start,
    end: session.end,
    ...(session.cwd ? { cwd: session.cwd } : {}),
    files: session.files,
  }));
}

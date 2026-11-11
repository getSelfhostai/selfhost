import { EVENT_KINDS, handoffOf, type LedgerEvent, type ReviewItem } from "@selfhost/schema";
import { hitRate } from "@selfhost/spend";
import { runViewUrl } from "@selfhost/traces";
import { tokens, usd } from "../format.js";

/**
 * What `selfhost tail` prints for one event: the fields the run view shows, no more. Prompt
 * text never appears (the run view shows "Prompt"), and the tool input is the stored,
 * redacted input_summary the run view shows. One JSON object per line with --json.
 */
export interface TailLine {
  schema: "selfhost.tail_line/v1";
  /** When it happened. */
  ts: string;
  /** The event kind, or review.opened for an item that appeared on the review list. */
  kind: string;
  /** The ledger event, or the review item for review.opened. */
  id: string;
  /**
   * actor.id: the person, or the system that acted. An agent's event read from a log shows the
   * person of its session when that is known.
   */
  who: string;
  /** The person the event belongs to: its actor, who sent it, or its session's person. */
  person: string | null;
  agent: string | null;
  model: string | null;
  repo: string | null;
  session_id: string | null;
  /** The background run the event belongs to. */
  run_id: string | null;
  tool: string | null;
  /** tool.input_summary or target.value, redacted as stored. */
  input: string | null;
  /** The rule decision: allow, block or ask from a rule; approve, deny ... from a person. */
  verdict: string | null;
  rule_id: string | null;
  mode: string | null;
  usd: number | null;
  tokens: number | null;
  /** The session's prompt cache hit rate so far, on cost lines; null when unknown. */
  cache_hit_rate: number | null;
  /** An alert's message or a review item's title. */
  message: string | null;
  /** The run in the console, else null for events with no session. */
  run_url: string | null;
}

export const REVIEW_OPENED = "review.opened";

/** What --kind takes: event kinds, their first part (tool, policy ...), and review. */
export const TAIL_KINDS = [
  ...EVENT_KINDS,
  ...new Set(EVENT_KINDS.map((kind) => kind.split(".")[0] as string)),
  "review",
];

export interface TailFilter {
  kinds?: string[];
  person?: string;
  agent?: string;
  repo?: string;
  session?: string;
  run?: string;
}

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

/** Running cache hit rate per session, from the cost lines the tail has seen. */
export class SessionCache {
  private readonly sessions = new Map<string, { read: number; fresh: number; known: boolean }>();

  add(event: LedgerEvent): number | null {
    if (event.kind !== "cost.recorded" || !event.cost) return null;
    const key = event.session_id ? `${event.agent?.vendor ?? ""}\n${event.session_id}` : event.id;
    const totals = this.sessions.get(key) ?? { read: 0, fresh: 0, known: false };
    totals.read += event.cost.cache_read_tokens;
    totals.fresh += event.cost.input_tokens + event.cost.cache_write_tokens;
    totals.known ||= event.cost.cache_read_tokens > 0 || event.cost.cache_write_tokens > 0;
    this.sessions.set(key, totals);
    return totals.known ? hitRate(totals.read, totals.fresh) : null;
  }
}

export function lineOf(
  event: LedgerEvent,
  options: {
    console: string;
    repo?: string | null;
    cacheHitRate?: number | null;
    /** The person of an event whose actor is not one: who sent it, or its session's person. */
    person?: string | null;
  },
): TailLine {
  const cost = event.cost;
  const decision = event.decision;
  const person = event.actor.kind === "person" ? event.actor.id : (options.person ?? null);
  return {
    schema: "selfhost.tail_line/v1",
    ts: event.ts,
    kind: event.kind,
    id: event.id,
    who: event.actor.kind === "agent" && person ? person : event.actor.id,
    person,
    agent: event.agent?.vendor ?? null,
    model: event.model ?? null,
    repo: event.repo ?? options.repo ?? null,
    session_id: event.session_id ?? null,
    run_id: event.run_id ?? null,
    tool: event.tool?.name ?? null,
    input:
      event.kind === "prompt.submitted"
        ? null
        : (event.tool?.input_summary ?? event.target?.value ?? null),
    verdict: decision?.verdict ?? null,
    rule_id: decision?.rule_id ?? null,
    mode: decision?.mode ?? null,
    usd: cost ? cost.usd : null,
    tokens: cost
      ? cost.input_tokens + cost.output_tokens + cost.cache_read_tokens + cost.cache_write_tokens
      : null,
    cache_hit_rate: options.cacheHitRate ?? null,
    message: event.kind === "alert.raised" ? text(event.data?.message) : runMessage(event),
    run_url: event.session_id ? runViewUrl(options.console, event.session_id) : null,
  };
}

const field = (value: unknown, key: string) =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;

/** What a background run's event says, in one line: its state, output, health or gate verdict. */
function runMessage(event: LedgerEvent): string | null {
  const data = event.data ?? {};
  switch (event.kind) {
    case "run.triggered": {
      const trigger = data.trigger;
      const from = `${text(field(trigger, "source")) ?? "?"} by ${text(field(trigger, "sender")) ?? "?"}`;
      return field(trigger, "accepted") === true
        ? `accepted from ${from}`
        : `refused from ${from}: ${text(field(trigger, "reason")) ?? ""}`;
    }
    case "run.updated": {
      const run = data.background_run;
      const reason = text(field(run, "reason"));
      return `${text(field(run, "state")) ?? "?"}${reason ? `: ${reason}` : ""}`;
    }
    case "run.health":
      return text(field(data.health, "line"));
    case "run.gate":
      return text(field(data.gate, "summary"));
    case "run.output": {
      const lines = field(data.output, "lines");
      return Array.isArray(lines) ? lines.filter((l) => typeof l === "string").join(" | ") : null;
    }
    case "run.handed_off": {
      const handoff = handoffOf(event);
      return handoff ? `handed from ${handoff.previous_owner} to ${handoff.owner}` : null;
    }
    default:
      return null;
  }
}

export function reviewLine(item: ReviewItem, console: string): TailLine {
  return {
    schema: "selfhost.tail_line/v1",
    ts: item.created_at,
    kind: REVIEW_OPENED,
    id: item.id,
    who: item.requested_by ?? item.owners[0] ?? "selfhost",
    person: item.requested_by ?? null,
    agent: item.agent?.vendor ?? null,
    model: null,
    repo: item.repo ?? null,
    session_id: item.session_id ?? null,
    run_id: null,
    tool: null,
    input: null,
    verdict: item.blocking ? "waiting" : null,
    rule_id: item.why?.rule_id ?? null,
    mode: null,
    usd: null,
    tokens: null,
    cache_hit_rate: null,
    message: item.title,
    run_url:
      item.run_url ?? (item.session_id ? runViewUrl(console, item.session_id) : (item.url ?? null)),
  };
}

export function matches(line: TailLine, filter: TailFilter): boolean {
  if (filter.kinds && filter.kinds.length > 0) {
    const group = line.kind.split(".")[0] ?? "";
    if (!filter.kinds.includes(line.kind) && !filter.kinds.includes(group)) return false;
  }
  if (filter.person !== undefined && line.person !== filter.person && line.who !== filter.person) {
    return false;
  }
  if (filter.agent !== undefined && line.agent !== filter.agent) return false;
  if (filter.session !== undefined && line.session_id !== filter.session) return false;
  if (filter.run !== undefined && line.run_id !== filter.run) return false;
  if (filter.repo !== undefined && line.repo?.toLowerCase() !== filter.repo.toLowerCase()) {
    return false;
  }
  return true;
}

const clip = (value: string, max = 80) =>
  value.length > max ? `${value.slice(0, max - 3)}...` : value;
const pct = (rate: number) => `${Math.round(rate * 100)}%`;

function rule(line: TailLine): string {
  const observe = line.mode === "observe";
  const what =
    line.verdict === "block"
      ? observe
        ? "would block"
        : "BLOCKED"
      : line.verdict === "ask"
        ? observe
          ? "would ask"
          : "ASKED"
        : (line.verdict ?? "evaluated");
  return `${what} ${line.rule_id ?? "rule"}`;
}

/** What happened, in a few words. */
function what(line: TailLine): string {
  const input = line.input ? `: ${clip(line.input)}` : "";
  switch (line.kind) {
    case "session.started":
      return "session started";
    case "session.ended":
      return "session ended";
    case "prompt.submitted":
      return "prompt";
    case "tool.called":
      return `tool ${line.tool ?? "unknown"}${input}`;
    case "tool.result":
      return `result ${line.tool ?? "unknown"}`;
    case "policy.evaluated":
      return `${rule(line)}${line.tool ? ` on ${line.tool}` : ""}${input}`;
    case "approval.requested":
      return `asks a person${line.tool ? ` about ${line.tool}` : ""}${input}`;
    case "decision.recorded":
      return `decision ${line.verdict ?? ""}${line.rule_id ? ` on ${line.rule_id}` : ""}`.trimEnd();
    case "cost.recorded": {
      const cache =
        line.cache_hit_rate === null ? "cache unknown" : `cache ${pct(line.cache_hit_rate)}`;
      return `cost ${usd(line.usd ?? 0)}${line.model ? ` ${line.model}` : ""}, ${tokens(line.tokens ?? 0)} tokens, ${cache}`;
    }
    case "alert.raised":
      return `ALERT ${clip(line.message ?? "", 160)}`;
    case "pr.opened":
    case "pr.merged":
    case "pr.closed":
      return `pr ${line.kind.slice(3)}${input}`;
    case "commit.created":
      return "commit";
    case "run.triggered":
    case "run.updated":
    case "run.health":
    case "run.gate":
    case "run.output":
      return `${line.kind.slice(4)} ${clip(line.message ?? "", 400)}`;
    case REVIEW_OPENED:
      return `review item opened${line.verdict === "waiting" ? ", agent waiting" : ""}: ${clip(line.message ?? "", 120)}`;
    default:
      return line.kind;
  }
}

/** HH:MM:SS of a timestamp in a time zone. */
export type Clock = ((iso: string) => string) & { zone: string };

/**
 * The clock text lines use: the person's own time zone (`timeZone`, else this machine's),
 * falling back to the machine's for a zone name Intl does not know.
 */
export function clockIn(timeZone?: string): Clock {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return clockIn(undefined);
  }
  const clock = (iso: string) => {
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? iso.slice(11, 19) : format.format(at);
  };
  return Object.assign(clock, { zone: format.resolvedOptions().timeZone });
}

/** "UTC", or "local time (Asia/Kolkata)": what the times of the lines are in. */
export const zoneText = (clock: Clock): string =>
  clock.zone === "UTC" || clock.zone === "Etc/UTC" ? "UTC" : `local time (${clock.zone})`;

/** One line of text: time, who, agent, what happened and the link to its run. */
export function formatLine(line: TailLine, clock: Clock = clockIn()): string {
  const parts = [clock(line.ts), line.who, line.agent ?? "-", what(line)];
  if (line.run_url) parts.push(line.run_url);
  return parts.join("  ");
}

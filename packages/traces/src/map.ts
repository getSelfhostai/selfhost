import {
  type LedgerEvent,
  type RedactionPattern,
  redactEvent,
  type TracerTool,
} from "@selfhost/schema";
import { spanIdOf, traceIdOf } from "./links.js";
import { RUN_IDLE_MS, runCosts, runEnd, summarizeRun, tokensOf } from "./summary.js";

/**
 * One span to send, in plain data. otlp.ts turns these into OpenTelemetry spans; tests and
 * `selfhost traces export --dry-run` read them as they are.
 */
export interface TraceSpan {
  traceId: string;
  spanId: string;
  /** Absent on the run's root span. */
  parentSpanId?: string;
  name: string;
  kind: "internal" | "client";
  start: string;
  end: string;
  attributes: Record<string, AttributeValue>;
  /** Set when the operation failed, for example a tool call that returned an error. */
  error?: { type: string; message?: string };
  /** The ledger events behind the span. */
  eventIds: string[];
}

export type AttributeValue = string | number | boolean | string[];

export interface MapOptions {
  /** `[ledger] log_prompts` of the run's team: only then is prompt text sent. */
  logPrompts: boolean;
  /** `[[redaction]]` of the run's team, applied again on top of what was masked at append. */
  patterns?: readonly RedactionPattern[];
  /** Adds the attributes this tracer reads best, next to the GenAI conventions. */
  tool?: TracerTool;
  /** Send the root span: once, when the run is over. */
  root: boolean;
  /** Only events with these ids become spans (they still pair with the others). Default: all. */
  fresh?: ReadonlySet<string>;
  now: Date;
  idleMs?: number;
}

/** OpenInference span kinds, which Phoenix shows its tree with. */
type SpanRole = "agent" | "tool" | "llm" | "guardrail" | "event";
const OPENINFERENCE_KIND: Record<SpanRole, string> = {
  agent: "AGENT",
  tool: "TOOL",
  llm: "LLM",
  guardrail: "GUARDRAIL",
  event: "CHAIN",
};
const LANGFUSE_TYPE: Record<SpanRole, string> = {
  agent: "agent",
  tool: "tool",
  llm: "generation",
  guardrail: "guardrail",
  event: "event",
};

/** Which source to keep when several report the same tool calls or prompts of a session. */
const SOURCE_PREFERENCE: Record<string, readonly string[]> = {
  "tool.called": ["hook", "local_log", "otel", "sdk", "gateway", "vendor_api"],
  "prompt.submitted": ["hook", "otel", "local_log", "sdk", "gateway", "vendor_api"],
};

const time = (ts: string) => Date.parse(ts);
const iso = (ms: number) => new Date(ms).toISOString();
const str = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** gen_ai.provider.name from the model id, else from the agent that only talks to one. */
export function providerOf(model: string | undefined, vendor: string | undefined) {
  const id = model?.toLowerCase() ?? "";
  if (id.includes("claude")) return "anthropic";
  if (/^(gpt|o\d|codex|chatgpt)/.test(id) || id.includes("/gpt")) return "openai";
  if (id.includes("gemini")) return "gcp.gemini";
  if (id.includes("mistral") || id.includes("codestral")) return "mistral";
  if (id.includes("deepseek")) return "deepseek";
  if (id.includes("grok")) return "x_ai";
  if (!model && vendor === "claude_code") return "anthropic";
  if (!model && vendor === "codex") return "openai";
  return undefined;
}

function keepOneSource(events: LedgerEvent[]): LedgerEvent[] {
  const chosen = new Map<string, string>();
  const rank = (kind: string, source: string) => {
    const order = SOURCE_PREFERENCE[kind] ?? [];
    const index = order.indexOf(source);
    return index === -1 ? order.length : index;
  };
  for (const event of events) {
    if (!SOURCE_PREFERENCE[event.kind]) continue;
    const current = chosen.get(event.kind);
    if (current === undefined || rank(event.kind, event.source) < rank(event.kind, current)) {
      chosen.set(event.kind, event.source);
    }
  }
  return events.filter((e) => !SOURCE_PREFERENCE[e.kind] || chosen.get(e.kind) === e.source);
}

interface ToolCall {
  called?: LedgerEvent;
  results: LedgerEvent[];
}

/**
 * Pairs tool calls with their results: by tool_use_id when both carry it, else the latest
 * earlier call of the same tool that has no result yet, or whose result came at the same moment
 * (one completion reported by two sources).
 */
function pairTools(calls: LedgerEvent[], results: LedgerEvent[]): ToolCall[] {
  const pairs: ToolCall[] = calls.map((called) => ({ called, results: [] }));
  const byUseId = new Map<string, ToolCall>();
  for (const pair of pairs) {
    const id = str(pair.called?.data?.tool_use_id);
    if (id) byUseId.set(id, pair);
  }
  const orphans: ToolCall[] = [];
  for (const result of results) {
    const id = str(result.data?.tool_use_id);
    let pair = id ? byUseId.get(id) : undefined;
    if (!pair) {
      pair = [...pairs]
        .reverse()
        .find(
          (p) =>
            p.called?.tool?.name === result.tool?.name &&
            time(p.called?.ts ?? "") <= time(result.ts) &&
            (p.results.length === 0 || p.results.some((r) => r.ts === result.ts)),
        );
    }
    if (pair) pair.results.push(result);
    else orphans.push({ results: [result] });
  }
  return [...pairs, ...orphans];
}

/** Longest run input or outcome a tracer is sent. */
const RUN_TEXT_MAX = 500;

const clip = (text: string) =>
  text.length > RUN_TEXT_MAX ? `${text.slice(0, RUN_TEXT_MAX - 3)}...` : text;

/**
 * The root span's input: the run's first prompt, already redacted, when prompts are logged;
 * otherwise only its length, as the ledger keeps it.
 */
function runInput(events: readonly LedgerEvent[]): string | undefined {
  const prompts = events.filter((event) => event.kind === "prompt.submitted");
  const first = prompts[0];
  if (!first) return undefined;
  const more = prompts.length > 1 ? ` (+${prompts.length - 1} more prompts)` : "";
  const text = str(first.data?.prompt);
  if (text) return clip(`${text.replace(/\s+/g, " ").trim()}${more}`);
  const chars = num(first.data?.prompt_chars);
  const size = chars !== undefined ? `: ${chars} characters` : "";
  return `First prompt${size}, text not logged ([ledger] log_prompts is off)${more}.`;
}

/** The root span's output: how the run ended and what it left, from metadata only. */
function runOutcome(
  events: readonly LedgerEvent[],
  summary: { cost_usd: number; tokens: number },
  endedBy: "session_end" | "idle" | undefined,
): string {
  const count = (kind: LedgerEvent["kind"]) => events.filter((e) => e.kind === kind).length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const failed = events.filter(
    (e) => e.kind === "tool.result" && (e.data?.success === false || str(e.data?.error)),
  ).length;
  const blocked = events.filter(
    (e) =>
      e.kind === "policy.evaluated" &&
      e.decision?.verdict === "block" &&
      e.decision.mode !== "observe",
  ).length;
  const prs = new Set(
    events.flatMap((e) => (e.kind === "pr.opened" && e.links?.pr_url ? [e.links.pr_url] : [])),
  );
  const commits = count("commit.created");
  const parts = [
    endedBy === "session_end" ? "Session ended" : endedBy === "idle" ? "Went idle" : "Running",
    `${plural(count("tool.called"), "tool call")}${failed ? ` (${failed} failed)` : ""}`,
    ...(blocked ? [`${blocked} blocked by policy`] : []),
    ...(commits ? [plural(commits, "commit")] : []),
    ...[...prs].map((url) => `PR ${url}`),
    `${summary.tokens} tokens, $${summary.cost_usd.toFixed(4)}`,
  ];
  return clip(`${parts.join(". ")}.`);
}

/**
 * The spans of one run: a root `invoke_agent` span for the session, and under it an
 * `execute_tool` span per tool call, a `chat` span per model request, a guardrail span per
 * policy verdict (under the tool call it judged when known) and a short span for each prompt,
 * approval, decision, commit, pull request and alert. Attributes follow the OpenTelemetry GenAI
 * semantic conventions, plus `selfhost.*` for what they have no name for. Each event is
 * redacted again under the team's current settings first, so nothing goes out that the ledger
 * would not show, and prompt text only with `logPrompts`.
 */
export function runSpans(
  runId: string,
  allEvents: readonly LedgerEvent[],
  options: MapOptions,
): TraceSpan[] {
  const settings = { logPrompts: options.logPrompts, patterns: options.patterns ?? [] };
  const events = keepOneSource(
    allEvents
      .map((event) => redactEvent(event, settings))
      .sort((a, b) => time(a.ts) - time(b.ts) || a.id.localeCompare(b.id)),
  );
  const traceId = traceIdOf(runId);
  const rootId = spanIdOf(runId, "root");
  const isFresh = (event: LedgerEvent | undefined) =>
    event !== undefined && (options.fresh === undefined || options.fresh.has(event.id));
  const summary = summarizeRun(runId, allEvents, {
    now: options.now,
    ...(options.idleMs ? { idleMs: options.idleMs } : {}),
  });
  const vendor = summary.agent?.vendor;
  const agentName = summary.agent?.name ?? vendor ?? "agent";
  const conversation = { "gen_ai.conversation.id": runId, "session.id": runId };

  const spans: TraceSpan[] = [];
  const add = (
    role: SpanRole,
    span: Omit<TraceSpan, "traceId" | "parentSpanId" | "attributes"> & {
      parentSpanId?: string;
      attributes: Record<string, AttributeValue | undefined>;
      input?: string;
      output?: string;
    },
  ) => {
    const { input, output, ...rest } = span;
    const attributes: Record<string, AttributeValue | undefined> = {
      ...span.attributes,
      ...conversation,
      ...(summary.person ? { "user.id": summary.person } : {}),
    };
    if (options.tool === "phoenix") {
      attributes["openinference.span.kind"] = OPENINFERENCE_KIND[role];
      if (input !== undefined) attributes["input.value"] = input;
      if (output !== undefined) attributes["output.value"] = output;
    }
    if (options.tool === "langfuse") {
      attributes["langfuse.observation.type"] = LANGFUSE_TYPE[role];
      if (input !== undefined) attributes["langfuse.observation.input"] = input;
      if (output !== undefined) attributes["langfuse.observation.output"] = output;
    }
    spans.push({
      ...rest,
      traceId,
      ...(span.spanId === rootId ? {} : { parentSpanId: span.parentSpanId ?? rootId }),
      attributes: Object.fromEntries(
        Object.entries(attributes).filter(
          (entry): entry is [string, AttributeValue] => entry[1] !== undefined,
        ),
      ),
    });
  };
  const eventAttributes = (event: LedgerEvent) => ({
    "selfhost.event.id": event.id,
    "selfhost.event.kind": event.kind,
    "selfhost.event.source": event.source,
  });

  if (options.root) {
    const end = runEnd(allEvents, options.now, options.idleMs ?? RUN_IDLE_MS);
    add("agent", {
      spanId: rootId,
      name: `invoke_agent ${agentName}`,
      kind: "internal",
      start: summary.started_at,
      end: end?.at ?? summary.started_at,
      eventIds: [],
      input: runInput(events),
      output: runOutcome(events, summary, end?.by),
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": agentName,
        "gen_ai.provider.name": providerOf(summary.model ?? undefined, vendor),
        "selfhost.run.id": runId,
        "selfhost.run.ended_by": end?.by,
        "selfhost.agent.vendor": vendor,
        "selfhost.agent.version": summary.agent?.version,
        "selfhost.model": summary.model ?? undefined,
        "selfhost.team": summary.team ?? undefined,
        "selfhost.repo": summary.repo ?? undefined,
        "selfhost.cost_usd": summary.cost_usd,
        "selfhost.tokens": summary.tokens,
      },
    });
  }

  const toolSpanIds = new Map<string, string>();
  const calls = events.filter((e) => e.kind === "tool.called");
  for (const pair of pairTools(
    calls,
    events.filter((e) => e.kind === "tool.result"),
  )) {
    const first = pair.called ?? pair.results[0];
    if (!first) continue;
    const spanId = spanIdOf(runId, first.id);
    if (pair.called) toolSpanIds.set(pair.called.id, spanId);
    if (!isFresh(first)) continue;
    const result = pair.results[0];
    const duration = pair.results.map((r) => num(r.data?.duration_ms)).find((d) => d !== undefined);
    const endMs = result ? time(result.ts) : time(first.ts);
    const startMs = pair.called ? time(pair.called.ts) : endMs - (duration ?? 0);
    const failed = pair.results.find((r) => r.data?.success === false || str(r.data?.error));
    const tool = first.tool?.name ?? "unknown";
    const summaryText = pair.called?.tool?.input_summary ?? result?.tool?.input_summary;
    const target = pair.called?.target ?? result?.target;
    add("tool", {
      spanId,
      name: `execute_tool ${tool}`,
      kind: "internal",
      start: iso(startMs),
      end: iso(Math.max(endMs, startMs)),
      eventIds: [...(pair.called ? [pair.called.id] : []), ...pair.results.map((r) => r.id)],
      ...(failed
        ? {
            error: {
              type: "tool_error",
              ...(str(failed.data?.error) ? { message: str(failed.data?.error) } : {}),
            },
          }
        : {}),
      input: summaryText,
      attributes: {
        ...eventAttributes(first),
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": tool,
        "gen_ai.tool.type": tool.startsWith("mcp__") ? "extension" : "function",
        "gen_ai.tool.call.id": str(first.data?.tool_use_id),
        "gen_ai.agent.name": agentName,
        "error.type": failed ? "tool_error" : undefined,
        "selfhost.tool.input_summary": summaryText,
        "selfhost.target.type": target?.type,
        "selfhost.target.value": target?.value,
        "selfhost.tool.finished": pair.results.length > 0,
      },
    });
  }

  for (const event of runCosts(events)) {
    if (!isFresh(event) || !event.cost) continue;
    const cost = event.cost;
    const duration = num(event.data?.duration_ms);
    const endMs = time(event.ts);
    const model = event.model ?? summary.model ?? undefined;
    const input = cost.input_tokens + cost.cache_read_tokens + cost.cache_write_tokens;
    add("llm", {
      spanId: spanIdOf(runId, event.id),
      name: model ? `chat ${model}` : "chat",
      kind: "client",
      start: iso(endMs - (duration ?? 0)),
      end: iso(endMs),
      eventIds: [event.id],
      attributes: {
        ...eventAttributes(event),
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": providerOf(model, event.agent?.vendor ?? vendor),
        "gen_ai.request.model": model,
        "gen_ai.usage.input_tokens": input,
        "gen_ai.usage.output_tokens": cost.output_tokens,
        "gen_ai.usage.cache_read.input_tokens": cost.cache_read_tokens,
        "gen_ai.usage.cache_creation.input_tokens": cost.cache_write_tokens,
        "gen_ai.usage.cost": cost.usd,
        "selfhost.cost.estimated": cost.estimated,
        "selfhost.request_type": str(event.data?.request_type),
        ...(options.tool === "phoenix"
          ? {
              "llm.model_name": model,
              "llm.token_count.prompt": input,
              "llm.token_count.completion": cost.output_tokens,
              "llm.token_count.total": tokensOf(event),
              // Sub-counts of llm.token_count.prompt, so Phoenix prices them at cache rates.
              "llm.token_count.prompt_details.cache_read": cost.cache_read_tokens,
              "llm.token_count.prompt_details.cache_write": cost.cache_write_tokens,
            }
          : {}),
      },
    });
  }

  for (const event of events) {
    if (!isFresh(event)) continue;
    const point = {
      start: event.ts,
      end: event.ts,
      eventIds: [event.id],
      kind: "internal" as const,
    };
    const spanId = spanIdOf(runId, event.id);
    const base = eventAttributes(event);
    switch (event.kind) {
      case "prompt.submitted": {
        const text = options.logPrompts ? str(event.data?.prompt) : undefined;
        const chars = num(event.data?.prompt_chars) ?? text?.length;
        add("event", {
          ...point,
          spanId,
          name: "user_prompt",
          input: text,
          attributes: {
            ...base,
            "selfhost.prompt.chars": chars,
            "gen_ai.input.messages": text
              ? JSON.stringify([{ role: "user", parts: [{ type: "text", content: text }] }])
              : undefined,
          },
        });
        break;
      }
      case "policy.evaluated": {
        const decision = event.decision;
        const judged = str(event.data?.tool_event_id);
        add("guardrail", {
          ...point,
          spanId,
          name: `guardrail ${decision?.rule_id ?? decision?.verdict ?? "rule"}`,
          parentSpanId: (judged && toolSpanIds.get(judged)) || rootId,
          attributes: {
            ...base,
            "gen_ai.tool.name": event.tool?.name,
            "selfhost.policy.verdict": decision?.verdict,
            "selfhost.policy.rule_id": decision?.rule_id,
            "selfhost.policy.mode": decision?.mode,
            "selfhost.policy.reason": decision?.reason,
            "selfhost.policy.commit": decision?.policy_commit,
          },
        });
        break;
      }
      case "decision.recorded":
      case "approval.requested":
      case "commit.created":
      case "pr.opened":
      case "pr.merged":
      case "pr.closed":
      case "alert.raised": {
        const decision = event.decision;
        add(event.kind === "decision.recorded" ? "guardrail" : "event", {
          ...point,
          spanId,
          name: decision ? `${event.kind} ${decision.verdict}` : event.kind,
          attributes: {
            ...base,
            "gen_ai.tool.name": event.tool?.name,
            "selfhost.decision.verdict": decision?.verdict,
            "selfhost.decision.by": decision?.by,
            "selfhost.decision.reason": decision?.reason,
            "selfhost.pr.url": event.links?.pr_url,
            "selfhost.commit.sha": event.links?.commit_sha,
            "selfhost.review_item.id": event.links?.item_id ?? decision?.item_id,
          },
        });
        break;
      }
      default:
        break;
    }
  }
  return spans.sort((a, b) => time(a.start) - time(b.start) || a.spanId.localeCompare(b.spanId));
}

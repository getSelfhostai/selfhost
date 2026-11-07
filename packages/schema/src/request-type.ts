/**
 * Request types for `cost.recorded` events, stored in `data.request_type`. The vocabulary is
 * small and stable so spend can be grouped across agents and sources; the vendor's own label, when
 * it has one, goes in `data.request_source`.
 */
export const REQUEST_TYPES = [
  "main",
  "subagent",
  "compaction",
  "title",
  "status_line",
  "background",
  "retry",
  "unknown",
] as const;

export type RequestType = (typeof REQUEST_TYPES)[number];

/** Request types that are the work itself. The rest is overhead. */
export const WORK_REQUEST_TYPES = ["main", "subagent"] as const satisfies readonly RequestType[];

export function isRequestType(value: unknown): value is RequestType {
  return typeof value === "string" && (REQUEST_TYPES as readonly string[]).includes(value);
}

const CLAUDE_CODE_SOURCES: Record<string, RequestType> = {
  sdk: "main",
  side_question: "main",
  agent: "subagent",
  hook_agent: "subagent",
  verification_agent: "subagent",
  agent_summary: "status_line",
  generate_session_title: "title",
  teleport_generate_title: "title",
  rename_generate_name: "title",
};

/**
 * Request type for a Claude Code query source: `query_source` on OpenTelemetry API events, or
 * `querySource` on the transcript's `api-request` lines. `subagent` says the request came from a
 * named subagent (OpenTelemetry `agent.name` or `agent_id`, a sidechain transcript line).
 * Without a query source the result is `subagent` or undefined, so the caller picks the default.
 *
 * Main thread sources start with `repl_main_thread` (output styles add a suffix), subagents with
 * `agent:`. Anything else that is not a known source is an auxiliary request: the monitoring docs
 * group requests into main, subagent and auxiliary.
 */
export function claudeCodeRequestType(
  querySource: string | undefined,
  opts: { subagent?: boolean } = {},
): RequestType | undefined {
  const source = querySource?.trim();
  if (!source) return opts.subagent ? "subagent" : undefined;
  const known = CLAUDE_CODE_SOURCES[source];
  if (known) return known;
  if (source.startsWith("repl_main_thread")) return "main";
  if (source.startsWith("agent:") || source.startsWith("agent.")) return "subagent";
  if (source.includes("compact")) return "compaction";
  if (source.includes("title")) return "title";
  return opts.subagent ? "subagent" : "background";
}

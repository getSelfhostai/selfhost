import type { EventSource, LedgerEvent } from "@selfhost/schema";

/**
 * Ingest paths in order of preference when more than one reports a session's spend.
 * OpenTelemetry first: it sees every request, including the background ones Claude Code leaves
 * out of its transcripts. Then local logs, hooks, the model gateway and the vendor audit feed,
 * whose request types say less.
 */
export const COST_SOURCE_PREFERENCE: readonly EventSource[] = [
  "otel",
  "local_log",
  "hook",
  "gateway",
  "vendor_api",
];

function rank(source: string): number {
  const index = (COST_SOURCE_PREFERENCE as readonly string[]).indexOf(source);
  return index === -1 ? COST_SOURCE_PREFERENCE.length : index;
}

/**
 * Keeps the cost.recorded events of one source per session (agent vendor and session id), so a
 * session that OpenTelemetry and the local logs both report is counted once. Events without a
 * session id, and events of other kinds, are kept as they are. Order is preserved.
 */
export function oneSourcePerSession(events: Iterable<LedgerEvent>): LedgerEvent[] {
  const list = [...events];
  const chosen = new Map<string, string>();
  const sessionOf = (event: LedgerEvent) =>
    event.kind === "cost.recorded" && event.session_id
      ? `${event.agent?.vendor ?? ""}\n${event.session_id}`
      : undefined;
  for (const event of list) {
    const session = sessionOf(event);
    if (session === undefined) continue;
    const current = chosen.get(session);
    if (
      current === undefined ||
      rank(event.source) < rank(current) ||
      (rank(event.source) === rank(current) && event.source < current)
    ) {
      chosen.set(session, event.source);
    }
  }
  return list.filter((event) => {
    const session = sessionOf(event);
    return session === undefined || chosen.get(session) === event.source;
  });
}

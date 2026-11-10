import type { LedgerWriter } from "@selfhost/importers";
import { databaseOf, type Ledger, LedgerValidationError } from "@selfhost/ledger";
import type { LedgerEvent } from "@selfhost/schema";

/**
 * A hook and the session log both report each tool call and each session start: the hook from
 * the agent's payload (`selfhost hook`), the log importer from the transcript. Their ids differ,
 * since each is a function of what its source saw (time of the hook call, line of the log), so
 * the ledger's id check keeps both. This writer keeps one: an event whose fact is already in the
 * ledger, or earlier in the batch, under another id is skipped and reported as a duplicate.
 *
 * The fact is the agent, the session and, for a tool call, the agent's tool call id
 * (data.tool_use_id, which both sources set). Whichever copy is written first stays; `selfhost
 * import` drains the hook spool before the logs, so the hook's copy, which the pre-tool decision
 * (policy.evaluated) links to, is usually the one. A decision whose tool call was skipped is
 * linked to the copy that stayed.
 */

const KINDS = ["tool.called", "session.started"] as const;

function factOf(event: Pick<LedgerEvent, "kind" | "agent" | "session_id" | "data">) {
  if (!event.session_id) return undefined;
  const vendor = event.agent?.vendor ?? "";
  if (event.kind === "session.started") return `session\n${vendor}\n${event.session_id}`;
  if (event.kind !== "tool.called") return undefined;
  const call = event.data?.tool_use_id;
  return typeof call === "string" && call !== ""
    ? `tool\n${vendor}\n${event.session_id}\n${call}`
    : undefined;
}

interface StoredFact {
  id: string;
  kind: string;
  agent: string | null;
  session_id: string;
  tool_use_id: string | null;
}

/** The ids of the facts these sessions already have in the ledger. */
async function storedFacts(ledger: Ledger, sessions: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (sessions.length === 0) return found;
  const rows = await databaseOf(ledger).query<StoredFact>(
    `SELECT id::text AS id, kind, agent, session_id, body#>>'{data,tool_use_id}' AS tool_use_id
     FROM events
     WHERE kind IN (${KINDS.map((kind) => `'${kind}'`).join(", ")})
       AND session_id IN (SELECT jsonb_array_elements_text($1::text::jsonb))
     ORDER BY ts, id`,
    [JSON.stringify(sessions)],
  );
  for (const row of rows) {
    const fact = factOf({
      kind: row.kind as LedgerEvent["kind"],
      session_id: row.session_id,
      ...(row.agent
        ? { agent: { vendor: row.agent as NonNullable<LedgerEvent["agent"]>["vendor"] } }
        : {}),
      ...(row.tool_use_id ? { data: { tool_use_id: row.tool_use_id } } : {}),
    });
    if (fact && !found.has(fact)) found.set(fact, row.id);
  }
  return found;
}

/** Writes through `inner`, skipping the second copy of a tool call or session start. */
export function oneCopyPerFact(ledger: Ledger, inner: LedgerWriter = ledger): LedgerWriter {
  return {
    async append(events) {
      const sessions = [
        ...new Set(events.flatMap((event) => (factOf(event) ? [event.session_id ?? ""] : []))),
      ];
      const kept = await storedFacts(ledger, sessions);
      const replaced = new Map<string, string>();
      const batch: LedgerEvent[] = [];
      /** Position in `events` of each event in `batch`. */
      const positions: number[] = [];
      for (const [index, event] of events.entries()) {
        const fact = factOf(event);
        const id = fact === undefined ? undefined : kept.get(fact);
        if (fact !== undefined && id !== undefined && id !== event.id) {
          replaced.set(event.id, id);
          continue;
        }
        if (fact !== undefined) kept.set(fact, event.id);
        batch.push(event);
        positions.push(index);
      }
      const linked = batch.map((event) => {
        const target = event.data?.tool_event_id;
        const to = typeof target === "string" ? replaced.get(target) : undefined;
        return to ? { ...event, data: { ...event.data, tool_event_id: to } } : event;
      });
      if (linked.length === 0) return { accepted: [], duplicates: [...replaced.keys()] };
      try {
        const result = await inner.append(linked);
        return {
          accepted: result.accepted,
          duplicates: [...result.duplicates, ...replaced.keys()],
        };
      } catch (error) {
        // Callers skip the events an error names, by their place in the batch they passed.
        if (!(error instanceof LedgerValidationError)) throw error;
        throw new LedgerValidationError(
          error.errors.map((e) => ({
            ...e,
            index: e.index < 0 ? e.index : (positions[e.index] ?? -1),
          })),
        );
      }
    },
  };
}

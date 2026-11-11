import type { LedgerEvent } from "@selfhost/schema";
import type { Queryable } from "./db.js";

/**
 * A hook and the session log both report each tool call and each session start, under different
 * ids (each a function of what its source saw), and two ledgers of the same person (a watch and a
 * one-shot import) can each send theirs. The fact is the team the event is stored in, the agent,
 * the session and, for a tool call, the agent's tool call id (data.tool_use_id, which every
 * source sets). The first copy stored stays; later copies are skipped, and a decision in the
 * same batch that links to a skipped copy (data.tool_event_id) is linked to the one that stayed.
 * Matching within the team keeps one team's events from hiding another's.
 */

const KINDS = ["tool.called", "session.started"] as const;

export function factOf(
  event: Pick<LedgerEvent, "kind" | "agent" | "session_id" | "data">,
  team: string | null,
): string | undefined {
  if (!event.session_id) return undefined;
  const scope = `${team ?? ""}\n${event.agent?.vendor ?? ""}\n${event.session_id}`;
  if (event.kind === "session.started") return `session\n${scope}`;
  if (event.kind !== "tool.called") return undefined;
  const call = event.data?.tool_use_id;
  return typeof call === "string" && call !== "" ? `tool\n${scope}\n${call}` : undefined;
}

interface StoredFact {
  id: string;
  kind: string;
  agent: string | null;
  session_id: string;
  team: string | null;
  tool_use_id: string | null;
}

/** The events to write, without second copies, and the team of each. */
export async function oneCopyPerFact(
  tx: Queryable,
  events: readonly LedgerEvent[],
  teams: readonly (string | null)[],
): Promise<{ events: LedgerEvent[]; teams: (string | null)[] }> {
  const facts = events.map((event, i) => factOf(event, teams[i] ?? null));
  const sessions = [
    ...new Set(events.flatMap((event, i) => (facts[i] ? [event.session_id ?? ""] : []))),
  ];
  if (sessions.length === 0) return { events: [...events], teams: [...teams] };
  const kept = new Map<string, string>();
  const rows = await tx.query<StoredFact>(
    `SELECT id::text AS id, kind, agent, session_id, team, body#>>'{data,tool_use_id}' AS tool_use_id
     FROM events
     WHERE kind IN (${KINDS.map((kind) => `'${kind}'`).join(", ")})
       AND session_id IN (SELECT jsonb_array_elements_text($1::text::jsonb))
     ORDER BY ts, id`,
    [JSON.stringify(sessions)],
  );
  for (const row of rows) {
    const fact = factOf(
      {
        kind: row.kind as LedgerEvent["kind"],
        session_id: row.session_id,
        ...(row.agent
          ? { agent: { vendor: row.agent as NonNullable<LedgerEvent["agent"]>["vendor"] } }
          : {}),
        ...(row.tool_use_id ? { data: { tool_use_id: row.tool_use_id } } : {}),
      },
      row.team,
    );
    if (fact && !kept.has(fact)) kept.set(fact, row.id.toLowerCase());
  }
  const replaced = new Map<string, string>();
  const out: { events: LedgerEvent[]; teams: (string | null)[] } = { events: [], teams: [] };
  for (const [i, event] of events.entries()) {
    const fact = facts[i];
    const id = event.id.toLowerCase();
    const first = fact === undefined ? undefined : kept.get(fact);
    if (fact !== undefined && first !== undefined && first !== id) {
      replaced.set(id, first);
      continue;
    }
    if (fact !== undefined) kept.set(fact, id);
    out.events.push(event);
    out.teams.push(teams[i] ?? null);
  }
  if (replaced.size > 0) {
    out.events = out.events.map((event) => {
      const target = event.data?.tool_event_id;
      const to = typeof target === "string" ? replaced.get(target.toLowerCase()) : undefined;
      return to ? { ...event, data: { ...event.data, tool_event_id: to } } : event;
    });
  }
  return out;
}

import { databaseOf, type Ledger, stableEventId } from "@selfhost/ledger";
import { GRANT_UNVERIFIED_ALERT } from "@selfhost/review";
import { EVENT_SCHEMA, type LedgerEvent } from "@selfhost/schema";

/**
 * Checks the allows a laptop reports under a one-time exception against the grants this server
 * signed. The hook on the laptop verifies a grant offline, so a person or an agent with their OS
 * user can write a grant (and, on an old laptop, pin their own key) and get an allow the ledger
 * would show like any other. Here an allow that cites an exception must match a grant in
 * exception_grants: signed by this server, for the person who sent it, before it expired, and not
 * cited by another allow already. One that does not is stored flagged data.grant_unverified, never
 * dropped, and an alert.raised (data.alert "grant_unverified") goes to the team's owners and
 * admins through the review list.
 */

/** How long after a grant expired an allow under it still counts, for laptop clock skew. */
const SKEW_MS = 5 * 60_000;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

interface Cited {
  index: number;
  event: Json;
  exception: string;
  person: string | undefined;
}

/** An allow the hook answered because a grant let the call through once. */
function citedException(event: Json): string | undefined {
  if (event.kind !== "policy.evaluated" || !isObject(event.data)) return undefined;
  const { data } = event;
  if (data.answer !== "allow" || !isObject(data.exception)) return undefined;
  if (data.exception.used !== true) return undefined;
  return text(data.exception.id)?.toLowerCase();
}

/** The person whose laptop sent the event: the token's person, else who the event names. */
function personOf(event: Json, sender: string | undefined): string | undefined {
  if (sender) return sender;
  const data = isObject(event.data) ? event.data : {};
  const actor = isObject(event.actor) ? event.actor : {};
  return text(data.sent_by) ?? (actor.kind === "person" ? text(actor.id) : undefined);
}

interface GrantRow {
  id: string;
  requested_by: string;
  expires_at: string | Date;
  body: { decision_event_id?: string };
}

export interface GrantAudit {
  /** The batch as it is stored: allows that cite no grant the server signed are flagged. */
  events: unknown[];
  /** For each flagged event, by its id: the alert to store once that event is. */
  alerts: Map<string, LedgerEvent>;
}

export const alertText = (person: string | undefined) =>
  `An allow cited an exception the server never signed: possible forged grant on ${person ?? "an unknown person"}'s laptop`;

/**
 * Flags the allows in a batch that cite an exception this server holds no matching grant for.
 * Any data.grant_unverified a laptop sent is dropped first: only the server sets it.
 */
export async function auditGrantUses(
  ledger: Ledger,
  batch: readonly unknown[],
  options: { sender?: string; now: Date },
): Promise<GrantAudit> {
  const cited: Cited[] = [];
  const events = batch.map((value, index) => {
    if (!isObject(value) || !isObject(value.data) || !("grant_unverified" in value.data)) {
      if (isObject(value)) {
        const exception = citedException(value);
        if (exception) {
          cited.push({ index, event: value, exception, person: personOf(value, options.sender) });
        }
      }
      return value;
    }
    const { grant_unverified: _, grant_unverified_reason: __, ...data } = value.data;
    const event = { ...value, data };
    const exception = citedException(event);
    if (exception) cited.push({ index, event, exception, person: personOf(event, options.sender) });
    return event;
  });
  const alerts = new Map<string, LedgerEvent>();
  if (cited.length === 0) return { events, alerts };

  const db = databaseOf(ledger);
  const ids = [...new Set(cited.map((c) => c.exception))].filter((id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id),
  );
  const batchIds = cited.map((c) => text(c.event.id)).filter((id) => id !== undefined);
  const grants = new Map<string, GrantRow>();
  const usedBy = new Map<string, string>();
  if (ids.length > 0) {
    for (const row of await db.query<GrantRow>(
      "SELECT id::text AS id, requested_by, expires_at, body FROM exception_grants WHERE id = ANY($1::uuid[])",
      [ids],
    )) {
      grants.set(row.id.toLowerCase(), row);
    }
    // Allows already stored under the same exception: a grant lets one call through.
    for (const row of await db.query<{ id: string; exception: string }>(
      `SELECT id::text AS id, lower(body#>>'{data,exception,id}') AS exception FROM events
       WHERE kind = 'policy.evaluated'
         AND lower(body#>>'{data,exception,id}') = ANY($1::text[])
         AND body#>>'{data,answer}' = 'allow'
         AND body#>>'{data,exception,used}' = 'true'
         AND NOT (id::text = ANY($2::text[]))
       ORDER BY ts LIMIT 1000`,
      [ids, batchIds],
    )) {
      if (!usedBy.has(row.exception)) usedBy.set(row.exception, row.id);
    }
  }

  for (const c of cited) {
    const reason = unverified(c, grants.get(c.exception), usedBy.get(c.exception));
    const id = text(c.event.id);
    if (reason === undefined) {
      if (id && !usedBy.has(c.exception)) usedBy.set(c.exception, id);
      continue;
    }
    const data = c.event.data as Json;
    events[c.index] = {
      ...c.event,
      data: { ...data, grant_unverified: true, grant_unverified_reason: reason },
    };
    if (!id) continue;
    alerts.set(id, alertFor(c, id, reason, options.now));
  }
  return { events, alerts };
}

/** Why an allow's grant does not hold up, or undefined when the server signed it for this use. */
function unverified(
  c: Cited,
  grant: GrantRow | undefined,
  usedBy: string | undefined,
): string | undefined {
  const exception = c.exception;
  if (!grant) return `this server never signed a grant for exception ${exception}`;
  if (c.person === undefined || grant.requested_by.toLowerCase() !== c.person.toLowerCase()) {
    return `this server signed exception ${exception} for another person, not for ${c.person ?? "the sender"}`;
  }
  const data = c.event.data as Json;
  const cites = isObject(data.exception) ? text(data.exception.decision_event_id) : undefined;
  if (cites !== undefined && cites !== grant.body.decision_event_id) {
    return `the allow names a different approval than the grant this server signed for exception ${exception}`;
  }
  const ts = Date.parse(String(c.event.ts ?? ""));
  if (Number.isFinite(ts) && ts > new Date(grant.expires_at).getTime() + SKEW_MS) {
    return `the grant for exception ${exception} had expired when the call was allowed`;
  }
  if (usedBy !== undefined) {
    return `the grant for exception ${exception} was already used, by event ${usedBy}`;
  }
  return undefined;
}

function alertFor(c: Cited, eventId: string, reason: string, now: Date): LedgerEvent {
  const event = c.event;
  const agent = isObject(event.agent) ? (event.agent as LedgerEvent["agent"]) : undefined;
  return {
    id: stableEventId(
      String(event.ts ?? now.toISOString()),
      `${GRANT_UNVERIFIED_ALERT}\n${eventId}`,
    ),
    schema: EVENT_SCHEMA,
    ts: now.toISOString(),
    source: "server",
    kind: "alert.raised",
    actor: { kind: "system", id: "selfhost" },
    ...(agent ? { agent } : {}),
    ...(text(event.session_id) ? { session_id: text(event.session_id) } : {}),
    ...(text(event.repo) ? { repo: text(event.repo) } : {}),
    data: {
      alert: GRANT_UNVERIFIED_ALERT,
      ...(c.person ? { person: c.person } : {}),
      exception_id: c.exception,
      event_id: eventId,
      reason,
      message: alertText(c.person),
    },
  };
}

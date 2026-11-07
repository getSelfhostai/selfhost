import { userInfo } from "node:os";
import { EVENT_SCHEMA, type LedgerEvent } from "@selfhost/schema";
import { deterministicUuidv7 } from "./ids.js";
import type { EventInput, ParsedEvent, Vendor } from "./types.js";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_WINDOW_DAYS = 30;
/** A session with no new lines for this long is reported as ended. */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

export function defaultSince(now = Date.now()): Date {
  return new Date(now - DEFAULT_WINDOW_DAYS * DAY_MS);
}

export function defaultActorId(): string {
  try {
    return userInfo().username || "local";
  } catch {
    return "local";
  }
}

/** ISO 8601 UTC, or undefined when the log timestamp does not parse. */
export function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

export function agentActor(vendor: Vendor, sessionId: string) {
  return { kind: "agent" as const, id: `${vendor}:session:${sessionId}` };
}

export function eventKey(vendor: Vendor, input: Pick<EventInput, "scope" | "kind" | "identity">) {
  return `${vendor}\n${input.scope}\n${input.kind}\n${input.identity}`;
}

export function buildEvent(vendor: Vendor, input: EventInput): ParsedEvent {
  const key = eventKey(vendor, input);
  const event: LedgerEvent = {
    id: deterministicUuidv7(key, Date.parse(input.ts)),
    schema: EVENT_SCHEMA,
    ts: input.ts,
    source: "local_log",
    kind: input.kind,
    actor: input.actor,
    agent: input.version ? { vendor, version: input.version } : { vendor },
    session_id: input.sessionId,
    ...(input.model ? { model: input.model } : {}),
    ...input.fields,
  };
  return { event, key, keep: input.keep ?? "first" };
}

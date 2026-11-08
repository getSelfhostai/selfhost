import { EVENT_SCHEMA, type LedgerEvent, validateEvent } from "./event.js";
import type { FieldError, ValidationResult } from "./validate.js";

/**
 * Event schema versions. An event names its version in `schema`. The newest version is current;
 * an older one is still accepted at ingest for EVENT_SCHEMA_SUPPORT_MONTHS after the version that
 * replaced it was released, so every version released in the last 12 months is accepted, and
 * then some. Accepted older events are upgraded to the current version before they are validated
 * and stored, so readers only ever see the current shape.
 *
 * Adding a version: append it here with its release date, give the version before it an
 * `upgrade`, freeze its fixtures in compat/<version>/, and keep the old version's compat files.
 */
export const EVENT_SCHEMA_SUPPORT_MONTHS = 12;

export const EVENT_VERSIONS_SCHEMA = "selfhost.event_versions/v1";

type Json = Record<string, unknown>;

export interface EventSchemaVersion {
  /** The value of the event's `schema` field. */
  tag: string;
  /** Day the version was released, YYYY-MM-DD in UTC. */
  released: string;
  /**
   * Rewrites an event in this version as the next version in the list. Every version but the
   * newest has one. The caller sets `schema` to the next version's tag afterwards.
   */
  upgrade?: (event: Json) => Json;
}

/** Oldest first. The last entry is the version every writer in this repository produces. */
export const EVENT_SCHEMA_VERSIONS: readonly EventSchemaVersion[] = [
  { tag: EVENT_SCHEMA, released: "2026-11-07" },
];

export interface EventVersionOptions {
  /** Default: EVENT_SCHEMA_VERSIONS. */
  versions?: readonly EventSchemaVersion[];
  /** Default: the current time. */
  now?: Date;
}

export type EventSchemaSupport =
  | { status: "current"; released: string }
  | { status: "supported" | "expired"; released: string; supersededBy: string; until: string }
  | { status: "unknown" };

/** The day `months` calendar months after a YYYY-MM-DD day, clamped to the month's last day. */
export function addMonths(day: string, months: number): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(date, last));
  return target.toISOString().slice(0, 10);
}

/** Whether `tag` is accepted at `now`, and until when. */
export function eventSchemaSupport(
  tag: string,
  options: EventVersionOptions = {},
): EventSchemaSupport {
  const versions = options.versions ?? EVENT_SCHEMA_VERSIONS;
  const index = versions.findIndex((v) => v.tag === tag);
  const version = versions[index];
  if (version === undefined) return { status: "unknown" };
  const next = versions[index + 1];
  if (next === undefined) return { status: "current", released: version.released };
  const until = addMonths(next.released, EVENT_SCHEMA_SUPPORT_MONTHS);
  const today = (options.now ?? new Date()).toISOString().slice(0, 10);
  return {
    status: today < until ? "supported" : "expired",
    released: version.released,
    supersededBy: next.tag,
    until,
  };
}

/** Tags accepted at `now`, newest first. */
export function acceptedEventSchemas(options: EventVersionOptions = {}): string[] {
  const versions = options.versions ?? EVENT_SCHEMA_VERSIONS;
  return versions
    .map((v) => v.tag)
    .filter((tag) => {
      const { status } = eventSchemaSupport(tag, options);
      return status === "current" || status === "supported";
    })
    .reverse();
}

export type UpgradeResult =
  | { ok: true; value: unknown; from?: string }
  | { ok: false; errors: FieldError[] };

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Upgrades an event in an accepted older version to the current one. Values that are not
 * objects, or have no string `schema`, are returned as they are for the validator to report.
 * An unknown version, or one past its support window, is an error on `schema`.
 */
export function upgradeEvent(value: unknown, options: EventVersionOptions = {}): UpgradeResult {
  if (!isObject(value) || typeof value.schema !== "string") return { ok: true, value };
  const versions = options.versions ?? EVENT_SCHEMA_VERSIONS;
  const from = value.schema;
  const support = eventSchemaSupport(from, options);
  if (support.status === "current") return { ok: true, value };
  const current = versions.at(-1)?.tag ?? EVENT_SCHEMA;
  if (support.status === "unknown") {
    const accepted = acceptedEventSchemas(options).join(", ");
    return schemaError(`Unknown event schema ${JSON.stringify(from)}. Accepted: ${accepted}`);
  }
  if (support.status === "expired") {
    return schemaError(
      `${from} is no longer accepted: support ended on ${support.until}, ${EVENT_SCHEMA_SUPPORT_MONTHS} months after ${support.supersededBy} was released. Update the importer or SDK that sent it to one that writes ${current}`,
    );
  }
  let event: Json = value;
  for (let i = versions.findIndex((v) => v.tag === from); i < versions.length - 1; i++) {
    const step = versions[i] as EventSchemaVersion;
    const next = versions[i + 1] as EventSchemaVersion;
    if (!step.upgrade) return schemaError(`No upgrade from ${step.tag} to ${next.tag}`);
    try {
      event = { ...step.upgrade(event), schema: next.tag };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return schemaError(`Could not upgrade from ${step.tag} to ${next.tag}: ${reason}`);
    }
  }
  return { ok: true, value: event, from };
}

function schemaError(message: string): UpgradeResult {
  return { ok: false, errors: [{ field: "schema", message }] };
}

/**
 * The ingest check: upgrades an event in an accepted older version, then validates it against
 * the current version. `validateEvent` alone accepts the current version only.
 */
export function ingestEvent(
  value: unknown,
  options: EventVersionOptions = {},
): ValidationResult<LedgerEvent> {
  const upgraded = upgradeEvent(value, options);
  if (!upgraded.ok) return upgraded;
  return validateEvent(upgraded.value);
}

export type EventVersionsFile = {
  schema: typeof EVENT_VERSIONS_SCHEMA;
  support_months: number;
  current: string;
  versions: {
    tag: string;
    released: string;
    /** Release day of the version that replaced it, or null for the current version. */
    superseded: string | null;
    /** First day it is no longer accepted, or null for the current version. */
    supported_until: string | null;
  }[];
};

/** The registry as data, for clients that do not read TypeScript. Written to event-versions.json. */
export function eventVersionsFile(
  versions: readonly EventSchemaVersion[] = EVENT_SCHEMA_VERSIONS,
): EventVersionsFile {
  return {
    schema: EVENT_VERSIONS_SCHEMA,
    support_months: EVENT_SCHEMA_SUPPORT_MONTHS,
    current: versions.at(-1)?.tag ?? EVENT_SCHEMA,
    versions: versions.map((v, i) => {
      const next = versions[i + 1];
      return {
        tag: v.tag,
        released: v.released,
        superseded: next?.released ?? null,
        supported_until: next ? addMonths(next.released, EVENT_SCHEMA_SUPPORT_MONTHS) : null,
      };
    }),
  };
}

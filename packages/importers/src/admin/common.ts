import { type AgentVendor, EVENT_SCHEMA, type LedgerEvent } from "@selfhost/schema";
import { deterministicUuidv7 } from "../ids.js";

/** The vendor admin APIs selfhost reads usage from. */
export const ADMIN_IMPORTERS = ["anthropic", "openai", "cursor"] as const;

export type AdminImporterId = (typeof ADMIN_IMPORTERS)[number];

/** data.rollup on a vendor-reported daily total, which the spend readers dedupe by person-day. */
export const VENDOR_ROLLUP_DAY = "day";

export const DAY_MS = 86_400_000;

/** One person's usage of one model on one UTC day, as a vendor reports it. */
export interface VendorDayUsage {
  /** YYYY-MM-DD, UTC. */
  day: string;
  /** The vendor's account email, lowercased. */
  email: string;
  agent: AgentVendor;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  usd: number;
  /** false when the vendor reported usd, true when it was priced from a table. */
  estimated: boolean;
  /** What else the vendor said about the day, kept in the event's data. */
  extra?: Record<string, unknown>;
}

/** What a vendor said about a day's read besides the usage: rows it could not use. */
export interface VendorDayRead {
  usage: VendorDayUsage[];
  /** Rows left out, by why, for the import status. */
  skipped: Record<string, number>;
}

export interface AdminImporter {
  id: AdminImporterId;
  /** What the importer covers and what it cannot see, shown with its status. */
  notes: string[];
  /** Usage of each UTC day from `from` through `through` (YYYY-MM-DD, both included). */
  read(from: string, through: string): Promise<VendorDayRead>;
}

/** The answer a vendor gave when a key may not read its admin API (401, 403, 404). */
export class VendorNotAvailableError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "VendorNotAvailableError";
  }
}

export class VendorApiError extends Error {
  constructor(
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "VendorApiError";
  }
}

const NOT_AVAILABLE = new Set([401, 403, 404]);

/**
 * Sends one request and reads its JSON body. The key goes only in the headers given; errors name
 * the vendor and the HTTP status and a short slice of the body, never the request headers.
 */
export async function vendorJson(
  send: typeof fetch,
  vendor: string,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let res: Response;
  try {
    res = await send(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new VendorApiError(
      undefined,
      `${vendor}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    const message = `${vendor} answered ${res.status}${text ? `: ${text}` : ""}`;
    if (NOT_AVAILABLE.has(res.status)) throw new VendorNotAvailableError(res.status, message);
    throw new VendorApiError(res.status, message);
  }
  return res.json();
}

/** Every UTC day from `from` through `through`, as YYYY-MM-DD. */
export function daysBetween(from: string, through: string): string[] {
  const days: string[] = [];
  const end = Date.parse(`${through}T00:00:00Z`);
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= end; at += DAY_MS) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const count = (value: unknown): number => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

export const amount = (value: unknown): number => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
};

export const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** Adds rows of the same day, person, agent and model together. */
export function mergeUsage(rows: VendorDayUsage[]): VendorDayUsage[] {
  const merged = new Map<string, VendorDayUsage>();
  for (const row of rows) {
    const key = `${row.day}\n${row.email}\n${row.agent}\n${row.model}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...row, ...(row.extra ? { extra: { ...row.extra } } : {}) });
      continue;
    }
    current.input_tokens += row.input_tokens;
    current.output_tokens += row.output_tokens;
    current.cache_read_tokens += row.cache_read_tokens;
    current.cache_write_tokens += row.cache_write_tokens;
    current.usd += row.usd;
    current.estimated ||= row.estimated;
    for (const [name, value] of Object.entries(row.extra ?? {})) {
      const before = current.extra?.[name];
      current.extra = {
        ...current.extra,
        [name]: typeof before === "number" && typeof value === "number" ? before + value : value,
      };
    }
  }
  return [...merged.values()];
}

/** The person a vendor email belongs to on this server, and their team when they have one. */
export interface PersonMatch {
  id: string;
  team?: string;
}

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

/**
 * A vendor-reported daily total as a cost.recorded event: source vendor_api, at the start of the
 * UTC day, with no session (the vendor reports none), and data.rollup "day" so readers count it
 * only for a person, agent and day no other source reported. The id is a function of the
 * importer, day, email and model, so importing a day again stores nothing new.
 */
export function rollupEvent(
  importer: AdminImporterId,
  row: VendorDayUsage,
  person: PersonMatch,
): LedgerEvent {
  const ts = `${row.day}T00:00:00.000Z`;
  return {
    id: deterministicUuidv7(
      `vendor_api\n${importer}\n${row.day}\n${row.email}\n${row.agent}\n${row.model}`,
      Date.parse(ts),
    ),
    schema: EVENT_SCHEMA,
    ts,
    source: "vendor_api",
    kind: "cost.recorded",
    actor: { kind: "person", id: person.id },
    ...(person.team ? { team: person.team } : {}),
    agent: { vendor: row.agent },
    model: row.model,
    cost: {
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_read_tokens: row.cache_read_tokens,
      cache_write_tokens: row.cache_write_tokens,
      usd: round(row.usd),
      estimated: row.estimated,
    },
    data: {
      vendor_api: importer,
      rollup: VENDOR_ROLLUP_DAY,
      day: row.day,
      vendor_reported: true,
      request_type: "unknown",
      ...row.extra,
    },
  };
}

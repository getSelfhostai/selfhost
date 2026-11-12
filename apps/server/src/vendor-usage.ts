import {
  type AdminImporter,
  anthropicImporter,
  cursorImporter,
  daysBetween,
  openAiImporter,
  type PersonMatch,
  readVendorEvents,
  VendorNotAvailableError,
} from "@selfhost/importers";
import { databaseOf, type Ledger } from "@selfhost/ledger";
import type {
  LedgerEvent,
  VendorImportState,
  VendorImportStatus,
  VendorImportsResponse,
} from "@selfhost/schema";
import type { Hono } from "hono";
import type { Router } from "./access.js";

/**
 * Usage from vendor admin APIs (Anthropic, OpenAI, Cursor), for the use that never reaches the
 * gateway or a laptop's logs on this server. Each importer reads closed UTC days after the last
 * one it imported (vendor_imports.through_day), maps each vendor email to a person here, and
 * writes one cost.recorded per person, model and day, marked vendor-reported (data.rollup
 * "day"). Readers count such a total only for a person-day no other source reported, so a day
 * the logs, hooks or the gateway already saw counts once (rule 3 in @selfhost/spend sources).
 */

export const VENDOR_IMPORT_INTERVAL_MS = 60 * 60 * 1000;
/** A day is read once it ended this long ago: the vendors finish a day's numbers within it. */
export const VENDOR_SETTLE_MS = 3 * 60 * 60 * 1000;
/** How far back the first read goes, and the most one run reads. */
export const VENDOR_LOOKBACK_DAYS = 30;

const DAY_MS = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Importers for the admin keys set in the environment. Keys go only to their vendor. */
export function vendorImportersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  send: typeof fetch = fetch,
): AdminImporter[] {
  const key = (name: string) => env[name]?.trim() || undefined;
  const importers: AdminImporter[] = [];
  const anthropic = key("SELFHOST_ANTHROPIC_ADMIN_KEY");
  if (anthropic) importers.push(anthropicImporter({ adminKey: anthropic, fetch: send }));
  const openai = key("SELFHOST_OPENAI_ADMIN_KEY");
  if (openai) {
    const skipKeyIds = (key("SELFHOST_OPENAI_SKIP_KEY_IDS") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "");
    importers.push(openAiImporter({ adminKey: openai, skipKeyIds, fetch: send }));
  }
  const cursor = key("SELFHOST_CURSOR_ADMIN_KEY");
  if (cursor) importers.push(cursorImporter({ adminKey: cursor, fetch: send }));
  return importers;
}

interface ImportRow {
  importer: string;
  through_day: string | null;
  state: Exclude<VendorImportState, "pending">;
  detail: string | null;
  events: number;
  last_run_at: string | null;
}

async function readRows(ledger: Ledger): Promise<Map<string, ImportRow>> {
  const rows = await databaseOf(ledger).query<ImportRow>(
    `SELECT importer, to_char(through_day, 'YYYY-MM-DD') AS through_day, state, detail, events,
       to_char(last_run_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_run_at
     FROM vendor_imports`,
  );
  return new Map(rows.map((row) => [row.importer, row]));
}

async function saveRow(ledger: Ledger, row: ImportRow): Promise<void> {
  await databaseOf(ledger).query(
    `INSERT INTO vendor_imports (importer, through_day, state, detail, events, last_run_at)
     VALUES ($1, $2::date, $3, $4, $5, $6::timestamptz)
     ON CONFLICT (importer) DO UPDATE SET through_day = excluded.through_day,
       state = excluded.state, detail = excluded.detail, events = excluded.events,
       last_run_at = excluded.last_run_at`,
    [row.importer, row.through_day, row.state, row.detail, row.events, row.last_run_at],
  );
}

/**
 * Vendor email to person: a person whose id is the email, ignoring case. A person in exactly one
 * team gets that team, so their team's people read the rows; others are stored with no team,
 * which the org's admin token reads.
 */
async function peopleByEmail(ledger: Ledger): Promise<(email: string) => PersonMatch | undefined> {
  const rows = await databaseOf(ledger).query<{ id: string; team_id: string }>(
    "SELECT id, team_id FROM people ORDER BY id, team_id",
  );
  const byEmail = new Map<string, { id: string; teams: Set<string> }>();
  for (const row of rows) {
    const key = row.id.toLowerCase();
    const entry = byEmail.get(key) ?? { id: row.id, teams: new Set<string>() };
    entry.teams.add(row.team_id);
    byEmail.set(key, entry);
  }
  return (email) => {
    const entry = byEmail.get(email.toLowerCase());
    if (!entry) return undefined;
    const [team] = entry.teams;
    return entry.teams.size === 1 && team ? { id: entry.id, team } : { id: entry.id };
  };
}

async function appendByTeam(ledger: Ledger, events: LedgerEvent[]): Promise<number> {
  const groups = new Map<string | undefined, LedgerEvent[]>();
  for (const event of events) groups.set(event.team, [...(groups.get(event.team) ?? []), event]);
  let accepted = 0;
  for (const [team, list] of groups) {
    for (let start = 0; start < list.length; start += 1000) {
      const result = await ledger.append(list.slice(start, start + 1000), team ? { team } : {});
      accepted += result.accepted.length;
    }
  }
  return accepted;
}

/**
 * Reads one importer's closed days since its last import into the ledger, and records how it
 * went. A key without access is not_available and keeps its place; any other failure is error
 * and the same days are read again next time. Event ids come from the importer, day, email and
 * model, so a day read twice stores nothing new.
 */
export async function importVendorNow(
  ledger: Ledger,
  importer: AdminImporter,
  now: () => Date = () => new Date(),
): Promise<ImportRow> {
  const at = now();
  const last = dayOf(at.getTime() - VENDOR_SETTLE_MS - DAY_MS);
  const earliest = dayOf(Date.parse(`${last}T00:00:00Z`) - (VENDOR_LOOKBACK_DAYS - 1) * DAY_MS);
  const before = (await readRows(ledger)).get(importer.id);
  const next = before?.through_day
    ? dayOf(Date.parse(`${before.through_day}T00:00:00Z`) + DAY_MS)
    : earliest;
  const from = next.localeCompare(earliest) < 0 ? earliest : next;
  const row: ImportRow = {
    importer: importer.id,
    through_day: before?.through_day ?? null,
    state: "ok",
    detail: null,
    events: 0,
    last_run_at: at.toISOString(),
  };
  if (from > last) return before ?? row;
  try {
    const read = await readVendorEvents(importer, from, last, await peopleByEmail(ledger));
    row.events = await appendByTeam(ledger, read.events);
    row.through_day = last;
    const left = Object.entries(read.skipped).map(([why, n]) => `${n} ${why.replace("_", " ")}`);
    const parts = [
      `${daysBetween(from, last).length} days through ${last}, ${read.people === 1 ? "1 person" : `${read.people} people`}`,
      ...(read.unmatched > 0
        ? [`${read.unmatched} not on this server, stored under their vendor email`]
        : []),
      ...(left.length > 0 ? [`skipped ${left.join(", ")}`] : []),
    ];
    row.detail = `${parts.join("; ")}.`;
  } catch (error) {
    row.state = error instanceof VendorNotAvailableError ? "not_available" : "error";
    row.detail = error instanceof Error ? error.message : String(error);
  }
  await saveRow(ledger, row);
  return row;
}

export interface VendorImportJob {
  run(): Promise<void>;
  stop(): void;
}

/**
 * Runs every importer now and every intervalMs, one at a time; a run still going when the next
 * is due is not started twice, the timer never keeps the process alive, and the log names
 * counts and states, never keys.
 */
export function startVendorImportJob(
  ledger: Ledger,
  importers: readonly AdminImporter[],
  options: { intervalMs?: number; log?: (line: string) => void; now?: () => Date } = {},
): VendorImportJob {
  const { intervalMs = VENDOR_IMPORT_INTERVAL_MS, log = console.log } = options;
  let running: Promise<void> | undefined;
  const once = async () => {
    for (const importer of importers) {
      const row = await importVendorNow(ledger, importer, options.now);
      if (row.state !== "ok") log(`vendor usage: ${importer.id} ${row.state}: ${row.detail}`);
      else if (row.events > 0) log(`vendor usage: ${importer.id} ${row.events} events`);
    }
  };
  const run = () => {
    running ??= once()
      .catch((error) => log(`vendor usage: ${error instanceof Error ? error.message : error}`))
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  void run();
  return { run, stop: () => clearInterval(timer) };
}

/** The status of each configured importer, with what it covers. */
export async function vendorImportStatus(
  ledger: Ledger,
  importers: readonly AdminImporter[],
): Promise<VendorImportsResponse> {
  const rows = await readRows(ledger);
  return {
    importers: importers.map((importer): VendorImportStatus => {
      const row = rows.get(importer.id);
      return {
        importer: importer.id,
        state: row?.state ?? "pending",
        detail: row?.detail ?? null,
        through_day: row?.through_day ?? null,
        last_run_at: row?.last_run_at ?? null,
        events: row?.events ?? 0,
        notes: importer.notes,
      };
    }),
  };
}

/** GET /v1/vendor-imports, for both kinds of token: no keys, only states and coverage. */
export function vendorImportRoutes(
  router: Router,
  ledger: Ledger,
  importers: readonly AdminImporter[],
): void {
  router.on("GET", "/v1/vendor-imports", async (c) =>
    c.json(await vendorImportStatus(ledger, importers)),
  );
}

/** POST /v1/vendor-imports/run, admin token only: imports now and answers with the status. */
export function vendorImportAdminRoutes(
  app: Hono,
  ledger: Ledger,
  importers: readonly AdminImporter[],
  now?: () => Date,
): void {
  app.post("/v1/vendor-imports/run", async (c) => {
    for (const importer of importers) await importVendorNow(ledger, importer, now);
    return c.json(await vendorImportStatus(ledger, importers));
  });
}

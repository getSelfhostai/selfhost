import { databaseOf, type Ledger, type Queryable } from "@selfhost/ledger";
import type { LedgerEvent, RedactionPattern, ResolvedSelfhostConfig } from "@selfhost/schema";
import { runSpans, type TraceSpan } from "./map.js";
import { otlpSender, type SpanSender, type TracerSettings } from "./otlp.js";
import { RUN_IDLE_MS } from "./summary.js";

/**
 * Where the export has got to, in review_progress (id, ingested_at), the small key and time
 * table the review list keeps its own cursor in:
 * - `traces`: every run with events ingested up to this time is sent, or has nothing to send.
 * - `traces:run:<run id>`: the run's root span is sent, with every event ingested up to this
 *   time. Its presence is what marks a run as exported, for the console's tracer link.
 */
const CURSOR_ID = "traces";
const RUN_MARK_PREFIX = "traces:run:";
const EPOCH = "1970-01-01T00:00:00.000Z";

/** Spans per OTLP request. */
export const SPANS_PER_REQUEST = 512;
/** Events newer than this may still be in a transaction that has not committed. */
export const DEFAULT_LAG_MS = 60_000;
/** Runs read per pass. */
export const DEFAULT_RUNS_PER_PASS = 200;

/** How one team's runs are sent. */
export interface RunExportSettings {
  tracer: TracerSettings;
  /** `[ledger] log_prompts`. */
  logPrompts: boolean;
  /** `[[redaction]]`. */
  patterns: readonly RedactionPattern[];
}

export interface ExportOptions {
  /** The settings for a run's team (null: events with no team), or undefined when it has no tracer. */
  settingsFor(team: string | null): Promise<RunExportSettings | undefined>;
  /** Default: OTLP/HTTP protobuf to the tracer's endpoint (otlpSender). */
  sender?: (tracer: TracerSettings) => SpanSender;
  now?: Date;
  /** A run with no session.ended is sent once its last event is this old. Default 30 minutes. */
  idleMs?: number;
  /** Default: one minute. */
  lagMs?: number;
  /**
   * Only runs with events from this time on, without reading or moving the export cursor
   * (`selfhost traces export --since`). Runs already sent are still not sent again.
   */
  since?: string;
  /** Build the spans, send nothing and write nothing. */
  dryRun?: boolean;
  runsPerPass?: number;
}

export interface RunExport {
  run: string;
  team: string | null;
  spans: TraceSpan[];
}

export interface ExportResult {
  /** Runs whose spans went out (or would, in a dry run). */
  sent: RunExport[];
  /** Runs still going: their root span goes out once they end or go idle. */
  pending: string[];
  /** Runs whose team has no tracer. */
  skipped: string[];
  /** Runs the tracer refused or could not be reached for. They are tried again next pass. */
  failed: { run: string; error: string }[];
  /** More runs were waiting than one pass reads. */
  more: boolean;
}

const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const json = <T>(value: unknown) => (typeof value === "string" ? JSON.parse(value) : value) as T;

interface Candidate {
  session_id: string;
  first_new: unknown;
  newest: unknown;
  has_end: boolean;
  last_ts: unknown;
  marked: unknown;
  /** The team most of the run's events belong to. */
  team: string | null;
}

/** Runs with events not sent yet, oldest first, with what decides whether their root can go. */
const CANDIDATES = `
SELECT e.session_id, min(e.ingested_at) AS first_new, max(e.ingested_at) AS newest,
  bool_or(e.kind = 'session.ended') AS has_end, max(e.ts) AS last_ts, max(p.ingested_at) AS marked,
  (SELECT mode() WITHIN GROUP (ORDER BY t.team) FROM events t
    WHERE t.session_id = e.session_id AND t.team IS NOT NULL) AS team
FROM events e
LEFT JOIN review_progress p ON p.id = '${RUN_MARK_PREFIX}' || e.session_id
WHERE coalesce(e.session_id, '') <> ''
  AND e.ingested_at > $1::timestamptz AND e.ingested_at <= $2::timestamptz
  AND ($3::timestamptz IS NULL OR e.ts >= $3::timestamptz)
  AND (p.ingested_at IS NULL OR e.ingested_at > p.ingested_at)
GROUP BY e.session_id
ORDER BY min(e.ingested_at), e.session_id
LIMIT $4`;

async function readTime(db: Queryable, id: string): Promise<string | undefined> {
  const [row] = await db.query<{ ingested_at: unknown }>(
    "SELECT ingested_at FROM review_progress WHERE id = $1",
    [id],
  );
  return row ? iso(row.ingested_at) : undefined;
}

async function writeTime(db: Queryable, id: string, at: string): Promise<void> {
  await db.query(
    `INSERT INTO review_progress (id, ingested_at) VALUES ($1, $2::timestamptz)
     ON CONFLICT (id) DO UPDATE SET ingested_at = EXCLUDED.ingested_at`,
    [id, at],
  );
}

/** Whether the run's root span has gone out to the tracer. */
export async function runExported(ledger: Ledger, runId: string): Promise<boolean> {
  return (await readTime(databaseOf(ledger), `${RUN_MARK_PREFIX}${runId}`)) !== undefined;
}

/** Which of these runs have had their root span sent. */
export async function exportedRuns(
  ledger: Ledger,
  runIds: readonly string[],
): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const rows = await databaseOf(ledger).query<{ id: string }>(
    "SELECT id FROM review_progress WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb))",
    [JSON.stringify(runIds.map((id) => `${RUN_MARK_PREFIX}${id}`))],
  );
  return new Set(rows.map((row) => row.id.slice(RUN_MARK_PREFIX.length)));
}

/** Every event of one run, oldest first, with when each was ingested and its team. */
export async function runEvents(
  db: Queryable,
  runId: string,
): Promise<{ event: LedgerEvent; ingested: string; team: string | null }[]> {
  const rows = await db.query<{ body: unknown; ingested_at: unknown; team: string | null }>(
    "SELECT body, ingested_at, team FROM events WHERE session_id = $1 ORDER BY ts, id",
    [runId],
  );
  return rows.map((row) => ({
    event: json<LedgerEvent>(row.body),
    ingested: iso(row.ingested_at),
    team: row.team,
  }));
}

/** The team most of a run's events belong to, or null when none has one. */
export function teamOfRun(rows: readonly { team: string | null }[]): string | null {
  const counts = new Map<string, number>();
  for (const { team } of rows) if (team) counts.set(team, (counts.get(team) ?? 0) + 1);
  let best: string | null = null;
  for (const [team, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = team;
  return best;
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * One export pass: every run (agent session) with events the tracer has not seen. A run's root
 * span goes out once, when the session has ended or been idle for `idleMs`, with a span for each
 * of its events so far; events that arrive later (a merged pull request, a late import) go out
 * as more spans in the same trace. Each run is marked with how far it was sent, so nothing is
 * sent twice, and a run the tracer refused is tried again on the next pass.
 */
export async function exportTraces(ledger: Ledger, options: ExportOptions): Promise<ExportResult> {
  const db = databaseOf(ledger);
  const now = options.now ?? new Date();
  const idleMs = options.idleMs ?? RUN_IDLE_MS;
  const limit = options.runsPerPass ?? DEFAULT_RUNS_PER_PASS;
  const upper = new Date(now.getTime() - (options.lagMs ?? DEFAULT_LAG_MS)).toISOString();
  const useCursor = options.since === undefined;
  const cursor = useCursor ? ((await readTime(db, CURSOR_ID)) ?? EPOCH) : EPOCH;
  const senders = new Map<string, SpanSender>();
  const senderFor = (tracer: TracerSettings) => {
    const key = JSON.stringify(tracer);
    let sender = senders.get(key);
    if (!sender) {
      sender = (options.sender ?? ((t) => otlpSender(t)))(tracer);
      senders.set(key, sender);
    }
    return sender;
  };
  const settings = new Map<string | null, Promise<RunExportSettings | undefined>>();
  const settingsFor = (team: string | null) => {
    let found = settings.get(team);
    if (!found) {
      found = options.settingsFor(team);
      settings.set(team, found);
    }
    return found;
  };

  const result: ExportResult = { sent: [], pending: [], skipped: [], failed: [], more: false };
  const candidates = await db.query<Candidate>(CANDIDATES, [
    cursor,
    upper,
    options.since ?? null,
    limit + 1,
  ]);
  result.more = candidates.length > limit;
  /** The oldest unsent event the cursor must stay before. */
  let hold: string | undefined;
  const holdAt = (at: unknown) => {
    const value = iso(at);
    if (hold === undefined || value < hold) hold = value;
  };
  if (result.more && candidates[limit]) holdAt(candidates[limit].first_new);

  for (const candidate of candidates.slice(0, limit)) {
    const run = candidate.session_id;
    const marked = candidate.marked == null ? undefined : iso(candidate.marked);
    const rootSent = marked !== undefined;
    const settled =
      candidate.has_end || Date.parse(iso(candidate.last_ts)) <= now.getTime() - idleMs;
    if (!rootSent && !settled) {
      result.pending.push(run);
      holdAt(candidate.first_new);
      continue;
    }
    const team = candidate.team;
    let found: RunExportSettings | undefined;
    try {
      found = await settingsFor(team);
    } catch (error) {
      result.failed.push({ run, error: (error as Error).message });
      holdAt(candidate.first_new);
      continue;
    }
    if (!found) {
      result.skipped.push(run);
      continue;
    }
    const rows = (await runEvents(db, run)).filter((row) => row.ingested <= upper);
    const fresh = new Set(
      rows.filter((row) => marked === undefined || row.ingested > marked).map((r) => r.event.id),
    );
    const spans = runSpans(
      run,
      rows.map((row) => row.event),
      {
        logPrompts: found.logPrompts,
        patterns: found.patterns,
        tool: found.tracer.tool,
        root: !rootSent,
        fresh,
        now,
        idleMs,
      },
    );
    if (!options.dryRun) {
      try {
        const send = senderFor(found.tracer);
        for (const chunk of chunks(spans, SPANS_PER_REQUEST)) await send(chunk);
      } catch (error) {
        result.failed.push({ run, error: (error as Error).message });
        holdAt(candidate.first_new);
        continue;
      }
      const newest =
        rows
          .map((row) => row.ingested)
          .sort()
          .at(-1) ?? EPOCH;
      await writeTime(db, `${RUN_MARK_PREFIX}${run}`, newest);
    }
    result.sent.push({ run, team, spans });
  }

  if (useCursor && !options.dryRun) {
    // Just before the oldest event still to send; marks keep a re-read run from going twice.
    const next = hold === undefined ? upper : new Date(Date.parse(hold) - 1).toISOString();
    if (next > cursor) await writeTime(db, CURSOR_ID, next);
  }
  return result;
}

/** How a team's runs are sent under its selfhost.toml, or undefined when it names no tracer. */
export function exportSettings(config: ResolvedSelfhostConfig): RunExportSettings | undefined {
  const tracer = config.integrations.tracer;
  if (!tracer) return undefined;
  return { tracer, logPrompts: config.ledger.log_prompts, patterns: config.redaction };
}

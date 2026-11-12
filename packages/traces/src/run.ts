import { databaseOf, type Ledger } from "@selfhost/ledger";
import {
  type LedgerEvent,
  latestSecondOpinions,
  maskSecrets,
  type ResolvedSelfhostConfig,
  RUN_EVENTS_LIMIT_DEFAULT,
  RUN_SCHEMA,
  type RunHandoff,
  type RunPullRequest,
  type RunResponse,
  redactEvent,
  redactionSettings,
  SECOND_OPINION_EVENT_KIND,
  type SecondOpinion,
  secondOpinionOf,
} from "@selfhost/schema";
import { runEvents, runExported, teamOfRun } from "./export.js";
import { tracerRunUrl } from "./links.js";
import { summarizeRun } from "./summary.js";

export interface ReadRunOptions {
  now: Date;
  /** selfhost.toml in use for a team (null: events with no team). */
  configFor(team: string | null): Promise<ResolvedSelfhostConfig>;
  /** Whether the caller may read this team's events (null: events with no team). */
  canRead(team: string | null): Promise<boolean>;
  limit?: number;
  cursor?: string;
}

export type ReadRunResult =
  | { ok: true; response: RunResponse }
  | { ok: false; reason: "not_found" | "forbidden" | "invalid_cursor" };

const PR_STATE: Record<string, RunPullRequest["state"]> = {
  "pr.opened": "open",
  "pr.merged": "merged",
  "pr.closed": "closed",
};

const order = (a: LedgerEvent, b: LedgerEvent) =>
  Date.parse(a.ts) - Date.parse(b.ts) || a.id.localeCompare(b.id);

function encodeCursor(event: LedgerEvent): string {
  return Buffer.from(`${event.ts}|${event.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): Pick<LedgerEvent, "ts" | "id"> | undefined {
  const [ts = "", id = "", ...rest] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (rest.length > 0 || Number.isNaN(Date.parse(ts)) || !/^[0-9a-f-]{36}$/i.test(id)) {
    return undefined;
  }
  return { ts, id };
}

/**
 * The pull requests a run's events link to, with each one's state from its newest pr event and
 * the newest verdict of each AI reviewer on it.
 */
async function runPulls(ledger: Ledger, events: LedgerEvent[]): Promise<RunPullRequest[]> {
  const urls: string[] = [];
  for (const event of events) {
    const url =
      event.links?.pr_url ?? (event.target?.type === "pr" ? event.target.value : undefined);
    if (url && /^https?:\/\//.test(url) && !urls.includes(url)) urls.push(url);
  }
  if (urls.length === 0) return [];
  const rows = await databaseOf(ledger).query<{ url: string; kind: string }>(
    `SELECT coalesce(body#>>'{links,pr_url}', body#>>'{target,value}') AS url, kind
     FROM events
     WHERE kind IN ('pr.opened', 'pr.merged', 'pr.closed')
       AND coalesce(body#>>'{links,pr_url}', body#>>'{target,value}')
         IN (SELECT jsonb_array_elements_text($1::text::jsonb))
     ORDER BY ts, id`,
    [JSON.stringify(urls)],
  );
  const state = new Map<string, RunPullRequest["state"]>();
  for (const row of rows) state.set(row.url, PR_STATE[row.kind] ?? "open");
  const reviews = await databaseOf(ledger).query<{ url: string; body: unknown }>(
    `SELECT coalesce(body#>>'{links,pr_url}', body#>>'{target,value}') AS url, body
     FROM events
     WHERE kind = $2
       AND coalesce(body#>>'{links,pr_url}', body#>>'{target,value}')
         IN (SELECT jsonb_array_elements_text($1::text::jsonb))
     ORDER BY ts, id`,
    [JSON.stringify(urls), SECOND_OPINION_EVENT_KIND],
  );
  const opinions = new Map<string, SecondOpinion[]>();
  for (const row of reviews) {
    const body = typeof row.body === "string" ? JSON.parse(row.body) : row.body;
    const opinion = secondOpinionOf(body as LedgerEvent);
    if (opinion) opinions.set(row.url, [...(opinions.get(row.url) ?? []), opinion]);
  }
  return urls.map((url) => {
    const latest = latestSecondOpinions(opinions.get(url) ?? []);
    return {
      url,
      state: state.get(url) ?? "open",
      ...(latest.length > 0 ? { second_opinions: latest } : {}),
    };
  });
}

/** The run's handoffs, oldest first, each note masked under the team's current settings. */
export async function runHandoffs(
  ledger: Ledger,
  runId: string,
  settings: { patterns: readonly { name: string; pattern: string }[] },
): Promise<RunHandoff[]> {
  return (await ledger.handoffs.ofRun(runId)).map((h) => ({
    id: h.id,
    from: h.from,
    to: h.to,
    by: h.by,
    at: h.created_at,
    note: h.note === null ? null : maskSecrets(h.note, settings.patterns).text,
    state: h.state,
    taken_at: h.taken_at,
  }));
}

/**
 * One run for the console's run view, as GET /v1/runs/{run_id} answers. The run belongs to the
 * team most of its events belong to; a caller who cannot read that team gets forbidden, and
 * only events of teams they can read are shown. Every event is redacted again under its team's
 * current settings, so prompt text shows only while log_prompts is on.
 */
export async function readRun(
  ledger: Ledger,
  runId: string,
  options: ReadRunOptions,
): Promise<ReadRunResult> {
  const rows = await runEvents(databaseOf(ledger), runId);
  if (rows.length === 0) return { ok: false, reason: "not_found" };
  const team = teamOfRun(rows);
  if (!(await options.canRead(team))) return { ok: false, reason: "forbidden" };
  const readable = new Map<string | null, boolean>([[team, true]]);
  const settings = new Map<string | null, ReturnType<typeof redactionSettings>>();
  const visible: LedgerEvent[] = [];
  for (const row of rows) {
    if (!readable.has(row.team)) readable.set(row.team, await options.canRead(row.team));
    if (!readable.get(row.team)) continue;
    let found = settings.get(row.team);
    if (!found) {
      found = redactionSettings(await options.configFor(row.team));
      settings.set(row.team, found);
    }
    visible.push(redactEvent(row.event, found));
  }
  visible.sort(order);

  let start = 0;
  if (options.cursor !== undefined) {
    const after = decodeCursor(options.cursor);
    if (!after) return { ok: false, reason: "invalid_cursor" };
    start = visible.findIndex((event) => order(event, after as LedgerEvent) > 0);
    if (start === -1) start = visible.length;
  }
  const limit = options.limit ?? RUN_EVENTS_LIMIT_DEFAULT;
  const page = visible.slice(start, start + limit);
  const last = page.at(-1);
  const config = await options.configFor(team);
  const tracer = config.integrations.tracer;
  const exported = tracer?.run_url ? await runExported(ledger, runId) : false;
  return {
    ok: true,
    response: {
      schema: RUN_SCHEMA,
      run: summarizeRun(runId, visible, {
        now: options.now,
        team,
        config,
        cacheTip: {
          floor: config.alerts.cache_hit_floor ?? 0.5,
          minUsd: config.alerts.cache_tip_usd ?? 5,
        },
      }),
      events: page,
      next_cursor: last && start + limit < visible.length ? encodeCursor(last) : null,
      prs: await runPulls(ledger, visible),
      trace_url: exported ? (tracerRunUrl(tracer?.run_url, runId) ?? null) : null,
      handoffs: await runHandoffs(ledger, runId, redactionSettings(config)),
    },
  };
}

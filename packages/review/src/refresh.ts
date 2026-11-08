import {
  type Database,
  databaseOf,
  type Ledger,
  type Queryable,
  recordDecision,
  stableEventId,
} from "@selfhost/ledger";
import {
  type LedgerEvent,
  PERSON_VERDICTS,
  parseConfig,
  type ResolvedSelfhostConfig,
  type ReviewAnswer,
  type ReviewItem,
} from "@selfhost/schema";
import { actionsFor, type BuildContext, deliveryOf, mergeItem, newItem } from "./build.js";
import { decisionSubject, internalsOf, type ReviewList } from "./list.js";
import { buildPolicyReport } from "./policy-report.js";
import { routeItem } from "./routing.js";
import { closedPullRequest, draftFor } from "./signals.js";
import {
  claimItem,
  finishClaim,
  getItem,
  hasItemWithKey,
  insertItem,
  openItemByKey,
  openWaitingItems,
  releaseClaim,
  type StoredItem,
  updateItem,
} from "./store.js";

export interface RefreshOptions {
  /** selfhost.toml for events with no team policy. Default: the list's. */
  config?: ResolvedSelfhostConfig;
  /** Default: the list's clock. */
  now?: () => Date;
}

export interface RefreshResult {
  /** Items opened by this refresh, weekly reports included. */
  created: number;
  /** Items changed: a signal added, closed by later activity, answered elsewhere, timed out. */
  updated: number;
}

/** Who records a timeout's deny: selfhost itself, as a system actor. */
export const TIMEOUT_DECIDER = "selfhost";

const REVIEW_LOCK = 7_403_120_004;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Re-read this much before the last refresh, for events whose transaction committed late. */
const OVERLAP_MS = 10 * MINUTE_MS;
/** Older approvals, questions and alerts no longer need anyone. PRs and answers always count. */
const HORIZON_MS = 7 * DAY_MS;
const PAGE = 500;
const ATTEMPTS = 3;
const EPOCH = "1970-01-01T00:00:00.000Z";

const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const json = <T>(value: unknown) => (typeof value === "string" ? JSON.parse(value) : value) as T;
const later = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);
const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];

interface Run {
  now: Date;
  configFor: (team: string | null) => ResolvedSelfhostConfig;
  result: RefreshResult;
  persons: Map<string, string | undefined>;
}

/** Signals the list reads: everything that opens, adds to, closes or answers an item. */
const SIGNALS = `
SELECT e.id::text AS id, e.body, e.team, e.ingested_at FROM events e
WHERE e.ingested_at >= $1::timestamptz
  AND (e.kind IN ('pr.opened', 'pr.merged', 'pr.closed', 'decision.recorded')
    OR (e.ts >= $2::timestamptz AND (
      e.kind IN ('approval.requested', 'alert.raised')
      OR (e.kind = 'policy.evaluated'
        AND coalesce(e.body#>>'{decision,mode}', 'enforce') = 'enforce'
        AND e.body#>>'{decision,verdict}' IN ('block', 'ask')))))
  AND NOT EXISTS (SELECT 1 FROM review_signals s WHERE s.event_id = e.id)
ORDER BY e.ts, e.id
LIMIT $3`;

/**
 * The first event after a wait began that shows it is over: the person typed a prompt or the
 * session ended, or, for an approval, the tool it waited on ran. Only events up to the
 * deadline count: after it the approval has timed out.
 */
const RESOLVER = `
SELECT e.id::text AS id FROM events e
WHERE e.session_id = $1 AND coalesce(e.team, '') = $2 AND e.ts > $3::timestamptz
  AND ($4::timestamptz IS NULL OR e.ts <= $4::timestamptz)
  AND ($5::timestamptz IS NULL OR e.ts < $5::timestamptz)
  AND ((e.kind IN ('prompt.submitted', 'session.ended')
      AND coalesce(e.body#>>'{data,hook_event}', '') <> 'notify')
    OR ($6::boolean AND e.kind = 'tool.result'
      AND ($7::text IS NULL OR e.body#>>'{tool,name}' = $7::text)))
ORDER BY e.ts, e.id
LIMIT 1`;

async function teamConfigs(
  db: Queryable,
  defaults: ResolvedSelfhostConfig,
): Promise<(team: string | null) => ResolvedSelfhostConfig> {
  const rows = await db.query<{ id: string; policy_text: string }>(
    "SELECT id, policy_text FROM teams WHERE policy_text IS NOT NULL",
  );
  const configs = new Map<string, ResolvedSelfhostConfig>();
  for (const row of rows) {
    const parsed = parseConfig(row.policy_text);
    if (parsed.ok) configs.set(row.id, parsed.config);
  }
  return (team) => (team === null ? defaults : (configs.get(team) ?? defaults));
}

/** The person a session belongs to: the actor of its first event written as a person. */
async function sessionPerson(
  tx: Queryable,
  team: string | null,
  sessionId: string | undefined,
  run: Run,
): Promise<string | undefined> {
  if (sessionId === undefined) return undefined;
  const key = `${team ?? ""}\n${sessionId}`;
  if (run.persons.has(key)) return run.persons.get(key);
  const [row] = await tx.query<{ actor_id: string }>(
    `SELECT actor_id FROM events
     WHERE session_id = $1 AND actor_kind = 'person' AND coalesce(team, '') = $2
     ORDER BY ts, id LIMIT 1`,
    [sessionId, team ?? ""],
  );
  run.persons.set(key, row?.actor_id);
  return row?.actor_id;
}

async function firstResolver(
  tx: Queryable,
  stored: StoredItem,
  before?: string,
): Promise<string | undefined> {
  const { item } = stored;
  if (!item.session_id) return undefined;
  const [row] = await tx.query<{ id: string }>(RESOLVER, [
    item.session_id,
    stored.team ?? "",
    stored.signalAt,
    item.deadline ?? null,
    before ?? null,
    item.kind === "approval",
    stored.tool ?? null,
  ]);
  return row?.id;
}

/** Closes an item because of a ledger event, which joins its source events. */
async function close(
  tx: Queryable,
  stored: StoredItem,
  eventId: string,
  run: Run,
  state: ReviewItem["state"],
  answer?: ReviewAnswer,
): Promise<boolean> {
  const item: ReviewItem = {
    ...stored.item,
    state,
    updated_at: run.now.toISOString(),
    source_event_ids: union(stored.item.source_event_ids, [eventId]),
    ...(answer ? { answer } : {}),
  };
  const written = await updateItem(tx, { ...stored, item });
  if (written) run.result.updated += 1;
  return written;
}

/** A decision recorded on another path (POST /v1/decisions, selfhost decide, GitHub, chat). */
async function applyDecision(
  tx: Queryable,
  event: LedgerEvent,
  team: string | null,
  run: Run,
): Promise<string | undefined> {
  const decision = event.decision;
  if (!decision || event.actor.kind !== "person") return undefined;
  if (!(PERSON_VERDICTS as readonly string[]).includes(decision.verdict)) return undefined;
  const itemId = decision.item_id ?? event.links?.item_id;
  let stored: StoredItem | undefined;
  if (itemId) {
    stored = await getItem(tx, itemId, {});
    // A person token's decision answers only its own team's items.
    if (stored && team !== null && stored.team !== team) stored = undefined;
  } else if (event.links?.pr_url) {
    stored = await openItemByKey(tx, team, `pr:${event.links.pr_url}`);
  }
  if (!stored) return undefined;
  const answer: ReviewAnswer = {
    by: decision.by ?? event.actor.id,
    verdict: decision.verdict,
    ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    at: event.ts,
    decision_event_id: event.id,
  };
  const { item } = stored;
  const replaces =
    item.state === "answered" &&
    decision.replaces_event_id !== undefined &&
    item.answer?.decision_event_id.toLowerCase() === decision.replaces_event_id.toLowerCase();
  if (item.state === "open" || replaces) {
    await close(tx, stored, event.id, run, "answered", answer);
  }
  return item.id;
}

/** Opens an item for the signal, or adds the signal to the open item with its key. */
async function applyDraft(
  tx: Queryable,
  event: LedgerEvent,
  team: string | null,
  run: Run,
): Promise<string | undefined> {
  const draft = draftFor(event);
  if (!draft) return undefined;
  const ctx: BuildContext = {
    config: run.configFor(team),
    now: run.now,
    team,
    ...(draft.person
      ? {}
      : { sessionPerson: await sessionPerson(tx, team, event.session_id, run) }),
  };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    let open = await openItemByKey(tx, team, draft.dedupeKey);
    // A signal that names its own item replaces an open one with another id: the agent and the
    // person were told the new id.
    if (open && draft.id !== undefined && open.item.id !== draft.id) {
      if (!(await close(tx, open, event.id, run, "dismissed"))) continue;
      open = undefined;
    }
    // A wait that ended before this signal is over; the signal starts a new one.
    if (open && draft.blocking && open.item.blocking) {
      const resolver = await firstResolver(tx, open, event.ts);
      if (resolver) {
        if (!(await close(tx, open, resolver, run, "dismissed"))) continue;
        open = undefined;
      }
    }
    if (!open) {
      // The item a signal names may exist already, closed; the signal belongs to it.
      if (draft.id !== undefined && (await getItem(tx, draft.id, {}))) return draft.id;
      const item = newItem(draft, event, ctx);
      await insertItem(tx, {
        item,
        team,
        dedupeKey: draft.dedupeKey,
        signalAt: item.created_at,
        ...(draft.tool ? { tool: draft.tool } : {}),
        paths: draft.paths,
      });
      run.result.created += 1;
      return item.id;
    }
    const paths = union(open.paths, draft.paths);
    const item = mergeItem(open.item, paths, draft, event, ctx);
    const tool = open.tool ?? draft.tool;
    const written = await updateItem(tx, {
      ...open,
      item,
      paths,
      signalAt: later(open.signalAt, iso(event.ts)),
      ...(tool ? { tool } : {}),
    });
    if (written) {
      run.result.updated += 1;
      return item.id;
    }
  }
  return undefined;
}

async function applySignal(
  tx: Queryable,
  event: LedgerEvent,
  team: string | null,
  run: Run,
): Promise<string | undefined> {
  if (event.kind === "decision.recorded") return applyDecision(tx, event, team, run);
  const closedPr = closedPullRequest(event);
  if (closedPr) {
    const open = await openItemByKey(tx, team, `pr:${closedPr}`);
    if (open) await close(tx, open, event.id, run, "dismissed");
    return open?.item.id;
  }
  return applyDraft(tx, event, team, run);
}

/** Reads every signal the list has not read yet, oldest first. */
async function readSignals(tx: Queryable, run: Run): Promise<void> {
  const [progress] = await tx.query<{ ingested_at: unknown }>(
    "SELECT ingested_at FROM review_progress WHERE id = 'ledger'",
  );
  const last = progress ? iso(progress.ingested_at) : undefined;
  const from = last ? new Date(Date.parse(last) - OVERLAP_MS).toISOString() : EPOCH;
  const horizon = new Date(run.now.getTime() - HORIZON_MS).toISOString();
  let newest = last;
  for (;;) {
    const rows = await tx.query<{
      id: string;
      body: unknown;
      team: string | null;
      ingested_at: unknown;
    }>(SIGNALS, [from, horizon, PAGE]);
    if (rows.length === 0) break;
    for (const row of rows) {
      const itemId = await applySignal(tx, json<LedgerEvent>(row.body), row.team, run);
      await tx.query(
        `INSERT INTO review_signals (event_id, item_id) VALUES ($1::uuid, $2::uuid)
         ON CONFLICT (event_id) DO NOTHING`,
        [row.id, itemId ?? null],
      );
      const ingested = iso(row.ingested_at);
      if (newest === undefined || ingested > newest) newest = ingested;
    }
  }
  if (newest !== undefined && newest !== last) {
    await tx.query(
      `INSERT INTO review_progress (id, ingested_at) VALUES ('ledger', $1::timestamptz)
       ON CONFLICT (id) DO UPDATE SET ingested_at = EXCLUDED.ingested_at`,
      [newest],
    );
  }
}

/** Closes approvals and questions whose session moved on before their deadline. */
async function endWaits(tx: Queryable, run: Run): Promise<void> {
  for (const stored of await openWaitingItems(tx)) {
    const resolver = await firstResolver(tx, stored);
    if (resolver) await close(tx, stored, resolver, run, "dismissed");
  }
}

/** Monday 00:00 UTC of the week `now` falls in. */
export function weekStart(now: Date): Date {
  const day = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  return new Date(day - ((now.getUTCDay() + 6) % 7) * DAY_MS);
}

/**
 * The weekly would-block report: once a week (Monday to Monday, UTC) has ended, one
 * policy_report item per team scope whose rules in observe mode fired that week.
 */
async function weeklyReports(tx: Queryable, run: Run): Promise<void> {
  const until = weekStart(run.now);
  const since = new Date(until.getTime() - 7 * DAY_MS);
  const key = `policy_report:${since.toISOString()}`;
  const observed = `kind = 'policy.evaluated' AND ts >= $1::timestamptz AND ts < $2::timestamptz
    AND body#>>'{decision,mode}' = 'observe' AND body#>>'{decision,verdict}' IN ('block', 'ask')`;
  const scopes = await tx.query<{ team: string }>(
    `SELECT DISTINCT coalesce(team, '') AS team FROM events WHERE ${observed} ORDER BY 1`,
    [since.toISOString(), until.toISOString()],
  );
  for (const { team: scope } of scopes) {
    const team = scope === "" ? null : scope;
    if (await hasItemWithKey(tx, team, key)) continue;
    const rows = await tx.query<{ body: unknown }>(
      `SELECT body FROM events WHERE ${observed} AND coalesce(team, '') = $3 ORDER BY ts, id`,
      [since.toISOString(), until.toISOString(), scope],
    );
    const config = run.configFor(team);
    const report = buildPolicyReport(
      rows.map((row) => json<LedgerEvent>(row.body)),
      { since, until, now: run.now, rules: config.rules },
    );
    if (report.source_event_ids.length === 0) continue;
    const { owners, route } = routeItem(config, { paths: [] });
    const item: ReviewItem = {
      ...report,
      id: stableEventId(since.toISOString(), `review_item\n${scope}\n${key}`),
      owners,
      why: {
        signal: "policy.evaluated",
        text: "Rules in observe mode record what they would have blocked; this is last week's.",
      },
      actions: actionsFor("policy_report", undefined),
      delivery: deliveryOf(report, config),
      route,
    };
    await insertItem(tx, { item, team, dedupeKey: key, signalAt: until.toISOString(), paths: [] });
    run.result.created += 1;
  }
}

/**
 * Denies every blocking approval past its deadline: one decision.recorded event each, by
 * selfhost with surface timeout. The id comes from the item and the deadline, so a second
 * refresh (or a second server) writes nothing new.
 */
async function applyTimeouts(ledger: Ledger, db: Database, run: Run): Promise<void> {
  const due = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM review_items
     WHERE state = 'open' AND blocking AND deadline <= $1::timestamptz
     ORDER BY deadline, id`,
    [run.now.toISOString()],
  );
  for (const { id } of due) {
    const claimed = await claimItem(db, id, {});
    const deadline = claimed?.item.deadline;
    if (!claimed || !deadline) continue;
    const minutes = Math.round(
      (Date.parse(deadline) - Date.parse(claimed.item.created_at)) / MINUTE_MS,
    );
    let decision: Awaited<ReturnType<typeof recordDecision>>;
    try {
      decision = await recordDecision(
        ledger,
        {
          verdict: "deny",
          by: TIMEOUT_DECIDER,
          reason: `Nobody answered within ${minutes} minutes, so the approval timed out and was denied.`,
          ...decisionSubject(claimed),
          surface: "timeout",
          key: `review-timeout:${id}`,
          ts: deadline,
        },
        { system: true, source: "server" },
      );
    } catch (error) {
      await releaseClaim(db, claimed);
      throw error;
    }
    const { event } = decision;
    const item: ReviewItem = {
      ...claimed.item,
      state: "expired",
      updated_at: run.now.toISOString(),
      answer: {
        by: TIMEOUT_DECIDER,
        verdict: "deny",
        ...(event.decision?.reason !== undefined ? { reason: event.decision.reason } : {}),
        at: event.ts,
        decision_event_id: event.id,
      },
    };
    if (await finishClaim(db, { ...claimed, item })) run.result.updated += 1;
  }
}

/**
 * Brings the list up to date with the ledger: opens items for new signals (deduplicated by key,
 * grouped by run), adds repeats to the open item, closes items whose PR merged or closed or
 * whose session moved on, applies answers recorded on other paths, files last week's would-block
 * report and denies blocking approvals past their deadline. Safe to run often and from several
 * processes: every signal is read once, and refreshes take turns.
 */
export async function refreshReviewList(
  ledger: Ledger,
  list: ReviewList,
  options: RefreshOptions = {},
): Promise<RefreshResult> {
  const internals = internalsOf(list);
  const db = databaseOf(ledger);
  const run: Run = {
    now: (options.now ?? internals.now)(),
    configFor: await teamConfigs(db, options.config ?? internals.config),
    result: { created: 0, updated: 0 },
    persons: new Map(),
  };
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [REVIEW_LOCK]);
    await readSignals(tx, run);
    await endWaits(tx, run);
    await weeklyReports(tx, run);
  });
  await applyTimeouts(ledger, db, run);
  return run.result;
}

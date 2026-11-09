import {
  IDLE_SHARE_SUGGESTION,
  type LedgerEvent,
  RUNTIME_LEFTOVER_MINUTES,
  SANDBOX_WASTE_WINDOWS,
  type SandboxBilling,
  type SandboxLeftover,
  type SandboxRecord,
  type SandboxRuntimeWaste,
  type SandboxRunWaste,
  type SandboxWasteResponse,
  type SandboxWasteWindow,
  sandboxRecordValidator,
} from "@selfhost/schema";

const DAY_MS = 86_400_000;

/** The names a suggestion uses for each runtime. */
const RUNTIME_NAMES: Record<string, string> = {
  e2b: "E2B",
  daytona: "Daytona",
  modal: "Modal",
  coder: "Coder",
  opensandbox: "OpenSandbox",
};

/** Alerts that end a run as far as its sandbox is concerned: it failed or got stuck. */
const RUN_END_ALERTS = new Set(["run_failed", "run_stuck"]);

/** One sandbox's life, joined from its sandbox.started and sandbox.stopped events. */
export interface SandboxSpan {
  sandbox_id: string;
  runtime: string;
  run_id: string | null;
  team: string | null;
  owner: string | null;
  billing: SandboxBilling;
  started: number;
  /** undefined while it runs. */
  stopped?: number;
  usd_per_hour?: number;
  /** From sandbox.stopped: what it cost in all, and how its billed seconds split. */
  cost_usd?: number;
  billed_seconds?: number;
  busy_seconds?: number;
  idle_seconds?: number;
  /** When its run ended: from sandbox.stopped, else the run's own events. */
  run_ended?: number;
  reason?: string;
}

const isPerson = (value: unknown): value is string => typeof value === "string" && value !== "";

function recordOf(event: LedgerEvent): SandboxRecord | undefined {
  const checked = sandboxRecordValidator.validate(event.data?.sandbox);
  return checked.ok ? checked.value : undefined;
}

/**
 * When each run ended: its session.ended, or an alert.raised run_failed or run_stuck from run
 * health, whichever came first.
 */
export function runEnds(events: Iterable<LedgerEvent>): Map<string, number> {
  const ends = new Map<string, number>();
  for (const event of events) {
    if (!event.run_id) continue;
    const ended =
      event.kind === "session.ended" ||
      (event.kind === "alert.raised" && RUN_END_ALERTS.has(String(event.data?.alert ?? "")));
    if (!ended) continue;
    const at = Date.parse(event.ts);
    const known = ends.get(event.run_id);
    if (known === undefined || at < known) ends.set(event.run_id, at);
  }
  return ends;
}

/** Every sandbox in the events, by id. A stop without a start is kept, started at its stop. */
export function sandboxSpans(events: Iterable<LedgerEvent>): Map<string, SandboxSpan> {
  const list = [...events];
  const ends = runEnds(list);
  const spans = new Map<string, SandboxSpan>();
  const sorted = list
    .filter((event) => event.kind === "sandbox.started" || event.kind === "sandbox.stopped")
    .sort((a, b) => a.ts.localeCompare(b.ts));
  for (const event of sorted) {
    const record = recordOf(event);
    if (!record) continue;
    const at = Date.parse(event.ts);
    const span: SandboxSpan = spans.get(record.sandbox_id) ?? {
      sandbox_id: record.sandbox_id,
      runtime: record.runtime,
      run_id: event.run_id ?? null,
      team: event.team ?? null,
      owner: isPerson(event.data?.owner) ? event.data.owner : null,
      billing: record.billing ?? "reserved",
      started: at,
    };
    span.run_id ??= event.run_id ?? null;
    span.team ??= event.team ?? null;
    if (!span.owner && isPerson(event.data?.owner)) span.owner = event.data.owner;
    if (record.usd_per_hour !== undefined) span.usd_per_hour = record.usd_per_hour;
    if (record.billing) span.billing = record.billing;
    if (event.kind === "sandbox.stopped") {
      span.stopped = at;
      span.cost_usd = event.cost?.usd ?? 0;
      if (record.billed_seconds !== undefined) span.billed_seconds = record.billed_seconds;
      if (record.busy_seconds !== undefined) span.busy_seconds = record.busy_seconds;
      if (record.idle_seconds !== undefined) span.idle_seconds = record.idle_seconds;
      if (record.reason) span.reason = record.reason;
      if (record.run_ended_at) span.run_ended = Date.parse(record.run_ended_at);
    }
    spans.set(record.sandbox_id, span);
  }
  for (const span of spans.values()) {
    if (span.run_ended === undefined && span.run_id) {
      const ended = ends.get(span.run_id);
      if (ended !== undefined) span.run_ended = ended;
    }
  }
  return spans;
}

/** End of a span: its stop, else now. */
const endOf = (span: SandboxSpan, now: number) => span.stopped ?? Math.max(now, span.started);

/** Seconds billed: the provider's count once stopped, else wall time so far. */
function billedSeconds(span: SandboxSpan, now: number): number {
  return span.billed_seconds ?? Math.max(0, (endOf(span, now) - span.started) / 1000);
}

/** Cost of a whole span: the stop's cost, else its list price times the time so far. */
export function spanCost(span: SandboxSpan, now: number): number {
  if (span.cost_usd !== undefined) return span.cost_usd;
  if (span.usd_per_hour === undefined) return 0;
  return (billedSeconds(span, now) * span.usd_per_hour) / 3600;
}

/**
 * Share of a span's billed time that bought nothing: its idle seconds once stopped; while it
 * runs, the time since its run ended (what happens before that is not known yet).
 */
function idleRatio(span: SandboxSpan, now: number): number {
  const billed = billedSeconds(span, now);
  if (billed <= 0) return 0;
  if (span.idle_seconds !== undefined) return Math.min(1, span.idle_seconds / billed);
  if (span.run_ended === undefined) return 0;
  const after = Math.max(0, (endOf(span, now) - Math.max(span.run_ended, span.started)) / 1000);
  return Math.min(1, after / billed);
}

/** Share of a span inside [from, to). */
function overlap(span: SandboxSpan, from: number, to: number, now: number): number {
  const end = endOf(span, now);
  const length = end - span.started;
  if (length <= 0) return span.started >= from && span.started < to ? 1 : 0;
  const inside = Math.min(end, to) - Math.max(span.started, from);
  return Math.max(0, inside) / length;
}

/**
 * Sandbox spend inside [from, to), each sandbox's cost split by how much of its life falls in
 * the range. Running ones count at list price up to now. Used for the daily runtime cap.
 */
export function sandboxSpendIn(
  spans: Iterable<SandboxSpan>,
  from: Date,
  to: Date,
  now: Date,
  exclude: ReadonlySet<string> = new Set(),
): number {
  let usd = 0;
  for (const span of spans) {
    if (exclude.has(span.sandbox_id)) continue;
    usd +=
      spanCost(span, now.getTime()) * overlap(span, from.getTime(), to.getTime(), now.getTime());
  }
  return round(usd);
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;
const share = (part: number, whole: number) => (whole > 0 ? Math.min(1, part / whole) : 0);

function suggestion(row: Omit<SandboxRuntimeWaste, "suggestion">, days: number) {
  if (row.billing !== "reserved" || row.idle_share <= IDLE_SHARE_SUGGESTION || row.idle_usd <= 0) {
    return null;
  }
  const monthly = round((row.idle_usd * 30) / days);
  const name = RUNTIME_NAMES[row.runtime] ?? row.runtime;
  return {
    text: `${name} bills the CPU and memory a sandbox holds while it runs, and ${Math.round(row.idle_share * 100)}% of it was idle in the last ${days} days. A provider that bills active CPU only (Vercel Sandbox, Cloudflare Sandbox, Fly Sprites, Upstash Box), or pausing sandboxes while the agent waits on the model, would save about $${monthly.toFixed(2)} a month.`,
    monthly_saving_usd: monthly,
  };
}

function windowOf(spans: SandboxSpan[], days: number, now: number): SandboxWasteWindow {
  const from = now - days * DAY_MS;
  const rows = new Map<string, Omit<SandboxRuntimeWaste, "suggestion">>();
  for (const span of spans) {
    const part = overlap(span, from, now + 1, now);
    if (part <= 0) continue;
    const row = rows.get(span.runtime) ?? {
      runtime: span.runtime,
      billing: span.billing,
      sandboxes: 0,
      billed_seconds: 0,
      idle_seconds: 0,
      billed_usd: 0,
      idle_usd: 0,
      idle_share: 0,
    };
    const ratio = idleRatio(span, now);
    const cost = spanCost(span, now) * part;
    const seconds = billedSeconds(span, now) * part;
    row.sandboxes += 1;
    row.billed_seconds += seconds;
    row.idle_seconds += seconds * ratio;
    row.billed_usd += cost;
    row.idle_usd += cost * ratio;
    rows.set(span.runtime, row);
  }
  const byRuntime = [...rows.values()]
    .map((row) => {
      const done = {
        ...row,
        billed_seconds: Math.round(row.billed_seconds),
        idle_seconds: Math.round(row.idle_seconds),
        billed_usd: round(row.billed_usd),
        idle_usd: round(row.idle_usd),
        idle_share: share(row.idle_usd, row.billed_usd),
      };
      return { ...done, suggestion: suggestion(done, days) };
    })
    .sort((a, b) => b.billed_usd - a.billed_usd || a.runtime.localeCompare(b.runtime));
  const billed = byRuntime.reduce((sum, row) => sum + row.billed_usd, 0);
  const idle = byRuntime.reduce((sum, row) => sum + row.idle_usd, 0);
  return {
    days,
    billed_usd: round(billed),
    idle_usd: round(idle),
    idle_share: share(idle, billed),
    by_runtime: byRuntime,
  };
}

/** Sandboxes that ran at least `minutes` past the end of their run, running ones first. */
export function leftovers(
  spans: Iterable<SandboxSpan>,
  now: Date,
  minutes: number = RUNTIME_LEFTOVER_MINUTES,
  sinceDays = 30,
): SandboxLeftover[] {
  const at = now.getTime();
  const since = at - sinceDays * DAY_MS;
  const out: SandboxLeftover[] = [];
  for (const span of spans) {
    if (span.run_ended === undefined) continue;
    const end = endOf(span, at);
    if (end < since) continue;
    const after = (end - Math.max(span.run_ended, span.started)) / 60_000;
    if (after < minutes) continue;
    const cost = spanCost(span, at);
    const billed = billedSeconds(span, at);
    out.push({
      sandbox_id: span.sandbox_id,
      runtime: span.runtime,
      run_id: span.run_id,
      owner: span.owner,
      started_at: new Date(span.started).toISOString(),
      run_ended_at: new Date(span.run_ended).toISOString(),
      stopped_at: span.stopped === undefined ? null : new Date(span.stopped).toISOString(),
      minutes_after_run: Math.round(after * 10) / 10,
      cost_usd: round(cost),
      after_run_usd: round(billed > 0 ? cost * Math.min(1, (after * 60) / billed) : 0),
    });
  }
  return out.sort(
    (a, b) =>
      Number(a.stopped_at !== null) - Number(b.stopped_at !== null) ||
      b.after_run_usd - a.after_run_usd,
  );
}

export interface SandboxWasteOptions {
  now: Date;
  team?: string | null;
  /** Default: RUNTIME_LEFTOVER_MINUTES (15). */
  leftoverMinutes?: number;
}

/**
 * The sandbox waste report: idle share of sandbox cost per runtime for 7 and 30 days, with a
 * cheaper billing model where more than half was idle on a runtime that bills reserved time;
 * sandboxes left running past their run; and each recent run's sandbox cost next to its model
 * cost. Pass sandbox.started and sandbox.stopped events, the runs' cost.recorded events and the
 * events that end runs (session.ended, alert.raised).
 */
export function sandboxWaste(
  events: Iterable<LedgerEvent>,
  options: SandboxWasteOptions,
): SandboxWasteResponse {
  const list = [...events];
  const now = options.now.getTime();
  const minutes = options.leftoverMinutes ?? RUNTIME_LEFTOVER_MINUTES;
  const spans = [...sandboxSpans(list).values()];
  const modelUsd = new Map<string, number>();
  for (const event of list) {
    if (event.kind === "cost.recorded" && event.run_id && event.cost) {
      modelUsd.set(event.run_id, (modelUsd.get(event.run_id) ?? 0) + event.cost.usd);
    }
  }
  const runs = new Map<string, SandboxRunWaste>();
  const recent = now - 7 * DAY_MS;
  for (const span of spans) {
    if (!span.run_id || endOf(span, now) < recent) continue;
    const row = runs.get(span.run_id) ?? {
      run_id: span.run_id,
      runtime: span.runtime,
      billed_seconds: 0,
      busy_seconds: 0,
      idle_seconds: 0,
      sandbox_usd: 0,
      model_usd: round(modelUsd.get(span.run_id) ?? 0),
    };
    const billed = billedSeconds(span, now);
    const idle = span.idle_seconds ?? billed * idleRatio(span, now);
    row.billed_seconds += Math.round(billed);
    row.idle_seconds += Math.round(idle);
    row.busy_seconds += Math.round(span.busy_seconds ?? Math.max(0, billed - idle));
    row.sandbox_usd = round(row.sandbox_usd + spanCost(span, now));
    runs.set(span.run_id, row);
  }
  return {
    team: options.team ?? null,
    generated_at: options.now.toISOString(),
    leftover_minutes: minutes,
    windows: SANDBOX_WASTE_WINDOWS.map((days) => windowOf(spans, days, now)),
    leftovers: leftovers(spans, options.now, minutes),
    runs: [...runs.values()].sort((a, b) => b.sandbox_usd - a.sandbox_usd),
  };
}

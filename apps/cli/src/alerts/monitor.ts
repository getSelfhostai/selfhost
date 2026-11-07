import type { LedgerWriter } from "@selfhost/importers";
import type { Ledger } from "@selfhost/ledger";
import type { LedgerEvent } from "@selfhost/schema";
import { oneSourcePerSession } from "@selfhost/spend";
import { cacheFrom, writeCache } from "./cache.js";
import { check, historyStart } from "./check.js";
import {
  type AlertIo,
  loadAlertSettings,
  readEvents,
  readTiers,
  statuslineCachePath,
} from "./settings.js";
import { suggestionText } from "./text.js";

/** A check runs at most this often while batches keep coming. */
export const MIN_CHECK_INTERVAL_MS = 15_000;

/** The fields of data the forecast and the spike detector read; the rest is dropped. */
const DATA_FIELDS = ["key_alias", "gateway", "runtime", "alert", "window", "resets_at"];

/** A small copy of an event, so weeks of history stay cheap to hold in memory. */
function compact(event: LedgerEvent): LedgerEvent {
  const data = event.data
    ? Object.fromEntries(
        DATA_FIELDS.filter((key) => key in (event.data ?? {})).map((key) => [
          key,
          event.data?.[key],
        ]),
      )
    : undefined;
  return {
    id: event.id,
    schema: event.schema,
    ts: event.ts,
    source: event.source,
    kind: event.kind,
    actor: { kind: event.actor.kind, id: event.actor.id },
    ...(event.agent ? { agent: { vendor: event.agent.vendor } } : {}),
    ...(event.session_id ? { session_id: event.session_id } : {}),
    ...(event.cost ? { cost: event.cost } : {}),
    ...(data && Object.keys(data).length > 0 ? { data } : {}),
  };
}

const watched = (event: LedgerEvent) =>
  event.kind === "cost.recorded" || event.kind === "alert.raised";

export interface MonitorOptions extends Pick<AlertIo, "env" | "configPath" | "write"> {
  /** The person whose logs this watcher imports. */
  person: string;
  json?: boolean;
  cwd?: string;
  cachePath?: string;
  /** The clock; tests pass their own. */
  now?: () => Date;
  minIntervalMs?: number;
}

export interface Monitor {
  /** A writer that hands every accepted event to the monitor on its way to the ledger. */
  tap(writer: LedgerWriter): LedgerWriter;
  /** Schedules a check: right away, or once the minimum interval has passed. */
  check(): void;
  /** Waits for a running check and stops scheduling new ones. */
  close(): Promise<void>;
}

/**
 * Keeps `selfhost import --watch` checking as it imports: after each batch it forecasts the
 * person's plan limits and looks for spend spikes, records new limit_forecast and spend_spike
 * alerts, prints them, and rewrites the statusline cache. History is read from the ledger once,
 * then kept in memory from the batches the watcher writes.
 */
export async function startMonitor(ledger: Ledger, opts: MonitorOptions): Promise<Monitor> {
  const clock = opts.now ?? (() => new Date());
  const io = { env: opts.env, configPath: opts.configPath, cwd: opts.cwd ?? process.cwd() };
  const settings = loadAlertSettings(io, undefined, false);
  const cachePath = opts.cachePath ?? statuslineCachePath(io);
  const minInterval = opts.minIntervalMs ?? MIN_CHECK_INTERVAL_MS;
  const from = historyStart(settings, clock());
  let events = [
    ...(await readEvents(ledger, "cost.recorded", from)),
    ...(await readEvents(ledger, "alert.raised", from)),
  ].map(compact);
  const raised = new Set(events.filter((event) => event.kind === "alert.raised").map((e) => e.id));
  let sink: LedgerWriter = ledger;
  let last = Number.NEGATIVE_INFINITY;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  let closed = false;
  let failed: string | undefined;

  const say = (event: LedgerEvent, lines: string[]) => {
    if (opts.json) opts.write(JSON.stringify({ schema: "selfhost.alert/v1", event }));
    else for (const line of lines) opts.write(line);
  };

  async function run(): Promise<void> {
    last = Date.now();
    const now = clock();
    try {
      const start = historyStart(settings, now).getTime();
      events = events.filter((event) => Date.parse(event.ts) >= start);
      const result = check(oneSourcePerSession(events), {
        person: opts.person,
        now,
        since: new Date(now.getTime() - 60 * 60_000),
        settings,
        tiers: readTiers(opts.configPath),
      });
      const fresh = [
        ...result.warnings.map((warning) => ({
          event: warning.event,
          lines: [
            `Limit warning: ${String(warning.event.data?.message)}`,
            ...(warning.forecast.suggestion
              ? [`  Fix: ${suggestionText(warning.forecast.suggestion, now)}`]
              : []),
          ],
        })),
        ...result.alarms.map(({ event }) => ({
          event,
          lines: [
            `SPEND ALARM: ${String(event.data?.message)}`,
            ...((event.data?.actions ?? []) as { label: string; url?: string }[]).map(
              (action) => `  - ${action.label}${action.url ? `: ${action.url}` : ""}`,
            ),
          ],
        })),
      ].filter(({ event }) => !raised.has(event.id));
      if (fresh.length > 0) {
        await sink.append(fresh.map(({ event }) => event));
        for (const { event, lines } of fresh) {
          raised.add(event.id);
          say(event, lines);
        }
      }
      writeCache(cachePath, cacheFrom(result, opts.person, now, process.pid));
      failed = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== failed) opts.write(`Alert check failed: ${message}`);
      failed = message;
    }
  }

  function schedule(): void {
    if (closed || timer) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        running = running.then(run);
      },
      Math.max(0, last + minInterval - Date.now()),
    );
    timer.unref?.();
  }

  running = run();
  await running;

  return {
    tap(writer) {
      sink = writer;
      return {
        async append(batch) {
          const result = await writer.append(batch);
          const accepted = new Set(result.accepted);
          for (const event of batch) {
            if (accepted.has(event.id) && watched(event)) events.push(compact(event));
          }
          return result;
        },
      };
    },
    check: schedule,
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await running;
    },
  };
}

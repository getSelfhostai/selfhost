import { databaseOf, type Ledger, LedgerValidationError, stableEventId } from "@selfhost/ledger";
import type { LedgerEvent, ResolvedSelfhostConfig } from "@selfhost/schema";
import { cacheAlert, cacheDrops, oneSourcePerSession, sessionCaches } from "@selfhost/spend";
import { teamConfig } from "./runs.js";

/** How far back a check reads a session's requests. */
const LOOKBACK_MS = 6 * 60 * 60_000;
/** Only sessions with a request this recent raise an alert: the ones still running. */
const ACTIVE_MS = 60 * 60_000;
export const CACHE_ALERT_INTERVAL_MS = 60_000;

const json = <T>(value: unknown) => (typeof value === "string" ? JSON.parse(value) : value) as T;

/**
 * Cache alerts from the requests in the ledger, whatever sent them (OpenTelemetry, a laptop's
 * sync, the gateway): a session past [alerts] cache_min_requests whose recent prompt cache hit
 * rate fell under cache_hit_floor gets one alert.raised event (data.alert "cache_hit_low") in
 * its team, naming the usual causes. Laptops raise the same alert for their own sessions with
 * the same id, so a session gets one either way. Returns the alerts written.
 */
export async function raiseCacheAlerts(
  ledger: Ledger,
  now: Date,
  options: { config?: ResolvedSelfhostConfig } = {},
): Promise<number> {
  const rows = await databaseOf(ledger).query<{ body: unknown; team: string | null }>(
    `SELECT body, team FROM events
     WHERE kind = 'cost.recorded' AND ts >= $1::timestamptz AND ts <= $2::timestamptz
     ORDER BY ts, id`,
    [new Date(now.getTime() - LOOKBACK_MS).toISOString(), now.toISOString()],
  );
  const byTeam = new Map<string | null, LedgerEvent[]>();
  for (const row of rows) {
    const list = byTeam.get(row.team) ?? [];
    list.push(json<LedgerEvent>(row.body));
    byTeam.set(row.team, list);
  }
  const configOf = teamConfig(ledger, options.config);
  let raised = 0;
  for (const [team, events] of byTeam) {
    const { alerts } = await configOf(team);
    const floor = alerts.cache_hit_floor ?? 0.5;
    const drops = cacheDrops(sessionCaches(oneSourcePerSession(events)), {
      floor,
      minRequests: alerts.cache_min_requests ?? 20,
      since: new Date(now.getTime() - ACTIVE_MS),
    });
    if (drops.length === 0) continue;
    const found = drops.map((session) => cacheAlert(session, floor, now, stableEventId, "server"));
    try {
      const result = await ledger.append(found, team === null ? {} : { team });
      raised += result.accepted.length;
    } catch (error) {
      if (!(error instanceof LedgerValidationError)) throw error;
    }
  }
  return raised;
}

export interface CacheAlertJob {
  run(): Promise<number | undefined>;
  stop(): void;
}

/** raiseCacheAlerts every minute. A failed pass is logged and the next one runs as usual. */
export function startCacheAlertJob(
  ledger: Ledger,
  options: {
    config?: ResolvedSelfhostConfig;
    intervalMs?: number;
    log?: (line: string) => void;
    now?: () => Date;
  } = {},
): CacheAlertJob {
  const { intervalMs = CACHE_ALERT_INTERVAL_MS, log = console.log } = options;
  let running: Promise<number | undefined> | undefined;
  const run = () => {
    running ??= raiseCacheAlerts(ledger, options.now?.() ?? new Date(), options)
      .then(
        (raised) => {
          if (raised > 0) log(`cache alerts: ${raised} raised`);
          return raised;
        },
        (error: unknown) => {
          log(`cache alerts: failed: ${error instanceof Error ? error.message : error}`);
          return undefined;
        },
      )
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return { run, stop: () => clearInterval(timer) };
}

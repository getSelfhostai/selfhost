import {
  envSecretRefusal,
  type SecretScope,
  secretScopeFromEnv,
  teamEnvPrefix,
} from "@selfhost/credentials";
import type { Ledger } from "@selfhost/ledger";
import {
  createValidator,
  type ResolvedSelfhostConfig,
  type ReviewItem,
  RunQuerySchema,
  roleAllows,
} from "@selfhost/schema";
import {
  type ExportResult,
  exportedRuns,
  exportSettings,
  exportTraces,
  readRun,
  runViewUrl,
  tracerRunUrl,
} from "@selfhost/traces";
import type { Context } from "hono";
import { apiError, type Caller, type Router, roleIn } from "./access.js";
import { invalidQuery } from "./http.js";
import { serverConfig } from "./retention.js";

export interface RunRouteOptions {
  /** selfhost.toml for runs with no team, or whose team has no stored policy. */
  config?: ResolvedSelfhostConfig;
  now?: () => Date;
}

/** The selfhost.toml in use for a team: its stored policy, else the server's, else the defaults. */
export function teamConfig(
  ledger: Ledger,
  config: ResolvedSelfhostConfig | undefined,
): (team: string | null) => Promise<ResolvedSelfhostConfig> {
  const fallback = config ?? serverConfig({});
  return async (team) => {
    if (team === null) return fallback;
    try {
      return (await ledger.orgs.effectivePolicy(team))?.config ?? fallback;
    } catch {
      return fallback;
    }
  };
}

const runQuery = createValidator(RunQuerySchema);

/**
 * GET /v1/runs/{run_id}: one run (agent session) for the console's run view, for both kinds of
 * token. The run belongs to the team most of its events were written to. Anyone in that team can
 * read it; anyone else gets 403 whether or not the run exists, so the answer shows nothing of it.
 * The admin token reads every run, including runs with no team.
 */
export function runRoutes(router: Router, ledger: Ledger, options: RunRouteOptions = {}): void {
  const now = options.now ?? (() => new Date());
  const configOf = teamConfig(ledger, options.config);
  router.on("GET", "/v1/runs/:run_id", async (c: Context, caller: Caller) => {
    const id = c.req.param("run_id") ?? "";
    const raw = c.req.query();
    const parsed = runQuery.validate({
      ...raw,
      ...(raw.limit !== undefined && /^\d+$/.test(raw.limit) ? { limit: Number(raw.limit) } : {}),
    });
    if (!parsed.ok) return invalidQuery(c, parsed.errors);
    const result = await readRun(ledger, id, {
      now: now(),
      ...(parsed.value.limit !== undefined ? { limit: parsed.value.limit } : {}),
      ...(parsed.value.cursor !== undefined ? { cursor: parsed.value.cursor } : {}),
      configFor: configOf,
      canRead: async (team) => {
        if (caller.kind === "admin") return true;
        if (team === null) return false;
        const role = await roleIn(caller, team);
        return role !== undefined && roleAllows(role, "read");
      },
    });
    if (result.ok) return c.json(result.response);
    if (result.reason === "invalid_cursor") {
      return c.json(
        apiError("invalid_query", "cursor: Expected a cursor returned by a previous page"),
        400,
      );
    }
    if (caller.kind === "person" || result.reason === "forbidden") {
      return c.json(apiError("forbidden", `No run ${id} in a team you can read.`), 403);
    }
    return c.json(apiError("not_found", `No run ${id}`), 404);
  });
}

/**
 * Adds the links out to review items that came from an agent run: run_url to the console's run
 * view, and trace_url to the run in the team's tracer once it has been sent there.
 */
export async function withRunLinks(
  ledger: Ledger,
  items: ReviewItem[],
  links: { server: string; config: ResolvedSelfhostConfig | undefined },
): Promise<ReviewItem[]> {
  const runs = items.flatMap((item) => (item.session_id ? [item.session_id] : []));
  if (runs.length === 0) return items;
  const template = links.config?.integrations.tracer?.run_url;
  const sent = template ? await exportedRuns(ledger, runs) : new Set<string>();
  return items.map((item) => {
    if (!item.session_id) return item;
    const trace = sent.has(item.session_id) ? tracerRunUrl(template, item.session_id) : undefined;
    return {
      ...item,
      run_url: runViewUrl(links.server, item.session_id),
      ...(trace ? { trace_url: trace } : {}),
    };
  });
}

export const TRACE_EXPORT_INTERVAL_MS = 60_000;
/** The longest wait between passes after the tracer kept failing. */
export const TRACE_EXPORT_MAX_BACKOFF_MS = 30 * 60_000;

/**
 * The server variables a team's [integrations.tracer] headers_env reads that a team server does
 * not send: any the team could not read as an env: secret (outside its own
 * SELFHOST_RUN_SECRET_<TEAM>__*, and the shared ones the server allows it), since the team's
 * policy also names the tracer's address. A team with any of them has its runs left unexported.
 */
export function unsafeTracerHeaders(
  config: Pick<ResolvedSelfhostConfig, "integrations">,
  team: string,
  scope: SecretScope,
): string[] {
  return Object.values(config.integrations.tracer?.headers_env ?? {}).filter(
    (variable) => envSecretRefusal(variable, team, scope) !== undefined,
  );
}

export interface TraceExportJobOptions {
  config?: ResolvedSelfhostConfig;
  /** Default: every minute. */
  intervalMs?: number;
  log?: (line: string) => void;
  now?: () => Date;
  /** Which server variables each team's tracer headers may read. Default: process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface TraceExportJob {
  /** One pass now. undefined when it failed; the failure is logged. */
  run(): Promise<ExportResult | undefined>;
  stop(): void;
}

/**
 * Sends finished agent runs to each team's [integrations.tracer] every minute. A pass where the
 * tracer refused or could not be reached waits twice as long before the next, up to 30 minutes,
 * and the runs it could not send go again then. The log names runs and counts, never what they
 * held.
 */
export function startTraceExportJob(
  ledger: Ledger,
  options: TraceExportJobOptions = {},
): TraceExportJob {
  const { intervalMs = TRACE_EXPORT_INTERVAL_MS, log = console.log } = options;
  const configOf = teamConfig(ledger, options.config);
  const scope = secretScopeFromEnv(options.env ?? process.env);
  const warned = new Set<string>();
  // A team's policy names the tracer's address, so the server variables it reads into headers
  // are limited as env: secrets are: otherwise a team could send the admin token to any host.
  const settingsFor = async (team: string) => {
    const config = await configOf(team);
    const unsafe = unsafeTracerHeaders(config, team, scope);
    if (unsafe.length === 0) return exportSettings(config);
    if (!warned.has(team)) {
      warned.add(team);
      log(
        `traces: team ${team}'s [integrations.tracer] headers_env reads ${unsafe.join(", ")}; on a team server it may read only ${teamEnvPrefix(team)}* variables (or shared ones the server allows it), so its runs are not exported`,
      );
    }
    return undefined;
  };
  let failures = 0;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running: Promise<ExportResult | undefined> | undefined;
  const run = () => {
    running ??= exportTraces(ledger, {
      settingsFor,
      ...(options.now ? { now: options.now() } : {}),
    })
      .then(
        (result) => {
          const spans = result.sent.reduce((sum, r) => sum + r.spans.length, 0);
          if (result.sent.length > 0) {
            log(`traces: sent ${spans} spans from ${result.sent.length} runs`);
          }
          for (const failed of result.failed.slice(0, 3)) {
            log(`traces: could not send run ${failed.run}: ${failed.error}`);
          }
          failures = result.failed.length > 0 ? failures + 1 : 0;
          return result;
        },
        (error: unknown) => {
          failures += 1;
          log(`traces: export failed: ${error instanceof Error ? error.message : error}`);
          return undefined;
        },
      )
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(async () => {
      const result = await run();
      schedule(
        result?.more && failures === 0
          ? 0
          : Math.min(intervalMs * 2 ** failures, TRACE_EXPORT_MAX_BACKOFF_MS),
      );
    }, delay);
    timer.unref();
  };
  schedule(0);
  return {
    run,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

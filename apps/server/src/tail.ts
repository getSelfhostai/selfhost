import { databaseOf, type Ledger, LedgerQueryError, tailEvents } from "@selfhost/ledger";
import {
  createValidator,
  type LedgerEvent,
  type ResolvedSelfhostConfig,
  redactEvent,
  redactionSettings,
  roleAllows,
  TAIL_SCHEMA,
  TAIL_WINDOW_HOURS,
  TailQuerySchema,
  type TailResponse,
} from "@selfhost/schema";
import type { Context } from "hono";
import { apiError, authorize, type Caller, type Router } from "./access.js";
import { invalidQuery } from "./http.js";
import { teamConfig } from "./runs.js";

export interface TailRouteOptions {
  /** selfhost.toml for events with no team, or whose team has no stored policy. */
  config?: ResolvedSelfhostConfig;
  now?: () => Date;
  /** How often a held request looks for new events. Default 1 s. */
  pollMs?: number;
}

const tailQuery = createValidator(TailQuerySchema);
const NUMERIC = ["wait", "limit"];
/**
 * On Postgres, rows from the last second are left for the next call, so a batch whose
 * transaction began before an earlier read but committed after it is not skipped.
 */
const POSTGRES_SETTLE_MS = 1000;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });

/** The teams a caller reads: every team with the admin token (null), else their teams. */
async function readableTeams(
  c: Context,
  caller: Caller,
  team: string | undefined,
): Promise<string[] | null | Response> {
  if (team !== undefined) {
    const refused = await authorize(c, caller, team, "read");
    return refused ?? [team];
  }
  if (caller.kind === "admin") return null;
  const { memberships } = await caller.scope();
  const own = roleAllows(caller.person.role, "read") ? [caller.person.team] : [];
  return [
    ...new Set([
      ...own,
      ...memberships.filter((m) => roleAllows(m.role, "read")).map((m) => m.team),
    ]),
  ];
}

/**
 * GET /v1/events/tail for both kinds of token: the events that reached the ledger after the
 * caller's cursor, held open up to `wait` seconds while there are none, for `selfhost tail` in
 * a team. A person token reads the teams of its org it is in. Every event is redacted again
 * under its team's current settings, as the run view does.
 */
export function tailRoutes(router: Router, ledger: Ledger, options: TailRouteOptions = {}): void {
  const now = options.now ?? (() => new Date());
  const pollMs = options.pollMs ?? 1000;
  const configOf = teamConfig(ledger, options.config);
  router.on("GET", "/v1/events/tail", async (c, caller) => {
    const raw = c.req.query();
    const parsed = tailQuery.validate(
      Object.fromEntries(
        Object.entries(raw).map(([key, value]) => [
          key,
          NUMERIC.includes(key) && /^\d+$/.test(value) ? Number(value) : value,
        ]),
      ),
    );
    if (!parsed.ok) return invalidQuery(c, parsed.errors);
    const query = parsed.value;
    const teams = await readableTeams(c, caller, query.team);
    if (teams instanceof Response) return teams;
    const db = databaseOf(ledger);
    const from =
      query.since ?? new Date(now().getTime() - TAIL_WINDOW_HOURS * 3_600_000).toISOString();
    const deadline = Date.now() + (query.wait ?? 0) * 1000;
    const signal = c.req.raw.signal;
    let after = query.after;
    let page: Awaited<ReturnType<typeof tailEvents>>;
    try {
      for (;;) {
        page = await tailEvents(db, {
          from,
          ...(after !== undefined ? { after } : { backfill: query.since !== undefined }),
          ...(query.kind ? { kinds: query.kind.split(",") } : {}),
          ...(query.person !== undefined ? { person: query.person } : {}),
          ...(query.agent !== undefined ? { agent: query.agent } : {}),
          ...(query.repo !== undefined ? { repo: query.repo } : {}),
          ...(query.session !== undefined ? { session: query.session } : {}),
          ...(query.run !== undefined ? { run: query.run } : {}),
          teams,
          ...(query.limit !== undefined ? { limit: query.limit } : {}),
          settleMs: db.kind === "postgres" ? POSTGRES_SETTLE_MS : 0,
        });
        after = page.cursor;
        const left = deadline - Date.now();
        if (page.rows.length > 0 || left <= 0 || signal.aborted) break;
        await sleep(Math.min(pollMs, left), signal);
      }
    } catch (error) {
      if (error instanceof LedgerQueryError) {
        return c.json(apiError("invalid_query", error.message), 400);
      }
      throw error;
    }
    const settings = new Map<string | null, ReturnType<typeof redactionSettings>>();
    const events: LedgerEvent[] = [];
    const people: Record<string, string> = {};
    for (const row of page.rows) {
      let found = settings.get(row.team);
      if (!found) {
        found = redactionSettings(await configOf(row.team));
        settings.set(row.team, found);
      }
      events.push(redactEvent(row.event, found));
      if (row.person && row.event.actor.kind !== "person") people[row.event.id] = row.person;
    }
    const response: TailResponse = { schema: TAIL_SCHEMA, events, cursor: page.cursor };
    if (Object.keys(people).length > 0) response.people = people;
    return c.json(response);
  });
}

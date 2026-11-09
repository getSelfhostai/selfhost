import type { Ledger } from "@selfhost/ledger";
import {
  createValidator,
  type LedgerEvent,
  RUNTIME_LEFTOVER_MINUTES,
  SandboxWasteQuerySchema,
  type SandboxWasteResponse,
} from "@selfhost/schema";
import { sandboxWaste } from "@selfhost/spend";
import { apiError, authorize, type Router } from "./access.js";
import { invalidQuery } from "./http.js";

const wasteQuery = createValidator(SandboxWasteQuerySchema);

const DAY_MS = 86_400_000;
/** The report's longest window. */
const HISTORY_DAYS = 30;
/** Sandbox lifecycle, the run costs beside it, and the events that end runs. */
const KINDS = [
  "sandbox.started",
  "sandbox.stopped",
  "cost.recorded",
  "session.ended",
  "alert.raised",
];

export interface SandboxRouteOptions {
  now?: () => Date;
}

async function teamEvents(ledger: Ledger, team: string, from: Date): Promise<LedgerEvent[]> {
  const events: LedgerEvent[] = [];
  for (const kind of KINDS) {
    let cursor: string | undefined;
    do {
      const page = await ledger.query({
        kind,
        team,
        from: from.toISOString(),
        limit: 1000,
        cursor,
      });
      events.push(
        ...(kind === "cost.recorded" ? page.events.filter((e) => e.run_id) : page.events),
      );
      cursor = page.nextCursor;
    } while (cursor);
  }
  return events;
}

/**
 * GET /v1/teams/{team}/sandboxes, for both kinds of token with read in the team: the sandbox
 * cost of the team's background runs, the idle share per runtime for 7 and 30 days, sandboxes
 * left running past their run, and each run's sandbox and model cost.
 */
export function sandboxRoutes(
  router: Router,
  ledger: Ledger,
  options: SandboxRouteOptions = {},
): void {
  const now = options.now ?? (() => new Date());

  router.on("GET", "/v1/teams/:team/sandboxes", async (c, caller) => {
    const team = c.req.param("team") ?? "";
    const refused = await authorize(c, caller, team, "read");
    if (refused) return refused;
    const checked = wasteQuery.validate(c.req.query());
    if (!checked.ok) return invalidQuery(c, checked.errors);
    if (!(await ledger.teams.getTeam(team))) {
      return c.json(apiError("not_found", `No team ${team}`), 404);
    }
    let minutes = checked.value.leftover_minutes
      ? Number(checked.value.leftover_minutes)
      : undefined;
    if (minutes === undefined) {
      try {
        minutes = (await ledger.orgs.effectivePolicy(team))?.config.runtime?.leftover_minutes;
      } catch {
        // A broken policy falls back to the default, as a team with none does.
      }
    }
    const at = now();
    const events = await teamEvents(ledger, team, new Date(at.getTime() - HISTORY_DAYS * DAY_MS));
    const report = sandboxWaste(events, {
      now: at,
      team,
      leftoverMinutes: minutes ?? RUNTIME_LEFTOVER_MINUTES,
    });
    return c.json(report satisfies SandboxWasteResponse);
  });
}

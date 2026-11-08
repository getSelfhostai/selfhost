import { databaseOf, type Ledger } from "@selfhost/ledger";
import {
  createValidator,
  ROI_DEFAULT_DAYS,
  RoiQuerySchema,
  type RoiResponse,
  roiBaselinePeriod,
} from "@selfhost/schema";
import { roiReport } from "@selfhost/spend";
import { apiError, authorize, type Router } from "./access.js";
import { invalidQuery } from "./http.js";

const roiQuery = createValidator(RoiQuerySchema);

const DAY_MS = 86_400_000;

export interface RoiRouteOptions {
  now?: () => Date;
}

/**
 * GET /v1/teams/{team}/roi, for both kinds of token with read in the team: what each merged pull
 * request cost in the range, by agent and model, next to the team's frozen baseline. The
 * baseline period is [roi] in the team's policy, else its first week of data.
 */
export function roiRoutes(router: Router, ledger: Ledger, options: RoiRouteOptions = {}): void {
  const now = options.now ?? (() => new Date());

  router.on("GET", "/v1/teams/:team/roi", async (c, caller) => {
    const team = c.req.param("team") ?? "";
    const refused = await authorize(c, caller, team, "read");
    if (refused) return refused;
    const checked = roiQuery.validate(c.req.query());
    if (!checked.ok) return invalidQuery(c, checked.errors);
    const at = now();
    const to = checked.value.to ? new Date(checked.value.to) : at;
    const from = checked.value.from
      ? new Date(checked.value.from)
      : new Date(to.getTime() - ROI_DEFAULT_DAYS * DAY_MS);
    if (from >= to) {
      return c.json(apiError("invalid_query", "from: Expected a time before to"), 400);
    }
    const info = await ledger.teams.getTeam(team);
    if (!info) return c.json(apiError("not_found", `No team ${team}`), 404);
    let period: { from: Date; to: Date } | undefined;
    try {
      period = roiBaselinePeriod((await ledger.orgs.effectivePolicy(team))?.config.roi);
    } catch {
      // A broken policy falls back to the first week, as a team with none does.
    }
    const report = await roiReport(databaseOf(ledger), {
      org: info.org,
      team,
      from,
      to,
      now: at,
      ...(period ? { period } : {}),
    });
    return c.json(report satisfies RoiResponse);
  });
}

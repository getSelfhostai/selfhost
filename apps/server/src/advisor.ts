import type { Ledger } from "@selfhost/ledger";
import { advisorReport, readAdvisorData } from "@selfhost/notify";
import {
  ADVISOR_DAYS,
  AdvisorQuerySchema,
  type AdvisorReport,
  createValidator,
  type PersonRole,
} from "@selfhost/schema";
import { type Caller, type Router, roleIn } from "./access.js";
import { invalidQuery } from "./http.js";
import { readableTeams } from "./tail.js";

const advisorQuery = createValidator(AdvisorQuerySchema);

const DAY_MS = 86_400_000;

export interface AdvisorRouteOptions {
  now?: () => Date;
}

/** Roles that read the advisor for the whole team; members read it about their own work. */
export const TEAM_READERS: readonly PersonRole[] = ["owner", "admin"];

/**
 * Whose report a caller reads over these teams: the whole teams for the admin token and for a
 * person who is an owner or admin in every one of them, else only the person's own work.
 */
export async function advisorScope(
  caller: Caller,
  teams: readonly string[] | null,
): Promise<{ person?: string }> {
  if (caller.kind === "admin") return {};
  for (const team of teams ?? []) {
    const role = await roleIn(caller, team);
    if (!role || !TEAM_READERS.includes(role)) return { person: caller.person.id };
  }
  return teams && teams.length > 0 ? {} : { person: caller.person.id };
}

/**
 * GET /v1/advisor for both kinds of token: the weekly advisor report for the 7 days before `to`
 * (default now), over one team or every team the caller reads. Owners and admins of every team
 * read get the team report, members a report about their own work; the admin token reads every
 * team and events with no team. The same report goes out as the Monday note (notify.ts).
 */
export function advisorRoutes(
  router: Router,
  ledger: Ledger,
  options: AdvisorRouteOptions = {},
): void {
  const now = options.now ?? (() => new Date());
  router.on("GET", "/v1/advisor", async (c, caller) => {
    const checked = advisorQuery.validate(c.req.query());
    if (!checked.ok) return invalidQuery(c, checked.errors);
    const teams = await readableTeams(c, caller, checked.value.team);
    if (teams instanceof Response) return teams;
    const to = checked.value.to ? new Date(checked.value.to) : now();
    const from = new Date(to.getTime() - ADVISOR_DAYS * DAY_MS);
    const scope = await advisorScope(caller, teams);
    const data = await readAdvisorData(ledger, { from, to, teams });
    return c.json(advisorReport(data, { teams, from, to, ...scope }) satisfies AdvisorReport);
  });
}

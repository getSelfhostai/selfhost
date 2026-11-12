import { databaseOf, type Ledger, readPresence, stableEventId } from "@selfhost/ledger";
import {
  createValidator,
  EDIT_OVERLAP_ALERT,
  EVENT_SCHEMA,
  type LedgerEvent,
  PresenceQuerySchema,
  presenceIdleMinutes,
  type ResolvedSelfhostConfig,
} from "@selfhost/schema";
import type { Router } from "./access.js";
import { invalidQuery } from "./http.js";
import { teamConfig } from "./runs.js";
import { readableTeams } from "./tail.js";

export interface PresenceRouteOptions {
  /** selfhost.toml for runs with no team, or whose team has no stored policy. */
  config?: ResolvedSelfhostConfig;
  now?: () => Date;
}

const presenceQuery = createValidator(PresenceQuerySchema);

/**
 * GET /v1/presence for both kinds of token: who (people and named agents) is working on which
 * repo, branch and files right now, who owns each run, and the files two runs are both editing.
 * A person token sees only the teams of its org it can read; the admin token sees every team
 * and runs with no team. The same answer backs selfhost who and the MCP tool who.
 */
export function presenceRoutes(
  router: Router,
  ledger: Ledger,
  options: PresenceRouteOptions = {},
): void {
  const now = options.now ?? (() => new Date());
  const configOf = teamConfig(ledger, options.config);
  router.on("GET", "/v1/presence", async (c, caller) => {
    const raw = c.req.query();
    const parsed = presenceQuery.validate({
      ...raw,
      ...(raw.idle_minutes !== undefined && /^\d+$/.test(raw.idle_minutes)
        ? { idle_minutes: Number(raw.idle_minutes) }
        : {}),
    });
    if (!parsed.ok) return invalidQuery(c, parsed.errors);
    const query = parsed.value;
    const teams = await readableTeams(c, caller, query.team);
    if (teams instanceof Response) return teams;
    const idleMinutes =
      query.idle_minutes ?? presenceIdleMinutes(await configOf(query.team ?? null));
    return c.json(
      await readPresence(databaseOf(ledger), {
        now: now(),
        idleMinutes,
        teams,
        ...(query.repo ? { repo: query.repo } : {}),
        configFor: configOf,
      }),
    );
  });
}

/** actor.id of the alerts selfhost raises itself. */
const SERVER_ACTOR_ID = "selfhost";

/**
 * Warns both owners when two active runs in one repo edit the same file: one alert.raised
 * (data.alert edit_overlap) per owner, per file and set of runs, which the review list turns
 * into an overlap item for that owner. The ids are stable, so a later check raises nothing new
 * for the same overlap. Returns how many were raised.
 */
export async function raiseOverlapAlerts(
  ledger: Ledger,
  now: Date,
  config?: ResolvedSelfhostConfig,
): Promise<number> {
  const db = databaseOf(ledger);
  const configOf = teamConfig(ledger, config);
  const orgs = await db.query<{ id: string }>("SELECT id FROM orgs ORDER BY id");
  let raised = 0;
  for (const { id: org } of orgs) {
    for (const team of await ledger.teams.listTeams(org)) {
      const teamPolicy = await configOf(team.id);
      const presence = await readPresence(db, {
        now,
        idleMinutes: presenceIdleMinutes(teamPolicy),
        teams: [team.id],
        configFor: configOf,
      });
      const alerts: LedgerEvent[] = presence.overlaps.flatMap((overlap) =>
        overlap.owners.map((owner) => {
          const others = overlap.runs.length - 1;
          return {
            id: stableEventId(
              overlap.since,
              `${EDIT_OVERLAP_ALERT}\n${team.id}\n${overlap.repo}\n${overlap.file}\n${[...overlap.runs].sort().join(",")}\n${owner}`,
            ),
            schema: EVENT_SCHEMA,
            ts: now.toISOString(),
            source: "server",
            kind: "alert.raised",
            actor: { kind: "system", id: SERVER_ACTOR_ID },
            team: team.id,
            ...(org ? { org } : {}),
            repo: overlap.repo,
            target: { type: "file", value: overlap.file },
            data: {
              alert: EDIT_OVERLAP_ALERT,
              owner,
              file: overlap.file,
              runs: overlap.runs,
              owners: overlap.owners,
              since: overlap.since,
              message: `${overlap.runs.length} active runs are editing ${overlap.file} in ${overlap.repo}`,
              reason: `${others === 1 ? "Another active run" : `${others} other active runs`} in ${overlap.repo} edited ${overlap.file} too (${overlap.owners.join(", ")}). Agree who goes first before either opens a pull request; selfhost who shows both.`,
            },
          } satisfies LedgerEvent;
        }),
      );
      if (alerts.length === 0) continue;
      raised += (await ledger.append(alerts, { team: team.id })).accepted.length;
    }
  }
  return raised;
}

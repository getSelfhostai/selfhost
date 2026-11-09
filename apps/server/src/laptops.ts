import { databaseOf, type Ledger } from "@selfhost/ledger";
import {
  createValidator,
  HEARTBEAT_EVENT_KIND,
  heartbeatValidator,
  LAPTOP_SILENT_DEFAULT_DAYS,
  type LaptopFlag,
  type LaptopRow,
  LaptopsQuerySchema,
  type TeamLaptopsResponse,
} from "@selfhost/schema";
import { apiError, authorize, type Router } from "./access.js";
import { invalidQuery } from "./http.js";

const laptopsQuery = createValidator(LaptopsQuerySchema);

const DAY_MS = 86_400_000;

/** The newest heartbeat of each laptop of a team, with the person who sent it. */
const NEWEST_SQL = `
SELECT DISTINCT ON (body #>> '{data,heartbeat,machine}')
  actor_id, ts, body #> '{data,heartbeat}' AS heartbeat
FROM events
WHERE kind = $1 AND team = $2 AND actor_kind = 'person'
  AND body #>> '{data,heartbeat,machine}' IS NOT NULL
ORDER BY body #>> '{data,heartbeat,machine}', ts DESC, id DESC`;

interface NewestRow {
  actor_id: string;
  ts: unknown;
  heartbeat: unknown;
}

const ORDER: Record<LaptopRow["status"], number> = {
  silent: 0,
  behind: 1,
  not_installed: 2,
  current: 3,
};

const isoOf = (value: unknown) =>
  (value instanceof Date ? value : new Date(String(value))).toISOString();

/**
 * Laptop coverage from the ledger's heartbeats: each laptop's newest config.reported event
 * against the team's policy now. Pure, so the flags are tested without a database.
 */
export function laptopRows(
  rows: readonly NewestRow[],
  options: { policyHash: string | null; silentDays: number; now: Date },
): LaptopRow[] {
  const silentBefore = options.now.getTime() - options.silentDays * DAY_MS;
  const laptops: LaptopRow[] = [];
  for (const row of rows) {
    const checked = heartbeatValidator.validate(
      typeof row.heartbeat === "string" ? JSON.parse(row.heartbeat) : row.heartbeat,
    );
    // Written by a newer or broken client: not counted rather than guessed at.
    if (!checked.ok) continue;
    const beat = checked.value;
    const last = isoOf(row.ts);
    const flags: LaptopFlag[] = [];
    if (Date.parse(last) < silentBefore) flags.push("silent");
    if (options.policyHash !== null && beat.policy_hash !== options.policyHash) {
      flags.push("behind");
    }
    if (beat.managed.state === "pending" || beat.managed.state === "off") {
      flags.push("not_installed");
    }
    laptops.push({
      machine: beat.machine,
      person: row.actor_id,
      hostname: beat.hostname ?? null,
      platform: beat.platform,
      selfhost_version: beat.selfhost_version,
      policy_hash: beat.policy_hash,
      managed: beat.managed,
      last_heartbeat: last,
      flags,
      status: flags[0] ?? "current",
    });
  }
  return laptops.sort(
    (a, b) =>
      ORDER[a.status] - ORDER[b.status] ||
      a.person.localeCompare(b.person) ||
      (a.hostname ?? a.machine).localeCompare(b.hostname ?? b.machine),
  );
}

/**
 * GET /v1/teams/{team}/laptops, for both kinds of token: every laptop that sent a heartbeat for
 * the team, the config version it runs and where its managed settings stand, flagged when it is
 * behind the team's policy, silent for silent_days, or missing its managed files. Anyone in the
 * team can read it.
 */
export function laptopRoutes(
  router: Router,
  ledger: Ledger,
  { now = () => new Date() }: { now?: () => Date } = {},
): void {
  router.on("GET", "/v1/teams/:team/laptops", async (c, caller) => {
    const team = c.req.param("team") ?? "";
    const query = laptopsQuery.validate(c.req.query());
    if (!query.ok) return invalidQuery(c, query.errors);
    const refused = await authorize(c, caller, team, "read");
    if (refused) return refused;
    if (!(await ledger.teams.getTeam(team))) {
      return c.json(apiError("not_found", `No team ${team}`), 404);
    }
    const silentDays = Number(query.value.silent_days ?? LAPTOP_SILENT_DEFAULT_DAYS);
    const policy = await ledger.orgs.effectivePolicy(team);
    const rows = await databaseOf(ledger).query<NewestRow>(NEWEST_SQL, [
      HEARTBEAT_EVENT_KIND,
      team,
    ]);
    const laptops = laptopRows(rows, {
      policyHash: policy?.hash ?? null,
      silentDays,
      now: now(),
    });
    const reported = new Set(laptops.map((row) => row.person));
    const people = await ledger.teams.listPeople(team);
    return c.json({
      team,
      policy_hash: policy?.hash ?? null,
      silent_days: silentDays,
      laptops,
      people_without_heartbeat: people.map((p) => p.id).filter((id) => !reported.has(id)),
    } satisfies TeamLaptopsResponse);
  });
}

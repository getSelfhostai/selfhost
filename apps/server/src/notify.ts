import { databaseOf, type Ledger } from "@selfhost/ledger";
import {
  appriseApi,
  type Deliver,
  type Directory,
  freeName,
  isHostedService,
  type NotifySettingsInForce,
  nameProblem,
  notifyStore,
  publicTarget,
  runNotify,
  type SpendDigest,
  scrub,
  sendTest,
  serviceOf,
  testMessage,
  urlProblem,
} from "@selfhost/notify";
import {
  AddNotifyTargetRequestSchema,
  createValidator,
  DEFAULT_ORG_ID,
  type LedgerEvent,
  type NotifySendsResponse,
  type NotifySettings,
  NotifyTestRequestSchema,
  type NotifyTestResponse,
  type ResolvedSelfhostConfig,
  SetNotifyDigestRequestSchema,
} from "@selfhost/schema";
import { periodRange } from "@selfhost/spend";
import type { Context, Hono } from "hono";
import { apiError } from "./access.js";
import { limit, readBody, SMALL_BODY_BYTES } from "./http.js";
import { costsOf } from "./orgs.js";
import { teamConfig } from "./runs.js";
import type { PersonEnv } from "./teams.js";
import { wakeAfter } from "./wake.js";

/** A person keeps at most this many targets. */
export const MAX_TARGETS = 10;
/** How often the job looks for something to send. */
export const NOTIFY_INTERVAL_MS = 60_000;
/** How soon a pass follows an item an agent waits on or a budget alert being filed. */
export const WAKE_NOTIFY_MS = 2000;

const addTargetBody = createValidator(AddNotifyTargetRequestSchema);
const digestBody = createValidator(SetNotifyDigestRequestSchema);
const testBody = createValidator(NotifyTestRequestSchema);

/**
 * SELFHOST_APPRISE_URL, the Apprise API server notifications go through: the one
 * compose.notify.yml runs (http://apprise:8000) or one the team already has. undefined when unset.
 */
export function notifyFromEnv(env: NodeJS.ProcessEnv = process.env): Deliver | undefined {
  const url = env.SELFHOST_APPRISE_URL?.trim();
  return url ? appriseApi(url) : undefined;
}

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Who gets what on a team server. A person's [notify] comes from the policy of the first team
 * they joined; people whose every token is revoked get nothing, and people revoked from a team
 * get nothing of that team's. Items nobody owns go to the team's owners and admins; budget
 * alerts to [notify] budget_owners, else the team's owners.
 */
export function serverDirectory(
  ledger: Ledger,
  config: ResolvedSelfhostConfig | undefined,
): Directory {
  const configOf = teamConfig(ledger, config);
  const { teams } = ledger;

  async function budgetOwners(team: string | null): Promise<string[]> {
    if (team === null) return [];
    const named = (await configOf(team)).notify.budget_owners;
    if (named.length > 0) return named;
    return (await teams.listPeople(team)).filter((p) => p.role === "owner").map((p) => p.id);
  }

  return {
    async settingsFor(person, org): Promise<NotifySettingsInForce | undefined> {
      const [first] = (await teams.peopleWithAccess(person)).filter((a) => a.org === org);
      if (!first) return undefined;
      return (await configOf(first.person.team)).notify;
    },

    async orgOf(team) {
      if (team === null) return DEFAULT_ORG_ID;
      return (await teams.getTeam(team))?.org ?? DEFAULT_ORG_ID;
    },

    async teamsOf(person, org) {
      return (await teams.memberships(org, person)).map((m) => m.team);
    },

    async unowned(team) {
      if (team === null) return [];
      return (await teams.listPeople(team))
        .filter((p) => p.role === "owner" || p.role === "admin")
        .map((p) => p.id);
    },

    budgetOwners,

    async spendDigest(person, org, now) {
      const access = await teams.peopleWithAccess(person);
      if (!access.some((a) => a.org === org)) return undefined;
      const owned: { team: string; config: ResolvedSelfhostConfig }[] = [];
      for (const { team } of await teams.memberships(org, person)) {
        const policy = await configOf(team);
        if (!policy.budget) continue;
        if ((await budgetOwners(team)).some((owner) => sameId(owner, person))) {
          owned.push({ team, config: policy });
        }
      }
      if (owned.length === 0) return undefined;
      return spendDigestOf(ledger, org, owned, now);
    },
  };
}

const DAY_MS = 86_400_000;
const round = (usd: number) => Math.round(usd * 100) / 100;

/**
 * The spend digest of the teams a budget owner holds: each budget against its period, the top
 * spenders and fastest-growing teams of the last 24 hours, and runs whose key hit its cap.
 */
async function spendDigestOf(
  ledger: Ledger,
  org: string,
  owned: { team: string; config: ResolvedSelfhostConfig }[],
  now: Date,
): Promise<SpendDigest> {
  const names = owned.map((o) => o.team);
  const dayAgo = now.getTime() - DAY_MS;
  const weekBefore = dayAgo - 7 * DAY_MS;
  const monthStart = periodRange("month", now).from.getTime();
  const from = new Date(Math.min(weekBefore, monthStart, periodRange("week", now).from.getTime()));
  const costs = await ledger.orgs.teamCosts(org, names, from.toISOString(), now.toISOString());
  const usdOf = (events: LedgerEvent[], start: number, end = now.getTime()) =>
    events
      .filter((e) => Date.parse(e.ts) >= start && Date.parse(e.ts) < end)
      .reduce((sum, e) => sum + (e.cost?.usd ?? 0), 0);

  const budgets: SpendDigest["budgets"] = [];
  const spenders = new Map<string, { person: string; team: string; usd: number }>();
  const growing: SpendDigest["growing_teams"] = [];
  for (const { team, config } of owned) {
    const events = costsOf(costs, team);
    const periods = [
      ["day", config.budget?.daily_usd],
      ["week", config.budget?.weekly_usd],
      ["month", config.budget?.monthly_usd],
    ] as const;
    for (const [period, limitUsd] of periods) {
      if (limitUsd === undefined) continue;
      const spent = usdOf(events, periodRange(period, now).from.getTime());
      budgets.push({ team, period, limit_usd: limitUsd, spent_usd: round(spent) });
    }
    for (const event of events) {
      if (event.actor.kind !== "person" || Date.parse(event.ts) < dayAgo) continue;
      const key = `${team}\n${event.actor.id}`;
      const entry = spenders.get(key) ?? { person: event.actor.id, team, usd: 0 };
      entry.usd += event.cost?.usd ?? 0;
      spenders.set(key, entry);
    }
    const lastDay = usdOf(events, dayAgo);
    const average = usdOf(events, weekBefore, dayAgo) / 7;
    if (lastDay >= 1 && lastDay > average * 1.5) {
      growing.push({ team, last_day_usd: round(lastDay), daily_average_usd: round(average) });
    }
  }

  const capped: SpendDigest["capped_runs"] = [];
  let cursor: string | undefined;
  do {
    const page = await ledger.query({
      kind: "alert.raised",
      from: new Date(dayAgo).toISOString(),
      limit: 1000,
      cursor,
    });
    for (const event of page.events) {
      const data = event.data ?? {};
      if (data.scope !== "run" || data.alert !== "budget_exceeded") continue;
      if (!event.team || !names.includes(event.team)) continue;
      capped.push({
        team: event.team,
        run_id: event.run_id ?? "unknown",
        limit_usd: typeof data.limit_usd === "number" ? data.limit_usd : 0,
      });
    }
    cursor = page.nextCursor;
  } while (cursor);

  return {
    budgets,
    top_spenders: [...spenders.values()]
      .map((s) => ({ ...s, usd: round(s.usd) }))
      .filter((s) => s.usd > 0)
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 5),
    growing_teams: growing
      .sort(
        (a, b) =>
          b.last_day_usd / (b.daily_average_usd || 1) - a.last_day_usd / (a.daily_average_usd || 1),
      )
      .slice(0, 3),
    capped_runs: capped.slice(0, 10),
  };
}

export interface NotifyRouteOptions {
  /** How the server delivers; without it targets are kept but nothing is sent. */
  deliver?: Deliver;
  config?: ResolvedSelfhostConfig;
  now?: () => Date;
}

/**
 * A person's own notification settings, with their person token: GET /v1/notify, POST and
 * DELETE /v1/notify/targets, PUT /v1/notify/digest, POST /v1/notify/test and GET
 * /v1/notify/sends. Target URLs go in and never come back out: answers show their service and a
 * masked form, and the send record names targets only. Everything is the person's in the org of
 * their token: the same id in another org is another person.
 */
export function notifyRoutes(
  person: Hono<PersonEnv>,
  ledger: Ledger,
  options: NotifyRouteOptions = {},
): void {
  const db = databaseOf(ledger);
  const directory = serverDirectory(ledger, options.config);
  const now = options.now ?? (() => new Date());
  const small = limit(SMALL_BODY_BYTES);

  async function settings(id: string, org: string): Promise<NotifySettings> {
    const store = notifyStore(db, org);
    const own = await store.digest(id);
    const inForce = await directory.settingsFor(id, org);
    return {
      person: id,
      targets: (await store.targets(id)).map(publicTarget),
      digest: own ?? inForce?.digest ?? "daily",
      digest_set: own !== undefined,
      delivery: options.deliver ? options.deliver.kind : "none",
    };
  }

  const who = (c: Context<PersonEnv>) => c.env.person.id;
  const orgOf = async (c: Context<PersonEnv>) => (await c.env.caller.scope()).org;
  const storeOf = async (c: Context<PersonEnv>) => notifyStore(db, await orgOf(c));

  person.get("/v1/notify", async (c) => c.json(await settings(who(c), await orgOf(c))));

  person.post("/v1/notify/targets", small, async (c) => {
    const body = await readBody(c, addTargetBody);
    if (body instanceof Response) return body;
    const url = body.url.trim();
    const problem = urlProblem(url);
    if (problem) return c.json(apiError("invalid_request", `url: ${problem}`), 400);
    const id = who(c);
    const { org, memberships } = await c.env.caller.scope();
    const store = notifyStore(db, org);
    if (!isHostedService(url)) {
      // A role in this org: an owner elsewhere under the same id is someone else.
      if (!memberships.some((m) => m.role === "owner" || m.role === "admin")) {
        return c.json(
          apiError(
            "forbidden",
            `${serviceOf(url)}:// targets can reach any host, so only a team's owners and admins can add them. Use a hosted service such as tgram://, slack:// or discord://, or ask an admin.`,
          ),
          403,
        );
      }
    }
    const existing = await store.targets(id);
    if (existing.length >= MAX_TARGETS) {
      return c.json(
        apiError("too_many_targets", `You have ${MAX_TARGETS} targets; remove one first.`),
        409,
      );
    }
    const taken = new Set(existing.map((t) => t.name));
    const name = body.name ?? freeName(serviceOf(url), taken);
    const badName = nameProblem(name);
    if (badName) return c.json(apiError("invalid_request", `name: ${badName}`), 400);
    if (taken.has(name) || !(await store.addTarget(id, name, url, now()))) {
      return c.json(apiError("target_exists", `You already have a target named ${name}.`), 409);
    }
    return c.json(await settings(id, org), 201);
  });

  person.delete("/v1/notify/targets/:name", async (c) => {
    const id = who(c);
    const name = c.req.param("name");
    const store = await storeOf(c);
    if (!(await store.removeTarget(id, name))) {
      return c.json(apiError("not_found", `You have no target named ${name}.`), 404);
    }
    return c.json(await settings(id, store.org));
  });

  person.put("/v1/notify/digest", small, async (c) => {
    const body = await readBody(c, digestBody);
    if (body instanceof Response) return body;
    const store = await storeOf(c);
    await store.setDigest(who(c), body.digest);
    return c.json(await settings(who(c), store.org));
  });

  person.post("/v1/notify/test", small, async (c) => {
    const body = await readBody(c, testBody);
    if (body instanceof Response) return body;
    if (!options.deliver) {
      return c.json(
        apiError(
          "no_delivery",
          "This server has no Apprise to send through. Its operator sets SELFHOST_APPRISE_URL, or adds compose.notify.yml, which runs one.",
        ),
        503,
      );
    }
    const id = who(c);
    const store = await storeOf(c);
    const targets = await store.targets(id);
    if (body.name !== undefined && !targets.some((t) => t.name === body.name)) {
      return c.json(apiError("not_found", `You have no target named ${body.name}.`), 404);
    }
    if (targets.length === 0) {
      return c.json(
        apiError("no_targets", "You have no targets yet: add one with selfhost notify add."),
        404,
      );
    }
    const sends = await sendTest(
      ledger,
      id,
      options.deliver,
      testMessage(id),
      now(),
      body.name,
      store.org,
    );
    return c.json({ sends } satisfies NotifyTestResponse);
  });

  person.get("/v1/notify/sends", async (c) => {
    const raw = c.req.query("limit");
    const count = raw === undefined ? 50 : Number(raw);
    if (!Number.isInteger(count) || count < 1 || count > 200) {
      return c.json(apiError("invalid_query", "limit: Expected an integer from 1 to 200"), 400);
    }
    const store = await storeOf(c);
    return c.json({ sends: await store.sends(who(c), count) } satisfies NotifySendsResponse);
  });
}

export interface NotifyJobOptions {
  deliver: Deliver;
  config?: ResolvedSelfhostConfig;
  /** SELFHOST_PUBLIC_URL, for links to the console. */
  publicUrl?: string;
  intervalMs?: number;
  /** Default: WAKE_NOTIFY_MS. */
  wakeMs?: number;
  log?: (line: string) => void;
  now?: () => Date;
}

/**
 * Sends notifications once a minute, like the other jobs: one pass at a time, a timer that never
 * keeps the process alive, and a log line with counts only, never a target or a URL.
 */
export function startNotifyJob(ledger: Ledger, options: NotifyJobOptions) {
  const { intervalMs = NOTIFY_INTERVAL_MS, log = console.log } = options;
  const directory = serverDirectory(ledger, options.config);
  let running: Promise<void> | undefined;
  let again = false;
  const run = () => {
    running ??= runNotify(ledger, {
      deliver: options.deliver,
      directory,
      now: options.now?.() ?? new Date(),
      ...(options.publicUrl ? { consoleUrl: options.publicUrl } : {}),
    })
      .then(
        (result) => {
          if (result.sent > 0 || result.failed > 0) {
            log(`notifications: ${result.sent} sent, ${result.failed} failed`);
          }
        },
        (error: unknown) => {
          log(
            `notifications: failed: ${scrub(error instanceof Error ? error.message : String(error))}`,
          );
        },
      )
      .finally(() => {
        running = undefined;
        if (again) {
          again = false;
          void run();
        }
      });
    return running;
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  // An item an agent waits on, or a budget alert, was just filed: a pass within WAKE_NOTIFY_MS,
  // and another after the one running, which may have read the list before it was filed.
  const wake = wakeAfter(() => {
    if (running) again = true;
    else void run();
  }, options.wakeMs ?? WAKE_NOTIFY_MS);
  void run();
  return {
    run,
    wake,
    stop: () => {
      clearInterval(timer);
      wake.cancel();
    },
  };
}

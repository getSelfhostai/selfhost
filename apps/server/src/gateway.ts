import {
  BUDGET_SPENT_ALERT,
  bifrostClient,
  budgetMode,
  type GatewayClient,
  GatewayError,
  issueKey,
  type KeyOwner,
  litellmClient,
  type ManagedKey,
  readUsage,
  syncGateway,
  type TeamInput,
  USAGE_FIRST_LOOKBACK_MS,
  USAGE_OVERLAP_MS,
} from "@selfhost/gateway";
import { databaseOf, type Ledger, LedgerValidationError } from "@selfhost/ledger";
import {
  createValidator,
  type GatewayKey,
  type GatewayKeysResponse,
  type GatewayStatus,
  type GatewaySyncReport,
  type GatewayUsageReport,
  IssueGatewayKeyRequestSchema,
  type IssueGatewayKeyResponse,
  isFinalRunState,
  type LedgerEvent,
  type ResolvedSelfhostConfig,
  ROUTER_TOOLS,
  type RouterTool,
} from "@selfhost/schema";
import type { Context, Hono } from "hono";
import { apiError, authorize, type Caller, type Router } from "./access.js";
import { limit, readBody, SMALL_BODY_BYTES } from "./http.js";

/** The gateway this server configures: its management client and where agents reach it. */
export interface Gateway {
  client: GatewayClient;
  /** Where agents send model traffic, for the keys and settings it hands out. */
  baseUrl: string;
  /** [integrations.router] providers of the server's own config, for teams that set none. */
  fallbackProviders?: string[];
  /** The last sync and usage read, for GET /v1/gateway. */
  state: { sync: GatewaySyncReport | null; usage: GatewayUsageReport | null; usageFrom?: Date };
  /**
   * Set by the gateway job: writes teams, budgets and key settings to the gateway now. The
   * policy routes call it when a selfhost.toml changes, so a new budget holds within seconds
   * instead of at the next periodic sync.
   */
  policyChanged?: () => void;
}

/** Where the bundled Bifrost answers inside the compose network. */
export const BUNDLED_BIFROST_URL = "http://bifrost:8080";
/** The admin username the bundled Bifrost config sets. */
export const BUNDLED_BIFROST_USER = "selfhost";
export const DEFAULT_ADMIN_KEY_ENV = "SELFHOST_GATEWAY_ADMIN_KEY";
export const GATEWAY_INTERVAL_MS = 5 * 60 * 1000;

/** What a gateway cannot do from here, said wherever its keys or limits are shown. */
export const GATEWAY_NOTES = [
  "Subscription logins (Claude Pro or Max, ChatGPT plans) do not go through the gateway, so their use cannot be stopped from outside: selfhost forecasts it and alerts. Only API key traffic sent with a gateway key is capped.",
  "Cursor and GitHub Copilot send model traffic from their own servers and cannot use the gateway.",
];

const LITELLM_NOTE =
  "LiteLLM holds one budget window per key and per team: the shortest [budget] period is enforced there, the others are alerts. Fallbacks are set in LiteLLM's own router settings.";

/**
 * The gateway from [integrations.router] in the server's selfhost.toml (SELFHOST_CONFIG), else
 * from SELFHOST_GATEWAY_TOOL, which compose.gateway.yml sets for the bundled Bifrost. The admin
 * key is read from the environment variable admin_key_env names and goes only to the gateway.
 */
export function gatewayFromEnv(
  config: ResolvedSelfhostConfig,
  env: NodeJS.ProcessEnv = process.env,
): Gateway | undefined {
  const router = config.integrations?.router;
  const named = router?.tool ?? env.SELFHOST_GATEWAY_TOOL?.trim();
  if (!named) return undefined;
  if (!(ROUTER_TOOLS as readonly string[]).includes(named)) {
    throw new Error(`SELFHOST_GATEWAY_TOOL: expected ${ROUTER_TOOLS.join(" or ")}, got "${named}"`);
  }
  const tool = named as RouterTool;
  const url =
    router?.url ??
    (env.SELFHOST_GATEWAY_URL?.trim() || undefined) ??
    (tool === "bifrost" ? BUNDLED_BIFROST_URL : undefined);
  if (!url)
    throw new Error("[integrations.router] tool = litellm needs url: the LiteLLM proxy's address");
  const keyEnv = router?.admin_key_env ?? DEFAULT_ADMIN_KEY_ENV;
  const key = env[keyEnv]?.trim();
  if (!key) {
    throw new Error(
      `The ${tool} gateway needs its admin key in ${keyEnv} on the server (${tool === "litellm" ? "the master key" : "the Bifrost admin password"})`,
    );
  }
  const client =
    tool === "bifrost"
      ? bifrostClient({
          url,
          username: env.SELFHOST_GATEWAY_ADMIN_USER?.trim() || BUNDLED_BIFROST_USER,
          password: key,
        })
      : litellmClient({ url, masterKey: key });
  const publicUrl = env.SELFHOST_PUBLIC_URL?.trim().replace(/\/+$/, "");
  const baseUrl =
    router?.public_url ??
    (env.SELFHOST_GATEWAY_PUBLIC_URL?.trim() || undefined) ??
    (tool === "bifrost" && publicUrl ? `${publicUrl}/llm` : url);
  return {
    client,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    ...(router?.providers ? { fallbackProviders: router.providers } : {}),
    state: { sync: null, usage: null },
  };
}

const issueBody = createValidator(IssueGatewayKeyRequestSchema);

async function configOf(ledger: Ledger, team: string) {
  try {
    return (await ledger.orgs.effectivePolicy(team))?.config;
  } catch {
    return undefined;
  }
}

const publicKey = ({ providers: _providers, ...key }: ManagedKey): GatewayKey => key;

function noGateway(c: Context) {
  return c.json(
    apiError(
      "no_gateway",
      "No AI gateway is configured on this server. Start it with selfhost up --gateway, or set [integrations.router] in the server's selfhost.toml.",
    ),
    404,
  );
}

function gatewayFailed(c: Context, error: unknown) {
  if (!(error instanceof GatewayError)) throw error;
  return c.json(apiError("gateway_error", error.message), 502);
}

function teamOf(c: Context, caller: Caller, given: string | undefined): string | Response {
  if (given) return given;
  if (caller.kind === "person") return caller.person.team;
  return c.json(apiError("invalid_request", "team: Expected a team with the admin token"), 400);
}

/**
 * GET /v1/gateway, GET and POST /v1/gateway/keys, for both kinds of token. Key values appear only
 * in the answer to the POST that issued them.
 */
export function gatewayRoutes(router: Router, ledger: Ledger, gateway: Gateway | undefined): void {
  router.on("GET", "/v1/gateway", async (c, caller) => {
    if (!gateway) return noGateway(c);
    const team = teamOf(c, caller, c.req.query("team"));
    if (team instanceof Response) return team;
    const refused = await authorize(c, caller, team, "read");
    if (refused) return refused;
    const { client } = gateway;
    const config = await configOf(ledger, team);
    const health = await client.health();
    let key: GatewayKey | null = null;
    let teamBudgets: GatewayStatus["team_budgets"] = [];
    let detail = health.detail;
    try {
      const [keys, teams] = await Promise.all([client.keys(), client.teams()]);
      const own = caller.kind === "person" ? caller.person.id : undefined;
      const found = keys.find((k) => k.kind === "person" && k.team === team && k.person === own);
      key = found ? publicKey(found) : null;
      teamBudgets = teams.find((t) => t.team === team)?.budgets ?? [];
    } catch (error) {
      if (!(error instanceof GatewayError)) throw error;
      detail ??= error.message;
    }
    const status: GatewayStatus = {
      tool: client.tool,
      base_url: gateway.baseUrl,
      healthy: health.ok && detail === undefined,
      ...(detail ? { detail } : {}),
      team,
      mode: budgetMode(config?.budget),
      team_budgets: teamBudgets,
      key,
      last_sync: gateway.state.sync,
      last_usage: gateway.state.usage,
      notes: client.tool === "litellm" ? [...GATEWAY_NOTES, LITELLM_NOTE] : [...GATEWAY_NOTES],
    };
    return c.json(status);
  });

  router.on("GET", "/v1/gateway/keys", async (c, caller) => {
    if (!gateway) return noGateway(c);
    const team = teamOf(c, caller, c.req.query("team"));
    if (team instanceof Response) return team;
    const refused = await authorize(c, caller, team, "settings.write");
    if (refused) return refused;
    try {
      const keys = (await gateway.client.keys()).filter((k) => k.team === team).map(publicKey);
      return c.json({ team, keys } satisfies GatewayKeysResponse);
    } catch (error) {
      return gatewayFailed(c, error);
    }
  });

  router.on(
    "POST",
    "/v1/gateway/keys",
    async (c, caller) => {
      if (!gateway) return noGateway(c);
      const body = await readBody(c, issueBody);
      if (body instanceof Response) return body;
      const kind = body.kind ?? "person";
      const team = teamOf(c, caller, body.team);
      if (team instanceof Response) return team;
      if (kind === "person" && caller.kind === "admin") {
        return c.json(
          apiError(
            "forbidden",
            "A person's gateway key goes only to that person: they ask for it with their own token (selfhost gateway connect).",
          ),
          403,
        );
      }
      if (kind === "run") {
        // The runner mints each background run's key itself, capped, and revokes it when the
        // run ends; a key minted here would have no cap and could replace a live run's key.
        return c.json(
          apiError(
            "forbidden",
            "Run keys are issued by the server to its background runs only. Ask for your own key (kind person), or a team key with an owner's or admin's token.",
          ),
          403,
        );
      }
      const refused = await authorize(c, caller, team, kind === "team" ? "settings.write" : "work");
      if (refused) return refused;
      const person = caller.kind === "person" ? caller.person.id : undefined;
      // A person key carries its person, so revoking them turns it off at the next sync.
      const owner: KeyOwner = { kind, team, ...(kind === "person" && person ? { person } : {}) };
      try {
        const result = await issueKey(gateway.client, owner, await configOf(ledger, team), {
          ...(body.rotate ? { rotate: true } : {}),
          ...(gateway.fallbackProviders ? { fallbackProviders: gateway.fallbackProviders } : {}),
        });
        if ("exists" in result) {
          return c.json(
            apiError(
              "key_exists",
              `${result.exists.name} exists. Its value was shown once, when it was issued; ask again with rotate to replace it (selfhost gateway connect --rotate).`,
            ),
            409,
          );
        }
        c.header("cache-control", "no-store");
        const answer: IssueGatewayKeyResponse = {
          key: publicKey(result.issued.key),
          value: result.issued.value,
          base_url: gateway.baseUrl,
          tool: gateway.client.tool,
        };
        return c.json(answer, 201);
      } catch (error) {
        return gatewayFailed(c, error);
      }
    },
    limit(SMALL_BODY_BYTES),
  );
}

/** POST /v1/gateway/sync, admin token only: register it after the admin token check. */
export function gatewayAdminRoutes(app: Hono, ledger: Ledger, gateway: Gateway | undefined): void {
  app.post("/v1/gateway/sync", async (c) => {
    if (!gateway) return noGateway(c);
    return c.json(await syncNow(ledger, gateway));
  });
}

/**
 * Every team on the server with its policy in use and the people who can still sign in to it:
 * in the team with a person token that is not revoked. Revoking someone (selfhost team revoke)
 * turns their gateway key off at the next sync.
 */
async function teamInputs(ledger: Ledger): Promise<TeamInput[]> {
  const db = databaseOf(ledger);
  const orgs = await db.query<{ id: string }>("SELECT id FROM orgs ORDER BY id");
  const inputs: TeamInput[] = [];
  for (const { id: org } of orgs) {
    for (const team of await ledger.teams.listTeams(org)) {
      const people = await db.query<{ person_id: string }>(
        `SELECT DISTINCT p.id AS person_id FROM people p
           JOIN tokens t ON t.team_id = p.team_id AND t.person_id = p.id
          WHERE p.team_id = $1 AND t.kind = 'person' AND t.revoked_at IS NULL`,
        [team.id],
      );
      inputs.push({
        team: team.id,
        config: await configOf(ledger, team.id),
        people: people.map((row) => row.person_id),
      });
    }
  }
  return inputs;
}

/**
 * Appends gateway events, each team's under that team so its people read them. Ids come from
 * the gateway's request ids, so events already stored count as duplicates.
 */
async function appendByTeam(ledger: Ledger, events: LedgerEvent[]) {
  const groups = new Map<string | undefined, LedgerEvent[]>();
  for (const event of events) {
    const list = groups.get(event.team) ?? [];
    list.push(event);
    groups.set(event.team, list);
  }
  let accepted = 0;
  let duplicates = 0;
  for (const [team, list] of groups) {
    const result = await ledger.append(list, team ? { team } : {});
    accepted += result.accepted.length;
    duplicates += result.duplicates.length;
  }
  return { accepted, duplicates };
}

/** Writes teams, budgets and key settings to the gateway, and records spent budgets. */
export async function syncNow(
  ledger: Ledger,
  gateway: Gateway,
  now: () => Date = () => new Date(),
): Promise<GatewaySyncReport> {
  const result = await syncGateway(gateway.client, await teamInputs(ledger), {
    now,
    runEnded: async (runId) => {
      const run = await ledger.backgroundRuns.get(runId);
      return !run || isFinalRunState(run.state);
    },
    ...(gateway.fallbackProviders ? { fallbackProviders: gateway.fallbackProviders } : {}),
  });
  if (result.alerts.length > 0) {
    try {
      result.report.alerts = (await appendByTeam(ledger, result.alerts)).accepted;
    } catch (error) {
      if (!(error instanceof LedgerValidationError)) throw error;
      result.report.errors.push(`budget alerts: ${error.message}`);
    }
  }
  gateway.state.sync = result.report;
  return result.report;
}

/**
 * Where the next usage read starts: an hour before the newest gateway request in the ledger
 * (budget alerts the sync writes are not requests and do not count).
 */
async function usageStart(ledger: Ledger, now: Date): Promise<Date> {
  const [row] = await databaseOf(ledger).query<{ ts: unknown }>(
    `SELECT ts FROM events WHERE source = 'gateway'
       AND (body->'data'->>'alert') IS DISTINCT FROM $1
     ORDER BY ts DESC LIMIT 1`,
    [BUDGET_SPENT_ALERT],
  );
  if (!row) return new Date(now.getTime() - USAGE_FIRST_LOOKBACK_MS);
  return new Date(new Date(row.ts as string).getTime() - USAGE_OVERLAP_MS);
}

/** Reads the gateway's finished requests into the ledger. */
export async function readUsageNow(
  ledger: Ledger,
  gateway: Gateway,
  now: () => Date = () => new Date(),
): Promise<GatewayUsageReport> {
  const at = now();
  const from = gateway.state.usageFrom ?? (await usageStart(ledger, at));
  const { report, next } = await readUsage(
    gateway.client,
    from,
    (events) => appendByTeam(ledger, events),
    { now: at },
  );
  gateway.state.usage = report;
  gateway.state.usageFrom = next;
  return report;
}

export interface GatewayJob {
  run(): Promise<void>;
  /** Writes the policies to the gateway now (what a policy change triggers); usage waits. */
  push(): Promise<void>;
  stop(): void;
}

/**
 * Syncs the gateway and reads its usage now and every intervalMs, and writes the policies to it
 * as soon as one changes (gateway.policyChanged). A run still going when the next is due is not
 * started twice, a run and a push never write at the same time, the timer never keeps the
 * process alive, and the log names counts and errors, never keys.
 */
export function startGatewayJob(
  ledger: Ledger,
  gateway: Gateway,
  options: { intervalMs?: number; log?: (line: string) => void; now?: () => Date } = {},
): GatewayJob {
  const { intervalMs = GATEWAY_INTERVAL_MS, log = console.log } = options;
  const now = options.now ?? (() => new Date());
  let running: Promise<void> | undefined;
  let pushing: Promise<void> | undefined;
  let again = false;
  const failed = (error: unknown) => {
    log(`gateway: ${error instanceof Error ? error.message : error}`);
  };
  const sync = async () => {
    const report = await syncNow(ledger, gateway, now);
    for (const error of report.errors) log(`gateway: ${error}`);
    if (report.created + report.updated + report.deactivated + report.alerts > 0) {
      log(
        `gateway: ${report.created} teams created, ${report.updated} updated, ${report.deactivated} keys turned off, ${report.alerts} budget alerts`,
      );
    }
  };
  const once = async () => {
    await sync();
    const usage = await readUsageNow(ledger, gateway, now);
    if (usage.error) log(`gateway: reading usage: ${usage.error}`);
    else if (usage.events > 0) log(`gateway: ${usage.events} requests into the ledger`);
  };
  const run = () => {
    const after = pushing ?? Promise.resolve();
    running ??= after
      .then(once)
      .catch(failed)
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  // A change while a push writes is pushed again after it, since that push may have read the
  // policies before the change.
  const push = () => {
    if (pushing) {
      again = true;
      return pushing;
    }
    const after = running ?? Promise.resolve();
    pushing = after
      .then(async () => {
        do {
          again = false;
          await sync();
        } while (again);
      })
      .catch(failed)
      .finally(() => {
        pushing = undefined;
      });
    return pushing;
  };
  gateway.policyChanged = () => {
    void push();
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  void run();
  return {
    run,
    push,
    stop: () => {
      clearInterval(timer);
      gateway.policyChanged = undefined;
    },
  };
}

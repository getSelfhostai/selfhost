import { mapBifrostLog } from "@selfhost/ledger";
import type { GatewayBudget, GatewayBudgetPeriod, LedgerEvent } from "@selfhost/schema";
import { createHttp, type Fetch } from "./http.js";
import {
  keyMetadata,
  keyName,
  NAME_PREFIX,
  ownerFromMetadata,
  RUN_KEY_TTL_MS,
  teamName,
} from "./policy.js";
import type {
  BudgetLimit,
  GatewayClient,
  IssuedKey,
  KeyOwner,
  KeySettings,
  ManagedKey,
  ManagedTeam,
} from "./types.js";

/**
 * Bifrost (github.com/maximhq/bifrost, Apache 2.0) through its management API, v2.4:
 * /api/governance/teams and /api/governance/virtual-keys for teams, keys and budgets, /api/logs
 * for request logs, /health. With admin auth on (governance.auth_config), management calls take
 * HTTP basic auth with the admin username and password.
 */
export interface BifrostOptions {
  url: string;
  /** auth_config admin_username; the bundled config uses "selfhost". */
  username: string;
  /** auth_config admin_password. */
  password: string;
  fetch?: Fetch;
  minIntervalMs?: number;
  now?: () => Date;
}

/** Bifrost reset durations for each period. Budgets are calendar aligned, in UTC. */
const RESET: Record<GatewayBudgetPeriod, string> = {
  day: "1d",
  week: "1w",
  month: "1M",
  run: "1Y",
};
const PERIOD_OF = Object.fromEntries(Object.entries(RESET).map(([p, d]) => [d, p])) as Record<
  string,
  GatewayBudgetPeriod
>;
const PAGE = 100;
const LOG_PAGE = 1000;

interface BifrostBudget {
  id?: string;
  max_limit?: number;
  reset_duration?: string;
  current_usage?: number;
}

interface BifrostTeam {
  id: string;
  name: string;
  budgets?: BifrostBudget[];
}

interface BifrostProviderConfig {
  provider: string;
  weight?: number | null;
}

interface BifrostKey {
  id: string;
  name: string;
  value?: string;
  is_active: boolean;
  team_id?: string;
  metadata?: Record<string, unknown>;
  budgets?: BifrostBudget[];
  provider_configs?: BifrostProviderConfig[];
  allow_all_providers?: boolean;
}

function budgetsOf(list: BifrostBudget[] | undefined): GatewayBudget[] {
  return (list ?? []).flatMap((b) => {
    const period = PERIOD_OF[b.reset_duration ?? ""];
    if (!period || typeof b.max_limit !== "number") return [];
    return [
      {
        period,
        limit_usd: b.max_limit,
        spent_usd: typeof b.current_usage === "number" ? b.current_usage : null,
      },
    ];
  });
}

const budgetBody = (limits: BudgetLimit[]) =>
  limits.map((limit) => ({
    max_limit: limit.limit_usd,
    reset_duration: RESET[limit.period],
    calendar_aligned: limit.period !== "run",
  }));

/**
 * Fallbacks: Bifrost tries a key's other providers in order of weight when a request has none of
 * its own. The first provider gets weight 1 and all the traffic; the rest get 0, so they are
 * only fallbacks.
 */
function providerBody(settings: KeySettings) {
  if (settings.providers.length === 0) return { allow_all_providers: true, provider_configs: [] };
  return {
    allow_all_providers: false,
    provider_configs: settings.providers.map((provider, index) => ({
      provider,
      weight: index === 0 ? 1 : 0,
      allowed_models: ["*"],
      key_ids: ["*"],
    })),
  };
}

function providersOf(key: BifrostKey): string[] {
  if (key.allow_all_providers || !key.provider_configs?.length) return [];
  return [...key.provider_configs]
    .sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1))
    .map((config) => config.provider);
}

function managed(key: BifrostKey): ManagedKey | undefined {
  const owner = ownerFromMetadata(key.metadata);
  if (!owner || !key.name.startsWith(NAME_PREFIX)) return undefined;
  return {
    id: key.id,
    name: key.name,
    ...owner,
    active: key.is_active,
    budgets: budgetsOf(key.budgets),
    providers: providersOf(key),
  };
}

export function bifrostClient(options: BifrostOptions): GatewayClient {
  const now = options.now ?? (() => new Date());
  const basic = Buffer.from(`${options.username}:${options.password}`).toString("base64");
  const http = createHttp({
    baseUrl: options.url.replace(/\/+$/, ""),
    headers: { authorization: `Basic ${basic}` },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
  });

  const keyBody = (owner: KeyOwner, settings: KeySettings, team?: ManagedTeam) => ({
    name: keyName(owner),
    description: "Managed by selfhost from selfhost.toml. Changes made here are overwritten.",
    metadata: keyMetadata(owner),
    budgets: budgetBody(settings.budgets),
    is_active: settings.active,
    ...providerBody(settings),
    ...(team ? { team_id: team.id } : {}),
    ...(owner.kind === "run"
      ? {
          expires_at: new Date(now().getTime() + RUN_KEY_TTL_MS).toISOString(),
          delete_after_expire: true,
        }
      : {}),
  });

  function issued(key: BifrostKey | undefined): IssuedKey {
    const found = key ? managed(key) : undefined;
    if (!key?.value || !found) throw new Error("Bifrost answered without the key it created");
    return { key: found, value: key.value };
  }

  return {
    tool: "bifrost",
    held: (limits) => limits,
    heldProviders: (providers) => providers,

    async health() {
      try {
        const body = await http.call<{ status?: string; components?: Record<string, string> }>(
          "GET",
          "/health",
        );
        if (body?.status === "ok") return { ok: true };
        return {
          ok: false,
          detail: `Bifrost /health answered ${JSON.stringify(body).slice(0, 200)}`,
        };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },

    async teams() {
      const body = await http.call<{ teams?: BifrostTeam[] }>("GET", "/api/governance/teams");
      return (body.teams ?? []).flatMap((team) =>
        team.name.startsWith(NAME_PREFIX)
          ? [
              {
                id: team.id,
                team: team.name.slice(NAME_PREFIX.length),
                budgets: budgetsOf(team.budgets),
              },
            ]
          : [],
      );
    },

    async createTeam(team, budgets) {
      const body = await http.call<{ team?: BifrostTeam }>("POST", "/api/governance/teams", {
        name: teamName(team),
        budgets: budgetBody(budgets),
      });
      if (!body.team?.id) throw new Error("Bifrost answered without the team it created");
      return { id: body.team.id, team, budgets: budgetsOf(body.team.budgets) };
    },

    async updateTeam(existing, budgets) {
      await http.call("PUT", `/api/governance/teams/${encodeURIComponent(existing.id)}`, {
        name: teamName(existing.team),
        budgets: budgetBody(budgets),
      });
    },

    async keys() {
      const keys: ManagedKey[] = [];
      // Paged, by name. Any key value in the answer is dropped by managed() and goes nowhere.
      for (let offset = 0; ; offset += PAGE) {
        const body = await http.call<{ virtual_keys?: BifrostKey[]; total_count?: number }>(
          "GET",
          `/api/governance/virtual-keys?limit=${PAGE}&offset=${offset}&search=${encodeURIComponent(NAME_PREFIX)}`,
        );
        const page = body.virtual_keys ?? [];
        for (const key of page) {
          const found = managed(key);
          if (found) keys.push(found);
        }
        if (page.length < PAGE || offset + PAGE >= (body.total_count ?? 0)) break;
      }
      return keys;
    },

    async createKey(owner, settings, team) {
      const body = await http.call<{ virtual_key?: BifrostKey }>(
        "POST",
        "/api/governance/virtual-keys",
        keyBody(owner, settings, team),
      );
      return issued(body.virtual_key);
    },

    async updateKey(existing, settings) {
      const {
        expires_at: _expires,
        delete_after_expire: _delete,
        ...body
      } = keyBody(existing, settings);
      await http.call(
        "PUT",
        `/api/governance/virtual-keys/${encodeURIComponent(existing.id)}`,
        body,
      );
    },

    async rotateKey(existing) {
      const body = await http.call<{ virtual_key?: BifrostKey }>(
        "POST",
        `/api/governance/virtual-keys/${encodeURIComponent(existing.id)}/rotate`,
      );
      return issued(body.virtual_key);
    },

    async *requests(from, to, maxPages) {
      for (let page = 0; page < maxPages; page++) {
        const query = new URLSearchParams({
          start_time: from.toISOString(),
          end_time: to.toISOString(),
          status: "success,error",
          sort_by: "timestamp",
          order: "asc",
          limit: String(LOG_PAGE),
          offset: String(page * LOG_PAGE),
        });
        const body = await http.call<{
          logs?: unknown[];
          pagination?: { total_count?: number };
        }>("GET", `/api/logs?${query}`);
        const logs = body.logs ?? [];
        const events: LedgerEvent[] = logs.flatMap((log) => mapBifrostLog(log));
        yield events;
        if (
          logs.length < LOG_PAGE ||
          (page + 1) * LOG_PAGE >= (body.pagination?.total_count ?? 0)
        ) {
          return;
        }
      }
    },
  };
}

import { mapGatewayLog, SourcePayloadError } from "@selfhost/ledger";
import type { GatewayBudget, GatewayBudgetPeriod, LedgerEvent } from "@selfhost/schema";
import { createHttp, type Fetch } from "./http.js";
import { keyMetadata, keyName, NAME_PREFIX, ownerFromMetadata, RUN_KEY_TTL_MS } from "./policy.js";
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
 * A LiteLLM proxy the team already runs, through its management API with the master key:
 * /team/new, /team/update, /team/list, /key/generate, /key/update, /key/list, /key/block,
 * /key/unblock, /key/delete, /spend/logs/v2 and /health/liveliness.
 *
 * LiteLLM keeps one budget window per key and per team (max_budget with budget_duration), so of
 * several [budget] periods the shortest is enforced and the others stay alerts. Provider
 * fallbacks are router settings in LiteLLM's own config, not per key, so they are not written.
 */
export interface LiteLLMOptions {
  url: string;
  /** The master key. */
  masterKey: string;
  fetch?: Fetch;
  minIntervalMs?: number;
}

const DURATION: Record<GatewayBudgetPeriod, string | undefined> = {
  day: "1d",
  week: "7d",
  month: "30d",
  run: undefined,
};
const PERIOD_OF: Record<string, GatewayBudgetPeriod> = {
  "1d": "day",
  "7d": "week",
  "30d": "month",
};
const ORDER: GatewayBudgetPeriod[] = ["day", "week", "month", "run"];
const PAGE = 100;
const LOG_PAGE = 1000;

/** The one limit LiteLLM can hold: the shortest period given. */
export function litellmLimit(limits: BudgetLimit[]): BudgetLimit | undefined {
  return [...limits].sort((a, b) => ORDER.indexOf(a.period) - ORDER.indexOf(b.period))[0];
}

const teamId = (team: string) => `selfhost-${team}`;

function budgetBody(limits: BudgetLimit[]) {
  const limit = litellmLimit(limits);
  if (!limit) return { max_budget: null, budget_duration: null };
  return { max_budget: limit.limit_usd, budget_duration: DURATION[limit.period] ?? null };
}

interface LiteLLMBudgeted {
  max_budget?: number | null;
  budget_duration?: string | null;
  spend?: number | null;
}

function budgetsOf(row: LiteLLMBudgeted, runKey: boolean): GatewayBudget[] {
  if (typeof row.max_budget !== "number") return [];
  const period = runKey ? "run" : PERIOD_OF[row.budget_duration ?? ""];
  if (!period) return [];
  return [
    {
      period,
      limit_usd: row.max_budget,
      spent_usd: typeof row.spend === "number" ? row.spend : null,
    },
  ];
}

interface LiteLLMTeam extends LiteLLMBudgeted {
  team_id: string;
  team_alias?: string | null;
}

interface LiteLLMKey extends LiteLLMBudgeted {
  /** The key's hash: its id in every management call. */
  token: string;
  key_alias?: string | null;
  metadata?: Record<string, unknown> | string | null;
  blocked?: boolean | null;
}

const objectOf = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value === "string") {
    try {
      return objectOf(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
};

function arrayOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function managed(key: LiteLLMKey): ManagedKey | undefined {
  const owner = ownerFromMetadata(objectOf(key.metadata));
  if (!owner || !key.key_alias?.startsWith(NAME_PREFIX)) return undefined;
  return {
    id: key.token,
    name: key.key_alias,
    ...owner,
    active: key.blocked !== true,
    budgets: budgetsOf(key, owner.kind === "run"),
    providers: [],
  };
}

/**
 * One row of LiteLLM's spend logs (the LiteLLM_SpendLogs table, as /spend/logs/v2 returns it)
 * in the StandardLoggingPayload shape mapGatewayLog reads.
 */
export function spendRowToPayload(row: Record<string, unknown>): Record<string, unknown> {
  const metadata = objectOf(row.metadata) ?? {};
  const seconds = (value: unknown) =>
    typeof value === "string"
      ? Date.parse(value) / 1000
      : typeof value === "number"
        ? value
        : undefined;
  const tags = arrayOf(row.request_tags);
  return {
    id: row.request_id,
    startTime: seconds(row.startTime),
    endTime: seconds(row.endTime),
    model: row.model,
    custom_llm_provider: row.custom_llm_provider,
    call_type: row.call_type,
    response_cost: row.spend,
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
    status: row.status ?? metadata.status,
    cache_hit: row.cache_hit === true || row.cache_hit === "True",
    request_tags: tags,
    end_user: row.end_user,
    error_str: objectOf(metadata.error_information)?.error_message,
    metadata: {
      ...metadata,
      user_api_key_user_id: metadata.user_api_key_user_id ?? row.user,
      spend_logs_metadata: {
        ...(objectOf(metadata.spend_logs_metadata) ?? {}),
        ...(typeof row.session_id === "string" ? { session_id: row.session_id } : {}),
      },
    },
  };
}

/** LiteLLM's v2 spend log filter takes "YYYY-MM-DD HH:MM:SS" in UTC. */
const sqlTime = (date: Date) => date.toISOString().slice(0, 19).replace("T", " ");

export function litellmClient(options: LiteLLMOptions): GatewayClient {
  const http = createHttp({
    baseUrl: options.url.replace(/\/+$/, ""),
    headers: { authorization: `Bearer ${options.masterKey}` },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
  });

  async function generate(owner: KeyOwner, settings: KeySettings): Promise<IssuedKey> {
    const body = await http.call<LiteLLMKey & { key?: string }>("POST", "/key/generate", {
      key_alias: keyName(owner),
      team_id: teamId(owner.team),
      ...(owner.person ? { user_id: owner.person } : {}),
      metadata: keyMetadata(owner),
      ...budgetBody(settings.budgets),
      ...(owner.kind === "run" ? { duration: `${RUN_KEY_TTL_MS / 3_600_000}h` } : {}),
      blocked: !settings.active,
    });
    const key = managed({ ...body, metadata: body.metadata ?? keyMetadata(owner) });
    if (!body.key || !key) throw new Error("LiteLLM answered without the key it created");
    return { key, value: body.key };
  }

  return {
    tool: "litellm",
    held: (limits) => {
      const limit = litellmLimit(limits);
      return limit ? [limit] : [];
    },
    heldProviders: () => [],

    async health() {
      try {
        await http.call("GET", "/health/liveliness");
        return { ok: true };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },

    async teams() {
      const body = await http.call<LiteLLMTeam[] | { teams?: LiteLLMTeam[] }>("GET", "/team/list");
      const list = Array.isArray(body) ? body : (body.teams ?? []);
      return list.flatMap((team) =>
        team.team_id.startsWith(teamId(""))
          ? [
              {
                id: team.team_id,
                team: team.team_id.slice(teamId("").length),
                budgets: budgetsOf(team, false),
              },
            ]
          : [],
      );
    },

    async createTeam(team, budgets) {
      await http.call("POST", "/team/new", {
        team_id: teamId(team),
        team_alias: team,
        metadata: { selfhost_team: team },
        ...budgetBody(budgets),
      });
      return { id: teamId(team), team, budgets: [] } satisfies ManagedTeam;
    },

    async updateTeam(existing, budgets) {
      await http.call("POST", "/team/update", { team_id: existing.id, ...budgetBody(budgets) });
    },

    async keys() {
      const keys: ManagedKey[] = [];
      for (let page = 1; ; page++) {
        const body = await http.call<{ keys?: LiteLLMKey[]; total_pages?: number }>(
          "GET",
          `/key/list?return_full_object=true&include_team_keys=true&page=${page}&size=${PAGE}`,
        );
        for (const key of body.keys ?? []) {
          const found = typeof key === "object" ? managed(key) : undefined;
          if (found) keys.push(found);
        }
        if ((body.keys ?? []).length < PAGE || page >= (body.total_pages ?? 1)) break;
      }
      return keys;
    },

    createKey: (owner, settings) => generate(owner, settings),

    async updateKey(existing, settings) {
      await http.call("POST", "/key/update", {
        key: existing.id,
        metadata: keyMetadata(existing),
        ...budgetBody(settings.budgets),
      });
      if (existing.active !== settings.active) {
        await http.call("POST", settings.active ? "/key/unblock" : "/key/block", {
          key: existing.id,
        });
      }
    },

    async rotateKey(existing, settings) {
      // Regenerating in place is a LiteLLM Enterprise feature; a new key replaces the old one.
      // Its spend so far starts again at 0; the team's budget still holds.
      await http.call("POST", "/key/delete", { keys: [existing.id] });
      return generate(existing, settings);
    },

    async *requests(from, to, maxPages) {
      for (let page = 1; page <= maxPages; page++) {
        const query = new URLSearchParams({
          start_date: sqlTime(from),
          end_date: sqlTime(to),
          page: String(page),
          page_size: String(LOG_PAGE),
        });
        const body = await http.call<{ data?: Record<string, unknown>[]; total_pages?: number }>(
          "GET",
          `/spend/logs/v2?${query}`,
        );
        const rows = body.data ?? [];
        const events: LedgerEvent[] = rows.flatMap((row) => {
          try {
            return mapGatewayLog(spendRowToPayload(row));
          } catch (error) {
            if (error instanceof SourcePayloadError) return [];
            throw error;
          }
        });
        yield events;
        if (rows.length < LOG_PAGE || page >= (body.total_pages ?? page)) return;
      }
    },
  };
}

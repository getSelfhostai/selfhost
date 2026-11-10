import type { AgentRef, LedgerEvent, SecondOpinion } from "@selfhost/schema";

/**
 * Bodies of routes the server is gaining in other changes. The console reads them when they
 * answer and shows an empty state while they answer 404.
 */

/** GET /v1/teams/{team}/roi?from&to: cost per merged pull request. */
export interface RoiReport {
  schema: "selfhost.roi/v1";
  team: string;
  from: string;
  to: string;
  merged_prs: number;
  cost_usd: number;
  cost_per_merged_pr: number | null;
  baseline: {
    from: string;
    to: string;
    merged_prs: number;
    cost_usd: number;
    cost_per_merged_pr: number | null;
  } | null;
  by_agent: {
    agent: string;
    model: string | null;
    merged_prs: number;
    cost_usd: number;
    cost_per_merged_pr: number | null;
  }[];
}

/** GET /v1/runs/{run_id}?limit&cursor: one agent run with a page of its ledger events. */
export interface RunReport {
  schema: "selfhost.run/v1";
  run: {
    id: string;
    agent: AgentRef | null;
    model: string | null;
    person: string | null;
    team: string | null;
    repo: string | null;
    started_at: string | null;
    /** null while the run is still going. */
    ended_at: string | null;
    cost_usd: number;
    /** Every token count added up. */
    tokens: number;
    /** Share of input read from the prompt cache; null when unknown. Absent on older servers. */
    cache_hit_rate?: number | null;
    /** One line when the run cost a lot at a low hit rate. */
    cache_tip?: string | null;
  };
  events: LedgerEvent[];
  /** second_opinions: the newest verdict of each AI reviewer on the pull request. */
  prs: { url: string; state: string; second_opinions?: SecondOpinion[] }[];
  trace_url: string | null;
  /** Pass as cursor for the next page of events; null on the last page. */
  next_cursor: string | null;
}

/** Links review items carry on servers that know the item's run. */
export interface ReviewItemLinks {
  run_url?: string;
  trace_url?: string;
}

export const INTEGRATION_KINDS = ["router", "tracer", "runtime", "reviewer"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export type IntegrationStatus = "connected" | "not_configured" | "error";

export interface Integration {
  tool: string | null;
  status: IntegrationStatus;
  detail: string;
  settings: Record<string, unknown>;
  /** server_environment: the server's own setup, shown while the team's policy picks none. */
  source?: "policy" | "server_environment";
}

/** GET /v1/integrations; PUT /v1/integrations/{kind} takes { tool, settings }. */
export interface IntegrationsReport {
  schema: "selfhost.integrations/v1";
  team: string;
  integrations: Record<IntegrationKind, Integration>;
}

import {
  INTEGRATION_KINDS,
  type IntegrationKind,
  type IntegrationState,
  type Integrations,
} from "@selfhost/schema";
import { bifrost } from "./adapters/bifrost.js";
import { claudeCodeAction } from "./adapters/claude-code-action.js";
import { coder } from "./adapters/coder.js";
import { coderabbit } from "./adapters/coderabbit.js";
import { datadog } from "./adapters/datadog.js";
import { daytona } from "./adapters/daytona.js";
import { e2b } from "./adapters/e2b.js";
import { langfuse } from "./adapters/langfuse.js";
import { litellm } from "./adapters/litellm.js";
import { modal } from "./adapters/modal.js";
import { otlp } from "./adapters/otlp.js";
import { phoenix } from "./adapters/phoenix.js";
import { prAgent } from "./adapters/pr-agent.js";
import type { AnyAdapter, CheckResult, Env, Fetch, RepoView } from "./types.js";

/** Every tool selfhost can connect, one adapter each. */
export const ADAPTERS: readonly AnyAdapter[] = [
  bifrost,
  litellm,
  langfuse,
  phoenix,
  datadog,
  otlp,
  e2b,
  daytona,
  modal,
  coder,
  prAgent,
  claudeCodeAction,
  coderabbit,
];

export function adapterFor(kind: IntegrationKind, tool: string): AnyAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.kind === kind && adapter.tool === tool);
}

export interface CheckContext {
  env: Env;
  fetch: Fetch;
  /** The team's repositories, for reviewer checks; read only when a reviewer is picked. */
  repos?: () => Promise<RepoView | undefined>;
  /** Clock for checked_at. Default: the system clock. */
  now?: () => Date;
}

export type IntegrationStates = Record<IntegrationKind, IntegrationState>;

/** "https://user:pass@host/x" to "https://***@host/x"; every other value as it is. */
function masked(value: unknown): unknown {
  if (typeof value === "string")
    return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, "$1***@");
  if (Array.isArray(value)) return value.map(masked);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, masked(item)]));
  }
  return value;
}

/** A table's settings without tool, safe to show: secrets are only named, URL credentials masked. */
export function publicSettings(
  table: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const { tool: _tool, ...settings } = table ?? {};
  return masked(settings) as Record<string, unknown>;
}

type Unstamped = Omit<IntegrationState, "checked_at">;

const NOT_CONFIGURED = (kind: IntegrationKind): Unstamped => ({
  tool: null,
  status: "not_configured",
  detail: `No ${kind} picked. Set [integrations.${kind}] in selfhost.toml, or selfhost integrations set ${kind} <tool>.`,
  settings: {},
});

/** A job's choice before any check: the tool, or null, and its public settings. */
export interface IntegrationChoice {
  tool: string | null;
  settings: Record<string, unknown>;
}

/** Each job's tool and settings, read from the config only; nothing is called. */
export function listIntegrations(
  integrations: Integrations | undefined,
): Record<IntegrationKind, IntegrationChoice> {
  return Object.fromEntries(
    INTEGRATION_KINDS.map((kind) => {
      const table = integrations?.[kind];
      return [kind, { tool: table?.tool ?? null, settings: publicSettings(table) }];
    }),
  ) as Record<IntegrationKind, IntegrationChoice>;
}

/** One job's check, before it is stamped with the time. */
async function checkOne(
  kind: IntegrationKind,
  integrations: Integrations | undefined,
  context: CheckContext,
): Promise<Unstamped> {
  const table = integrations?.[kind];
  if (!table) return NOT_CONFIGURED(kind);
  const settings = publicSettings(table);
  const adapter = adapterFor(kind, table.tool);
  if (!adapter) {
    return {
      tool: table.tool,
      status: "error",
      detail: `selfhost has no ${kind} adapter for ${table.tool}.`,
      settings,
    };
  }
  try {
    const { tool: _tool, ...own } = table;
    const repos = kind === "reviewer" ? await context.repos?.() : undefined;
    // Each adapter takes its own kind's settings, which the table above is.
    const check = adapter.check as (
      settings: unknown,
      env: Env,
      fetch: Fetch,
      repos?: RepoView,
    ) => Promise<CheckResult>;
    const result = await check(own, context.env, context.fetch, repos);
    return { tool: table.tool, ...result, settings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { tool: table.tool, status: "error", detail: `The check failed: ${message}`, settings };
  }
}

/** Checks one job's tool. A check that throws is an error, never an exception. */
export async function checkIntegration(
  kind: IntegrationKind,
  integrations: Integrations | undefined,
  context: CheckContext,
): Promise<IntegrationState> {
  const checked_at = (context.now?.() ?? new Date()).toISOString();
  return { ...(await checkOne(kind, integrations, context)), checked_at };
}

/** Checks every job at once. */
export async function checkIntegrations(
  integrations: Integrations | undefined,
  context: CheckContext,
): Promise<IntegrationStates> {
  const states = await Promise.all(
    INTEGRATION_KINDS.map((kind) => checkIntegration(kind, integrations, context)),
  );
  return Object.fromEntries(
    INTEGRATION_KINDS.map((kind, i) => [kind, states[i]]),
  ) as IntegrationStates;
}

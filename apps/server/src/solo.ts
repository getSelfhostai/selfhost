import { readFileSync } from "node:fs";
import { type IntegrationKind, parseConfig, type ResolvedRule } from "@selfhost/schema";
import type { Hono } from "hono";

/** The command that turns a solo laptop into a team, shown on the console's Team screen. */
export const TEAM_INIT_COMMAND = "selfhost team init";

/** GET /v1/solo: what the console shows of this laptop's own setup in solo mode. */
export interface SoloResponse {
  schema: "selfhost.solo/v1";
  /** The command that creates a team on a server, so others can join. */
  team_init: string;
  /** The selfhost.toml `selfhost console` was started next to; null when there is none. */
  policy:
    | {
        path: string;
        valid: true;
        rules: Pick<ResolvedRule, "id" | "mode" | "action" | "message">[];
        guardrails: { mode: string; disable: string[] };
        /** Each [integrations] job and the tool picked for it; secrets stay env var names. */
        integrations: Partial<Record<IntegrationKind, { tool: string }>>;
      }
    | { path: string; valid: false; errors: { field: string; message: string }[] }
    | null;
}

export interface SoloOptions {
  /** The selfhost.toml the CLI found where the console started; read again on each request. */
  policyPath?: string;
}

function policyOf(path: string | undefined): SoloResponse["policy"] {
  if (path === undefined) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const parsed = parseConfig(text);
  if (!parsed.ok) {
    return {
      path,
      valid: false,
      errors: parsed.errors.map(({ field, message }) => ({ field, message })),
    };
  }
  const { config } = parsed;
  const integrations: Partial<Record<IntegrationKind, { tool: string }>> = {};
  for (const [kind, value] of Object.entries(config.integrations ?? {})) {
    if (value && typeof value === "object" && typeof value.tool === "string") {
      integrations[kind as IntegrationKind] = { tool: value.tool };
    }
  }
  return {
    path,
    valid: true,
    rules: config.rules.map(({ id, mode, action, message }) => ({ id, mode, action, message })),
    guardrails: { mode: config.guardrails.mode, disable: [...config.guardrails.disable] },
    integrations,
  };
}

/**
 * GET /v1/solo, on the server `selfhost console` runs on a solo laptop only: the laptop's own
 * selfhost.toml rules and integrations, read-only, and how to start a team. A team server has no
 * such route, so the console asks for it only when the caller has no team.
 */
export function soloRoutes(app: Hono, options: SoloOptions): void {
  app.get("/v1/solo", (c) =>
    c.json({
      schema: "selfhost.solo/v1",
      team_init: TEAM_INIT_COMMAND,
      policy: policyOf(options.policyPath),
    } satisfies SoloResponse),
  );
}

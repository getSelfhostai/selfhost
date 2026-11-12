import type { Env } from "@selfhost/integrations";
import type { Ledger } from "@selfhost/ledger";
import {
  isRefused,
  RUNTIME_KINDS,
  type RuntimeConfig,
  type RuntimeForOptions,
  runtimeFor,
} from "@selfhost/runtime";
import type { LedgerEvent, RuntimeProvider } from "@selfhost/schema";
import { sandboxSpans, sandboxSpendIn } from "@selfhost/spend";

/** How far back the daily cap looks for sandboxes still running into today. */
const LOOKBACK_MS = 7 * 86_400_000;

/** A team's sandbox spend in a day from the ledger, leaving out `exclude`. */
export async function ledgerSandboxSpend(
  ledger: Ledger,
  team: string,
  exclude: ReadonlySet<string>,
  day: { from: Date; to: Date },
  now: Date,
): Promise<number> {
  const events: LedgerEvent[] = [];
  const from = new Date(day.from.getTime() - LOOKBACK_MS).toISOString();
  for (const kind of ["sandbox.started", "sandbox.stopped"]) {
    let cursor: string | undefined;
    do {
      const page = await ledger.query({ kind, team, from, limit: 1000, cursor });
      events.push(...page.events);
      cursor = page.nextCursor;
    } while (cursor);
  }
  return sandboxSpendIn(sandboxSpans(events).values(), day.from, day.to, now, exclude);
}

/** The settings that say where a runtime is and which server variable holds its key. */
const CONNECTION = ["url", "api_key_env", "api_secret_env"] as const;

/**
 * The settings the server's own config decides over a team's policy: where a runtime is, which
 * server variable holds its key, and what a sandbox costs (so a team cannot price itself under
 * its own daily cap). A team's value for a pricing field still applies when the server sets none.
 */
const SERVER_WINS: readonly string[] = [...CONNECTION, "usd_per_hour"];

/**
 * The server variable that gives a runtime's url when the server's selfhost.toml sets none, for
 * installs (Docker Compose) that configure the server through its environment:
 * SELFHOST_RUNTIME_OPENSANDBOX_URL, SELFHOST_RUNTIME_CODER_URL, and so on.
 */
export const runtimeUrlEnv = (kind: string) => `SELFHOST_RUNTIME_${kind.toUpperCase()}_URL`;

/**
 * A team's [runtime] merged with the server's own (SELFHOST_CONFIG) provider settings. Precedence
 * per field: url, api_key_env and api_secret_env come only from the server (its config, then
 * SELFHOST_RUNTIME_<KIND>_URL for the url), since a team's policy never says which server variable
 * is read as a key nor where that key is sent; usd_per_hour is the server's when it sets one, else
 * the team's; every other setting (template, create_timeout_seconds) is the team's when it sets
 * one, else the server's.
 */
export function serverConnections(
  team: RuntimeConfig,
  server: Pick<RuntimeConfig, "runtime" | "integrations"> | undefined,
  env: Env = {},
): RuntimeConfig {
  const serverSettings = (kind: string): Record<string, unknown> => {
    const found = (server?.runtime?.providers as Record<string, RuntimeProvider> | undefined)?.[
      kind
    ];
    const legacy = server?.integrations?.runtime;
    const source: Record<string, unknown> | undefined =
      found ?? (legacy?.tool === kind ? legacy : undefined);
    const { tool: _tool, url: _url, ...rest } = source ?? {};
    const url =
      (source?.url as string | undefined) ?? (env[runtimeUrlEnv(kind)]?.trim() || undefined);
    return Object.fromEntries(
      Object.entries({ ...rest, ...(url ? { url } : {}) }).filter(([, v]) => v !== undefined),
    );
  };
  const merged = (kind: string, teamSettings: RuntimeProvider | undefined): RuntimeProvider => {
    const own = serverSettings(kind);
    const teamRest = Object.fromEntries(
      Object.entries(teamSettings ?? {}).filter(
        ([field]) => !(CONNECTION as readonly string[]).includes(field),
      ),
    );
    const wins = Object.fromEntries(
      Object.entries(own).filter(([field]) => SERVER_WINS.includes(field)),
    );
    return { ...own, ...teamRest, ...wins } as RuntimeProvider;
  };
  const providers: Record<string, RuntimeProvider> = Object.fromEntries(
    Object.entries(team.runtime?.providers ?? {}).map(([kind, settings]) => [
      kind,
      merged(kind, settings),
    ]),
  );
  for (const [kind, settings] of Object.entries(server?.runtime?.providers ?? {})) {
    if (!(kind in providers) && settings) providers[kind] = merged(kind, undefined);
  }
  for (const kind of RUNTIME_KINDS) {
    if (!(kind in providers) && env[runtimeUrlEnv(kind)]?.trim())
      providers[kind] = merged(kind, undefined);
  }
  const { runtime: _legacy, ...integrations } = team.integrations ?? {};
  return {
    ...team,
    ...(team.integrations ? { integrations } : {}),
    runtime: { ...(team.runtime ?? {}), providers } as RuntimeConfig["runtime"],
  };
}

/**
 * The runtime seam for background runs on the server: runtime selection over the adapters with
 * the keys in the server's environment, sandbox lifecycle written to the ledger, and the team's
 * [budget] runtime caps read from it. Pass it to createBackground as `runtime`. A refusal comes
 * back with its reason, which the person starting the run sees as it is, and goes to the log.
 */
export function serverRuntime(
  ledger: Ledger,
  options: Pick<RuntimeForOptions, "env" | "now" | "open"> & {
    log?: (line: string) => void;
    /** The server's own selfhost.toml: the only source of runtime urls and key variables. */
    config?: Pick<RuntimeConfig, "runtime" | "integrations">;
  },
) {
  const now = options.now ?? (() => new Date());
  const seam = runtimeFor({
    ...options,
    emit: async (event) => {
      // Stored under the run's team, so the team's spend views and caps see it.
      await ledger.append([event], event.team ? { team: event.team } : {});
    },
    spentToday: (team, exclude, day) => ledgerSandboxSpend(ledger, team, exclude, day, now()),
    onRefused: (run, refusal) =>
      options.log?.(
        `background run ${run.id} for team ${run.team}: no runtime (${refusal.rule}). ${refusal.message}`,
      ),
  });
  return async (...[run, config]: Parameters<typeof seam>) => {
    const found = await seam(run, serverConnections(config, options.config, options.env));
    if (!isRefused(found) || found.refusal.rule !== "runtime.key") return found;
    // "Where selfhost runs" is the team server here, not the laptop that asked.
    let message = found.refusal.message.replace("where selfhost runs", "on the team server");
    // A missing url: say where a team server reads it, since a team's policy cannot set it.
    const kind = message.startsWith("Set url ")
      ? RUNTIME_KINDS.find((k) => message.includes(`runs ${k} sandboxes`))
      : undefined;
    if (kind) {
      const example = /such as (\S+?)\.?(?: |$)/.exec(message)?.[1];
      const rest = message.slice(message.indexOf(". ") + 2);
      const ignored =
        config.runtime?.providers?.[kind]?.url !== undefined
          ? ` Team ${run.team}'s policy sets one, which the team server ignores: only the server's own config or environment says where its keys go.`
          : "";
      message = `Set url in [runtime.providers.${kind}] of the server's own selfhost.toml (the file SELFHOST_CONFIG names in the server's environment), or ${runtimeUrlEnv(kind)} in the server's environment${example ? `, such as ${example}` : ""}.${ignored} ${rest}`;
    }
    return { refusal: { ...found.refusal, message } };
  };
}

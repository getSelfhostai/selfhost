import { serve } from "@hono/node-server";
import { openLedger, resolveDataDir } from "@selfhost/ledger";
import { type ResolvedSelfhostConfig, redactionSettings } from "@selfhost/schema";
import { createApp } from "./app.js";
import { findConsoleDir } from "./console.js";
import { serverConfig } from "./retention.js";
import { loadApiToken } from "./token.js";

export interface LocalServerOptions {
  version: string;
  /** Postgres url; default: the embedded ledger in dataDir. */
  url?: string;
  /** Embedded ledger folder, and where the API token is kept. Default: ~/.selfhost/data. */
  dataDir?: string;
  /** Default 127.0.0.1: only this machine reaches it. */
  host?: string;
  /** 0 picks a free port. */
  port: number;
  env?: NodeJS.ProcessEnv;
  /** The selfhost.toml where the console was started, shown read-only in solo mode. */
  policyPath?: string;
  /**
   * The laptop's selfhost.toml as the hooks resolve it, for what the server reads from the policy
   * ([integrations.tracer] for run views, [review] for the list). Default: SELFHOST_CONFIG, else
   * the built-in defaults.
   */
  config?: ResolvedSelfhostConfig;
}

export interface LocalServer {
  /** Where the console is, http://host:port/. */
  url: string;
  token: string;
  /** Where the token is kept, when it is in a file. */
  tokenPath?: string;
  consoleBuilt: boolean;
  close(): Promise<void>;
}

/**
 * The server on this machine's own ledger, for `selfhost console`: the API and the console at
 * /, with the same token the server keeps in the data dir. No background jobs run; it only
 * serves.
 */
export async function startLocalServer(options: LocalServerOptions): Promise<LocalServer> {
  const env = options.env ?? process.env;
  const dataDir = resolveDataDir(options.dataDir, env);
  const host = options.host ?? "127.0.0.1";
  const config = options.config ?? serverConfig(env);
  const ledger = await openLedger({
    url: options.url,
    dataDir,
    redaction: redactionSettings(config),
  });
  const { token, path } = loadApiToken(dataDir, env);
  const dir = findConsoleDir(env);
  const app = createApp({
    version: options.version,
    ledger,
    token,
    config,
    console: { dir },
    solo: options.policyPath ? { policyPath: options.policyPath } : {},
  });
  let server: ReturnType<typeof serve> | undefined;
  try {
    const port = await new Promise<number>((resolve, reject) => {
      server = serve({ fetch: app.fetch, port: options.port, hostname: host }, (info) =>
        resolve(info.port),
      );
      server.once("error", reject);
    });
    const shown = host.includes(":") ? `[${host}]` : host;
    return {
      url: `http://${shown}:${port}/`,
      token,
      ...(path ? { tokenPath: path } : {}),
      consoleBuilt: dir !== undefined,
      async close() {
        await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
        await ledger.close();
      },
    };
  } catch (error) {
    server?.close();
    await ledger.close();
    throw error;
  }
}

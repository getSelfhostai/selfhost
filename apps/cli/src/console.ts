import { spawn } from "node:child_process";
import type { Command } from "commander";

export interface ConsoleOptions {
  port?: string;
  host?: string;
  database?: string;
  dataDir?: string;
  open?: boolean;
  json?: boolean;
}

/** `selfhost console --json`: one line once the server listens. */
export interface ConsoleReport {
  schema: "selfhost.console/v1";
  /** The console, signed in: the token is in the fragment, which never leaves the browser. */
  url: string;
  token: string;
  /** Where the token is kept, or null when it came from SELFHOST_TOKEN or lives in memory. */
  token_file: string | null;
  console_built: boolean;
}

export interface ConsoleIo {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  write: (line: string) => void;
  version: string;
  /** Opens a URL in the browser. Default: open, xdg-open or start. */
  openBrowser?: (url: string, platform: NodeJS.Platform) => void;
  /** Resolves when the server should stop. Default: Ctrl-C or SIGTERM. */
  untilStopped?: () => Promise<void>;
}

export const DEFAULT_CONSOLE_PORT = 4400;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function parsePort(value: string): number {
  const port = Number(value.trim());
  if (!/^\d+$/.test(value.trim()) || port > 65_535) {
    throw new Error(`--port: expected a port from 0 to 65535, got "${value}"`);
  }
  return port;
}

function systemOpen(url: string, platform: NodeJS.Platform): void {
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  // No browser to open (a server over SSH) is not an error: the URL is printed.
  child.on("error", () => {});
  child.unref();
}

function untilSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
}

/**
 * Serves the console and the API on this machine's ledger (solo mode) until stopped, and opens
 * the console signed in. Only this machine can reach it unless --host says otherwise.
 */
export async function runConsole(options: ConsoleOptions, io: ConsoleIo): Promise<void> {
  const port = parsePort(options.port ?? String(DEFAULT_CONSOLE_PORT));
  const host = options.host?.trim() || "127.0.0.1";
  // The server and its dependencies load only for this command.
  const { startLocalServer } = await import("@selfhost/server/local");
  const server = await startLocalServer({
    version: io.version,
    url: options.database ?? io.env.DATABASE_URL,
    dataDir: options.dataDir,
    host,
    port,
    env: io.env,
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      throw new Error(
        `Port ${port} is in use, maybe by a selfhost server already running. Pass --port, or --port 0 for any free port.`,
      );
    }
    throw error;
  });
  const signedIn = `${server.url}#token=${encodeURIComponent(server.token)}`;
  try {
    if (options.json) {
      const report: ConsoleReport = {
        schema: "selfhost.console/v1",
        url: signedIn,
        token: server.token,
        token_file: server.tokenPath ?? null,
        console_built: server.consoleBuilt,
      };
      io.write(JSON.stringify(report));
    } else {
      io.write(`selfhost console at ${server.url}`);
      io.write(`Signed-in link: ${signedIn}`);
      io.write(
        `API token: ${server.token}${server.tokenPath ? ` (kept in ${server.tokenPath})` : ""}`,
      );
      if (!server.consoleBuilt) {
        io.write(
          "The web console is not built into this selfhost; the API still answers at /v1. Build it with pnpm --filter @selfhost/console build, or set SELFHOST_CONSOLE_DIR.",
        );
      }
      if (!LOOPBACK.has(host)) {
        io.write(
          `Note: listening on ${host}, so other machines can reach it. Anyone with the token reads the whole ledger.`,
        );
      }
      io.write("Press Ctrl-C to stop.");
    }
    if (options.open !== false) (io.openBrowser ?? systemOpen)(signedIn, io.platform);
    await (io.untilStopped ?? untilSignal)();
  } finally {
    await server.close();
  }
}

export function registerConsole(
  program: Command,
  io: () => ConsoleIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  program
    .command("console")
    .description(
      "open the web console on this machine's ledger: usage, cost, sessions and PRs by team, developer, agent and model",
    )
    .option("--port <port>", "port to listen on, 0 for any free one", String(DEFAULT_CONSOLE_PORT))
    .option("--host <address>", "address to listen on (default: 127.0.0.1, this machine only)")
    .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
    .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
    .option("--no-open", "print the link without opening a browser")
    .option("--json", "print one JSON line once it listens")
    .action(async (options: ConsoleOptions) => {
      try {
        await runConsole(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}

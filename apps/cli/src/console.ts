import { spawn } from "node:child_process";
import type { Command } from "commander";
import { findConfig } from "./find-config.js";
import { readMembership } from "./team/config.js";

export interface ConsoleOptions {
  port?: string;
  host?: string;
  database?: string;
  dataDir?: string;
  open?: boolean;
  json?: boolean;
  /** With --json, also print the token and the signed-in link that holds it. */
  showToken?: boolean;
  /** In a team, serve this machine's own ledger instead of opening the team's console. */
  local?: boolean;
}

/**
 * `selfhost console --json`: one line once the server listens. JSON output ends up in logs and
 * scripts, so it holds no token unless --show-token asks for it; the token file says where it is.
 */
export interface ConsoleReport {
  schema: "selfhost.console/v1";
  /** solo: a server on this machine's ledger; team: the team server's console. */
  mode: "solo" | "team";
  /** The console, not signed in. */
  url: string;
  /** --show-token only: the token, and the console signed in with it in the fragment. */
  token?: string;
  signed_in_url?: string;
  /** Where the token is kept, or null when it came from SELFHOST_TOKEN or lives in memory. */
  token_file: string | null;
  console_built: boolean;
}

const withToken = (options: ConsoleOptions, token: string, signedIn: string) =>
  options.showToken ? { token, signed_in_url: signedIn } : {};

export interface ConsoleIo {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  write: (line: string) => void;
  version: string;
  /** Opens a URL in the browser. Default: open, xdg-open or start. */
  openBrowser?: (url: string, platform: NodeJS.Platform) => void;
  /** Resolves when the server should stop. Default: Ctrl-C or SIGTERM. */
  untilStopped?: () => Promise<void>;
  /** ~/.selfhost/config.json: in a team, the console is the team server's. */
  configPath?: string;
  /** Where selfhost.toml is looked for, shown read-only in the solo console. */
  cwd?: string;
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
 * In a team, opens the team server's console signed in as this person. Otherwise (or with
 * --local) serves the console and the API on this machine's ledger until stopped, and opens it
 * signed in. Only this machine can reach the local one unless --host says otherwise.
 */
export async function runConsole(options: ConsoleOptions, io: ConsoleIo): Promise<void> {
  const membership = io.configPath && !options.local ? readMembership(io.configPath) : undefined;
  if (membership) {
    // The team server serves the console at /, and signs in from the same #token= fragment as
    // the local one: the person token from selfhost join, which never leaves the browser.
    const base = membership.server.endsWith("/") ? membership.server : `${membership.server}/`;
    const signedIn = `${base}#token=${encodeURIComponent(membership.token)}`;
    if (options.json) {
      const report: ConsoleReport = {
        schema: "selfhost.console/v1",
        mode: "team",
        url: base,
        ...withToken(options, membership.token, signedIn),
        token_file: io.configPath ?? null,
        console_built: true,
      };
      io.write(JSON.stringify(report));
    } else {
      io.write(`Team ${membership.team} console at ${base}, signed in as ${membership.person}.`);
      io.write(`Signed-in link: ${signedIn}`);
      io.write(
        "The link holds your person token: open it only in your own browser. selfhost console --local serves this machine's ledger instead.",
      );
    }
    if (options.open !== false) (io.openBrowser ?? systemOpen)(signedIn, io.platform);
    return;
  }
  const port = parsePort(options.port ?? String(DEFAULT_CONSOLE_PORT));
  const host = options.host?.trim() || "127.0.0.1";
  // The server and its dependencies load only for this command.
  const { startLocalServer } = await import("@selfhost/server/local");
  const policy = io.cwd ? findConfig(io.cwd, undefined, io.env)?.path : undefined;
  const server = await startLocalServer({
    ...(policy ? { policyPath: policy } : {}),
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
        mode: "solo",
        url: `${server.url.replace(/\/+$/, "")}/`,
        ...withToken(options, server.token, signedIn),
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
      "open the web console signed in: the team server's in a team, else one on this machine's ledger; usage, cost, sessions and PRs by team, developer, agent and model",
    )
    .option("--local", "in a team, serve this machine's own ledger instead")
    .option("--port <port>", "port to listen on, 0 for any free one", String(DEFAULT_CONSOLE_PORT))
    .option("--host <address>", "address to listen on (default: 127.0.0.1, this machine only)")
    .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
    .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
    .option("--no-open", "print the link without opening a browser")
    .option("--json", "print one JSON line once it listens, without the token")
    .option("--show-token", "with --json, also print the token and the signed-in link")
    .action(async (options: ConsoleOptions) => {
      try {
        await runConsole(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}

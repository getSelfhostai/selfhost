import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * `selfhost hook <agent>`: runs inside the agent on every hook event, so it does one thing. It
 * appends the payload to a spool file with a single write and exits 0, whatever happens.
 * `selfhost import` maps the spool into the ledger later. The ledger is never opened here:
 * the embedded database allows one process at a time, and agents run hooks concurrently.
 *
 * Keep this module free of workspace imports: main.ts loads it alone, for a quick start.
 */

/** The payload kinds the ledger mappers read, by the names agents are configured with. */
export const HOOK_AGENTS = {
  claude: "claude",
  "claude-code": "claude",
  claude_code: "claude",
  codex: "codex",
  "codex-notify": "codex-notify",
} as const;

export type HookAgent = (typeof HOOK_AGENTS)[keyof typeof HOOK_AGENTS];

/** One line of a spool file. */
export interface SpoolLine {
  agent: HookAgent;
  received_at: string;
  payload: unknown;
}

/** How long to wait for the payload on stdin before giving up. */
const STDIN_TIMEOUT_MS = 3000;

/**
 * `~/.selfhost/spool`, from HOME (USERPROFILE on Windows). Undefined when neither is set, so a
 * caller with an empty environment never touches a real home folder.
 */
export function spoolDir(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME || env.USERPROFILE;
  return home ? join(home, ".selfhost", "spool") : undefined;
}

/** One file per UTC day, so finished days can be removed once they are imported. */
export function spoolFile(dir: string, receivedAt: string): string {
  return join(dir, `hooks-${receivedAt.slice(0, 10)}.jsonl`);
}

export const SPOOL_FILE_PATTERN = /^hooks-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * Appends one payload to the spool. Tool output (tool_response) is replaced with null: the
 * ledger never reads it, and it can be large or hold file contents.
 */
export function appendToSpool(dir: string, agent: HookAgent, text: string, now = new Date()) {
  const payload: unknown = JSON.parse(text);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("expected a JSON object");
  }
  if ("tool_response" in payload) (payload as Record<string, unknown>).tool_response = null;
  const line: SpoolLine = { agent, received_at: now.toISOString(), payload };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(spoolFile(dir, line.received_at), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

export interface HookIo {
  env: NodeJS.ProcessEnv;
  /** The payload agents pipe in. */
  readStdin: () => Promise<string>;
  writeError: (line: string) => void;
  now?: Date;
}

/**
 * Receives one hook event. Claude Code and Codex hooks pipe the payload on stdin; Codex
 * notify passes it as the last argument. Always returns 0: a failure here must not stop or
 * slow the agent, so it is reported on stderr only and nothing is printed on stdout.
 */
export async function runHook(args: string[], io: HookIo): Promise<number> {
  try {
    const name = args[0] ?? "";
    const agent = HOOK_AGENTS[name as keyof typeof HOOK_AGENTS];
    if (!agent) {
      throw new Error(`expected claude, codex or codex-notify, got "${name}"`);
    }
    const dir = spoolDir(io.env);
    if (!dir) throw new Error("HOME is not set, so there is no ~/.selfhost/spool");
    const argument = agent === "codex-notify" && args.length > 1 ? args.at(-1) : undefined;
    const text = argument ?? (await io.readStdin());
    if (text.trim() === "") throw new Error("no payload");
    appendToSpool(dir, agent, text, io.now);
  } catch (error) {
    io.writeError(`selfhost hook: ${error instanceof Error ? error.message : String(error)}`);
  }
  return 0;
}

/** Reads stdin to the end; "" from a terminal, and an error when nothing ends in time. */
export function readStdin(timeoutMs = STDIN_TIMEOUT_MS): Promise<string> {
  const stdin = process.stdin;
  if (stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      stdin.destroy();
      reject(new Error(`stdin did not close within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    stdin.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    stdin.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Entry point for main.ts, which skips loading the rest of the command line. */
export function hookMain(args: string[]): Promise<number> {
  return runHook(args, {
    env: process.env,
    readStdin,
    writeError: (line) => process.stderr.write(`${line}\n`),
  });
}

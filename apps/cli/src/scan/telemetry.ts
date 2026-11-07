import { createInterface } from "node:readline/promises";
import { defaultConfigPath, readConfigFile, writeConfigFile } from "../config-file.js";

/** Where the opt-in agent count goes. Unset: nothing is ever sent. */
export const TELEMETRY_URL_ENV = "SELFHOST_TELEMETRY_URL";

export const AGENT_COUNT_QUESTION =
  "Send an anonymous count of the coding agents this scan found? Only the number is sent. [y/N] ";

/** The whole payload: how many different agents the scan found, nothing else. */
export interface AgentCountPing {
  schema: "selfhost.agent_count/v1";
  agents: number;
}

export type Ask = (question: string) => Promise<boolean>;
export type SendPing = (url: string, body: AgentCountPing) => Promise<void>;

export interface TelemetryIo {
  env: NodeJS.ProcessEnv;
  /** `~/.selfhost/config.json` unless set. */
  configPath?: string;
  /** Asks on the terminal; undefined when stdin is not a TTY, so nothing is asked. */
  ask?: Ask;
  send?: SendPing;
}

export type TelemetryOutcome = "sent" | "declined" | "not_asked" | "no_endpoint" | "failed";

/** y or yes, any case. Everything else, including an empty answer, is no. */
export async function askOnTerminal(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

export async function postJson(url: string, body: AgentCountPing): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

/**
 * Asks once whether to send the anonymous agent count, remembers the answer in the config file
 * and sends `{ agents }` only when the answer was yes and SELFHOST_TELEMETRY_URL is set. With no
 * terminal to ask on and no answer on file, it does nothing and remembers nothing.
 */
export async function agentCountPrompt(agents: number, io: TelemetryIo): Promise<TelemetryOutcome> {
  const path = io.configPath ?? defaultConfigPath();
  const config = readConfigFile(path);
  // A config file we cannot read back is left alone rather than overwritten.
  if (!config) return "not_asked";
  const telemetry = (config.telemetry ?? {}) as Record<string, unknown>;
  let answer = telemetry.agent_count;
  if (typeof answer !== "boolean") {
    if (!io.ask) return "not_asked";
    answer = await io.ask(AGENT_COUNT_QUESTION);
    writeConfigFile(path, { ...config, telemetry: { ...telemetry, agent_count: answer } });
  }
  if (!answer) return "declined";
  const url = io.env[TELEMETRY_URL_ENV]?.trim();
  if (!url) return "no_endpoint";
  try {
    await (io.send ?? postJson)(url, { schema: "selfhost.agent_count/v1", agents });
    return "sent";
  } catch {
    return "failed";
  }
}

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  GatewayBudget,
  GatewayKey,
  GatewayKeysResponse,
  GatewayStatus,
  IssueGatewayKeyResponse,
} from "@selfhost/schema";
import type { Command } from "commander";
import { table, usd } from "../format.js";
import { type Fetch, TeamClient } from "../team/client.js";
import { readMembership } from "../team/config.js";
import { type ConnectAgent, type ConnectKit, connectAgent, connectKit } from "./connect.js";

export interface GatewayIo {
  env: NodeJS.ProcessEnv;
  write: (line: string) => void;
  configPath: string;
  fetch: Fetch;
  /** Home folder, for --write. Default: HOME. */
  home?: string;
}

interface TeamOption {
  team?: string;
  json?: boolean;
}

export interface ConnectOptions {
  rotate?: boolean;
  run?: string;
  write?: boolean;
  json?: boolean;
}

/** `selfhost gateway connect --json`. The value is here once, for the person who asked. */
export interface ConnectReport {
  schema: "selfhost.gateway_connect/v1";
  agent: ConnectAgent;
  key: GatewayKey;
  value: string;
  base_url: string;
  settings: string;
  target: string;
  written: string | null;
  notes: string[];
}

function client(io: GatewayIo): TeamClient {
  const membership = readMembership(io.configPath);
  if (!membership) {
    throw new Error(
      "This laptop is not in a team: the gateway lives on the team server. Join one with selfhost join <server> <invite>.",
    );
  }
  return new TeamClient(membership.server, membership.token, io.fetch);
}

const PERIOD: Record<GatewayBudget["period"], string> = {
  day: "a day",
  week: "a week",
  month: "a month",
  run: "for the run",
};

export function budgetText(budgets: GatewayBudget[]): string {
  if (budgets.length === 0) return "none on the gateway";
  return budgets
    .map((b) => {
      const spent =
        b.spent_usd === null
          ? ""
          : `, ${usd(b.spent_usd)} spent, ${usd(Math.max(b.limit_usd - b.spent_usd, 0))} left`;
      return `${usd(b.limit_usd)} ${PERIOD[b.period]}${spent}`;
    })
    .join("; ");
}

export async function gatewayStatus(options: TeamOption, io: GatewayIo): Promise<GatewayStatus> {
  const status = await client(io).gateway(options.team);
  if (options.json) {
    io.write(JSON.stringify(status, null, 2));
    return status;
  }
  const { write } = io;
  table(
    [
      ["  Gateway", `${status.tool} at ${status.base_url ?? "an unknown address"}`],
      ["  Health", status.healthy ? "answering" : `not answering: ${status.detail ?? "no detail"}`],
      [
        "  Budgets",
        status.mode === "hard"
          ? `hard: the gateway refuses requests once a budget is spent`
          : "alert: spend is shown and alerted, nothing is stopped ([budget] mode = hard stops it)",
      ],
      [`  Team ${status.team}`, budgetText(status.team_budgets)],
      [
        "  Your key",
        status.key
          ? `${status.key.name}${status.key.active ? "" : " (turned off)"}: ${budgetText(status.key.budgets)}`
          : "none yet: selfhost gateway connect <agent>",
      ],
      [
        "  Last sync",
        status.last_sync
          ? `${status.last_sync.at}${status.last_sync.errors.length ? `, ${status.last_sync.errors.length} errors: ${status.last_sync.errors[0]}` : ""}`
          : "not yet",
      ],
      [
        "  Usage read",
        status.last_usage
          ? `${status.last_usage.at}, ${status.last_usage.events} new requests${status.last_usage.error ? `, failed: ${status.last_usage.error}` : ""}`
          : "not yet",
      ],
    ],
    write,
  );
  for (const note of status.notes) write(`Note: ${note}`);
  return status;
}

export async function gatewayKeys(
  options: TeamOption,
  io: GatewayIo,
): Promise<GatewayKeysResponse> {
  const keys = await client(io).gatewayKeys(options.team);
  if (options.json) {
    io.write(JSON.stringify(keys, null, 2));
    return keys;
  }
  if (keys.keys.length === 0) {
    io.write(`No gateway keys in team ${keys.team} yet.`);
    return keys;
  }
  table(
    [
      ["Key", "Owner", "State", "Limits"],
      ...keys.keys.map((key) => [
        key.name,
        key.person ?? (key.kind === "team" ? "the team" : (key.run_id ?? "")),
        key.active ? "on" : "off",
        budgetText(key.budgets),
      ]),
    ],
    io.write,
  );
  io.write("Values are never shown here: each was shown once, to whoever it was issued to.");
  return keys;
}

/** Merges env entries into Claude Code's user settings, keeping everything else, mode 0600. */
export function writeClaudeSettings(home: string, env: Record<string, string>): string {
  const path = join(home, ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${path} is not a JSON object, so it was left alone`);
    }
    settings = parsed as Record<string, unknown>;
  }
  const current =
    settings.env && typeof settings.env === "object"
      ? (settings.env as Record<string, unknown>)
      : {};
  const { ANTHROPIC_API_KEY: _replaced, ...rest } = current;
  settings.env = { ...rest, ...env };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export async function gatewayConnect(
  agentName: string,
  options: ConnectOptions,
  io: GatewayIo,
): Promise<ConnectReport> {
  const agent = connectAgent(agentName);
  if (options.write && agent !== "claude-code") {
    throw new Error("--write is for claude-code; for the others, paste the settings printed");
  }
  let issued: IssueGatewayKeyResponse;
  try {
    issued = await client(io).issueGatewayKey({
      ...(options.run ? { kind: "run" as const, run_id: options.run } : {}),
      ...(options.rotate ? { rotate: true } : {}),
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "key_exists") {
      throw new Error(
        "You have a gateway key already, and its value was shown once when it was issued. Run again with --rotate for a new value; the old one stops working.",
      );
    }
    throw error;
  }
  const kit: ConnectKit = connectKit(agent, issued.tool, issued.base_url, issued.value);
  const written =
    options.write && kit.claudeEnv
      ? writeClaudeSettings(io.home ?? io.env.HOME ?? homedir(), kit.claudeEnv)
      : null;
  const report: ConnectReport = {
    schema: "selfhost.gateway_connect/v1",
    agent,
    key: issued.key,
    value: issued.value,
    base_url: issued.base_url,
    settings: kit.text,
    target: kit.target,
    written,
    notes: kit.notes,
  };
  if (options.json) {
    io.write(JSON.stringify(report, null, 2));
    return report;
  }
  const { write } = io;
  write(`Gateway key ${issued.key.name}. Limits: ${budgetText(issued.key.budgets)}.`);
  write("Its value is shown this once; selfhost keeps no copy. It is not a provider key.");
  write("");
  if (written) {
    write(`Wrote ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN into ${written} (mode 0600).`);
  } else {
    write(`For ${kit.target}:`);
    write("");
    write(kit.text);
  }
  write("");
  for (const note of kit.notes) write(`Note: ${note}`);
  return report;
}

export function registerGateway(
  program: Command,
  io: () => GatewayIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  const gateway = program
    .command("gateway")
    .description(
      "the AI gateway on the team server: its health and budgets, the team's keys, and an agent's settings to send its model traffic through it",
    );
  gateway
    .command("status", { isDefault: true })
    .description("health, the team's hard limits and your own key, with what is left")
    .option("--team <id>", "another team you are in")
    .option("--json", "print the selfhost GatewayStatus object")
    .action(async (options: TeamOption) => {
      try {
        await gatewayStatus(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
  gateway
    .command("keys")
    .description("the team's gateway keys and their limits, never their values (owners and admins)")
    .option("--team <id>", "another team you are in")
    .option("--json", "print the keys as JSON")
    .action(async (options: TeamOption) => {
      try {
        await gatewayKeys(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
  gateway
    .command("connect")
    .description(
      "issue your gateway key and print the settings that send an agent's model traffic through it: claude-code, codex, opencode, or env for any SDK. Subscription logins cannot go through it",
    )
    .argument("<agent>", "claude-code, codex, opencode or env")
    .option("--rotate", "replace your key's value; the old one stops working")
    .option("--run <id>", "a key for one background run instead, which expires after 24 hours")
    .option("--write", "claude-code: write the settings into ~/.claude/settings.json")
    .option("--json", "print one selfhost.gateway_connect/v1 object, with the key's value")
    .action(async (agent: string, options: ConnectOptions) => {
      try {
        await gatewayConnect(agent, options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}

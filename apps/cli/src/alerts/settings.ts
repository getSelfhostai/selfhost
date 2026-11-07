import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Ledger } from "@selfhost/ledger";
import {
  formatConfigError,
  type LedgerEvent,
  parseConfig,
  type ResolvedSelfhostConfig,
  validateConfig,
} from "@selfhost/schema";
import {
  BUILT_IN_LIMITS,
  isPlan,
  knownTiers,
  type LimitSource,
  PLANS,
  type Plan,
} from "@selfhost/spend";
import { readConfigFile, writeConfigFile } from "../config-file.js";
import { findConfig } from "../find-config.js";
import { teamPolicyPath, writableConfig } from "../team/config.js";

/** What the alert commands read and write; tests pass fixtures instead of the real machine. */
export interface AlertIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  write: (line: string) => void;
  setExitCode: (code: number) => void;
  now?: Date;
  /** ~/.selfhost/config.json: the person's own plan tiers live here. */
  configPath: string;
}

export interface LedgerOptions {
  database?: string;
  dataDir?: string;
}

export type Tiers = Partial<Record<Plan, string>>;

/** [alerts] and [plans] from selfhost.toml, with defaults when there is none. */
export interface AlertSettings {
  alerts: ResolvedSelfhostConfig["alerts"];
  /** Limit tables, first match wins: [plans] in selfhost.toml, then the built-in table. */
  limits: LimitSource[];
  overflow?: { key: string; monthly_cap_usd: number };
  /** The file the settings came from, when there is one. */
  path?: string;
}

const DEFAULTS = (() => {
  const result = validateConfig({ version: 1 });
  if (!result.ok) throw new Error("the default selfhost.toml does not validate");
  return result.config;
})();

function fromConfig(config: ResolvedSelfhostConfig, path?: string): AlertSettings {
  const plans = config.plans;
  const limits: LimitSource[] = [];
  if (plans && (plans.claude || plans.codex)) {
    const asOf = plans.as_of ? ` as of ${plans.as_of}` : "";
    limits.push({
      label: `selfhost.toml [plans]${asOf}`,
      limits: { claude: plans.claude, codex: plans.codex },
    });
  }
  limits.push(BUILT_IN_LIMITS);
  return {
    alerts: config.alerts,
    limits,
    ...(plans?.overflow ? { overflow: plans.overflow } : {}),
    ...(path ? { path } : {}),
  };
}

/**
 * Settings from selfhost.toml, found like `selfhost doctor` finds it, else the team policy the
 * last sync pulled, else the defaults. `strict` makes an invalid file an error; otherwise (the
 * statusline) it falls back to the defaults.
 */
export function loadAlertSettings(
  io: Pick<AlertIo, "cwd" | "env" | "configPath">,
  flag: string | undefined,
  strict: boolean,
): AlertSettings {
  const found = findConfig(io.cwd, flag, io.env)?.path;
  const team = teamPolicyPath(io.configPath);
  const path = found ?? (existsSync(team) ? team : undefined);
  if (!path) return fromConfig(DEFAULTS);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (strict) throw new Error(`${path} could not be read: ${(error as Error).message}`);
    return fromConfig(DEFAULTS);
  }
  const result = parseConfig(text);
  if (result.ok) return fromConfig(result.config, path);
  if (!strict) return fromConfig(DEFAULTS);
  const lines = result.errors.map((error) => `  ${formatConfigError(error, path)}`);
  throw new Error([`${path} is invalid. Run selfhost doctor.`, ...lines].join("\n"));
}

const PLAN_ALIASES: Record<string, Plan> = {
  claude: "claude",
  "claude-code": "claude",
  claude_code: "claude",
  codex: "codex",
};

/** "claude=max_5x,codex=plus" or several such values: tier per plan; "none" clears one. */
export function parsePlanTiers(values: string | readonly string[] | undefined): Tiers {
  const tiers: Tiers = {};
  const parts = (typeof values === "string" ? [values] : (values ?? []))
    .flatMap((value) => value.split(","))
    .map((part) => part.trim())
    .filter((part) => part !== "");
  for (const part of parts) {
    const [name, tier] = part.split("=").map((side) => side.trim().toLowerCase());
    const plan = name === undefined ? undefined : PLAN_ALIASES[name];
    if (!plan || !tier || !/^[a-z0-9_]+$/.test(tier)) {
      throw new Error(
        `--plan: expected plan=tier with plan claude or codex, like claude=max_5x, got "${part}"`,
      );
    }
    tiers[plan] = tier;
  }
  return tiers;
}

/** Tiers must name a row of one of the tables, or be "none". */
export function checkTiers(tiers: Tiers, limits: readonly LimitSource[]): void {
  for (const plan of PLANS) {
    const tier = tiers[plan];
    if (tier === undefined || tier === "none") continue;
    const known = knownTiers(plan, limits);
    if (!known.includes(tier)) {
      throw new Error(
        `Unknown ${plan} tier "${tier}": expected one of ${known.join(", ")}, or none`,
      );
    }
  }
}

/** The tiers the person set with `selfhost spend plan`, from ~/.selfhost/config.json. */
export function readTiers(configPath: string): Tiers {
  const saved = readConfigFile(configPath)?.plans;
  if (typeof saved !== "object" || saved === null || Array.isArray(saved)) return {};
  const tiers: Tiers = {};
  for (const [plan, tier] of Object.entries(saved)) {
    if (isPlan(plan) && typeof tier === "string" && tier !== "") tiers[plan] = tier;
  }
  return tiers;
}

/** Saves tiers into ~/.selfhost/config.json, keeping its other settings; "none" removes one. */
export function saveTiers(configPath: string, update: Tiers): Tiers {
  const config = writableConfig(configPath);
  const tiers: Tiers = { ...readTiers(configPath) };
  for (const plan of PLANS) {
    const tier = update[plan];
    if (tier === "none") delete tiers[plan];
    else if (tier !== undefined) tiers[plan] = tier;
  }
  writeConfigFile(configPath, { ...config, plans: tiers });
  return tiers;
}

/** Saved tiers, with --plan on top; "none" leaves a plan without a tier. */
export function effectiveTiers(saved: Tiers, flag: Tiers): Tiers {
  const tiers: Tiers = { ...saved, ...flag };
  for (const plan of PLANS) if (tiers[plan] === "none") delete tiers[plan];
  return tiers;
}

/** Where the statusline cache lives: next to the config file. */
export function statuslineCachePath(io: Pick<AlertIo, "env" | "configPath">): string {
  return io.env.SELFHOST_STATUSLINE_CACHE ?? join(dirname(io.configPath), "statusline.json");
}

const PAGE = 1000;

/** Every event of a kind at or after `from`, oldest first. */
export async function readEvents(
  ledger: Ledger,
  kind: "cost.recorded" | "alert.raised",
  from: Date,
): Promise<LedgerEvent[]> {
  const events: LedgerEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await ledger.query({ kind, from: from.toISOString(), limit: PAGE, cursor });
    events.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor);
  return events.reverse();
}

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  checkToolCall,
  type PolicyHit,
  type ToolCall,
  type ToolCallChecker,
} from "@selfhost/policy/pretool";
import {
  formatConfigError,
  parseConfig,
  type ResolvedSelfhostConfig,
  validateConfig,
} from "@selfhost/schema";
import { findConfig } from "../find-config.js";
import { extraCheckers } from "./checkers.js";
import type { CheckPreTool, GuardHit, GuardRecord } from "./receive.js";
import {
  AGENT_LABELS,
  type Answer,
  answerText,
  canAsk,
  type HookAgent,
  type PreToolCall,
  preToolCall,
} from "./vendors.js";

/**
 * The pre-tool check `selfhost hook` runs for events that can stop a tool call. It finds
 * selfhost.toml from the call's folder (or the team policy pulled by the last sync), checks the
 * call against its rules, the built-in guardrails and the extra checkers, and answers in the
 * agent's format. It never opens the ledger: the decision goes on the spool line, and `selfhost
 * import` writes it as a policy.evaluated event.
 *
 * Failure policy, so a broken setup never bricks the agent:
 * - selfhost.toml that does not parse or validate: its rules are skipped and the built-in
 *   guardrails run with their defaults (enforce), so the baseline still holds. Reported on
 *   stderr and in the record.
 * - An extra checker that throws or runs past its budget: no hits from it (fail open), recorded.
 * - Anything else that throws: receive.ts answers allow (fail open), reports on stderr and
 *   records fail_open.
 */

export interface PreToolOptions {
  /** Extra checkers in place of the built-in ones (the package guard), for tests. */
  checkers?: readonly ToolCallChecker[];
  budgetMs?: number;
  /** ~/.selfhost/config.json, for the team policy fallback. Default: from HOME. */
  configPath?: string;
}

/** The repository root above `dir`: the nearest folder with a .git entry. */
export function gitRoot(dir: string): string | undefined {
  let current = resolve(dir);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

function realpath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

let defaults: ResolvedSelfhostConfig | undefined;

function defaultConfig(): ResolvedSelfhostConfig {
  if (!defaults) {
    const result = validateConfig({ version: 1 });
    if (!result.ok) throw new Error("the built-in default policy does not validate");
    defaults = result.config;
  }
  return defaults;
}

interface LoadedPolicy {
  config: ResolvedSelfhostConfig;
  source?: { path: string; hash: string };
  failure?: string;
}

/** selfhost.toml for a folder, or the defaults (built-in guardrails only). */
export function loadPolicy(
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
  configPath: string | undefined,
): LoadedPolicy {
  const location = cwd === undefined ? undefined : findConfig(cwd, undefined, env, configPath);
  if (!location) return { config: defaultConfig() };
  let bytes: Buffer;
  try {
    bytes = readFileSync(location.path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { config: defaultConfig(), failure: `${location.path} could not be read: ${message}` };
  }
  const source = { path: location.path, hash: createHash("sha256").update(bytes).digest("hex") };
  const result = parseConfig(bytes.toString("utf8"));
  if (result.ok) return { config: result.config, source };
  const first = result.errors[0];
  return {
    config: defaultConfig(),
    source,
    failure: `${location.path} is invalid, so only the built-in guardrails ran${
      first ? `: ${formatConfigError(first, location.path)}` : ""
    }`,
  };
}

/** `path` relative to `root` with / separators, or undefined outside it. */
function inside(root: string, path: string): string | undefined {
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

/** The call rules and guardrails see: paths inside the workspace become relative to its root. */
export function toToolCall(call: PreToolCall, root: string | undefined): ToolCall {
  const cwd = call.cwd === undefined ? undefined : resolve(call.cwd);
  let path = call.file;
  if (path !== undefined && root !== undefined) {
    const absolute = isAbsolute(path) ? path : resolve(cwd ?? root, path);
    path = inside(root, absolute) ?? absolute.split(sep).join("/");
  }
  return {
    agent: call.vendor,
    tool: call.tool,
    ...(call.command !== undefined ? { command: call.command } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(call.access !== undefined ? { access: call.access } : {}),
    ...(call.url !== undefined ? { url: call.url } : {}),
    ...(call.mcpServer !== undefined ? { mcpServer: call.mcpServer } : {}),
    ...(call.model !== undefined ? { model: call.model } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(root !== undefined ? { root } : {}),
  };
}

const record = (hit: PolicyHit): GuardHit => ({
  rule_id: hit.rule_id,
  mode: hit.mode,
  verdict: hit.verdict,
  message: hit.message,
  irreversible: hit.irreversible,
});

/** What the agent shows: the rule's message and id, and why an ask became a deny. */
function reasonFor(hit: PolicyHit, call: PreToolCall, answer: Answer): string {
  const base = `selfhost: ${hit.message} [${hit.rule_id}]`;
  if (hit.verdict === "ask" && answer === "deny") {
    return `${base} This needs a person's approval, and ${AGENT_LABELS[call.vendor]} cannot ask from this hook, so it is blocked. Ask the user to run it.`;
  }
  return base;
}

/**
 * Checks one pre-tool payload and returns the agent's answer and the record for the spool.
 * Throws only on a bug; receive.ts then fails open.
 */
export async function checkPreToolCall(
  agent: HookAgent,
  payload: Record<string, unknown>,
  io: { env: NodeJS.ProcessEnv; writeError: (line: string) => void },
  options: PreToolOptions = {},
): Promise<{ output: string; guard?: GuardRecord }> {
  const started = performance.now();
  const call = preToolCall(agent, payload);
  const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  if (!call) {
    io.writeError("selfhost hook: the payload names no tool call, so it was allowed unchecked");
    return {
      output: answerText(agent, event, "allow"),
      guard: {
        answer: "allow",
        hits: [],
        failures: ["the payload names no tool call"],
        fail_open: true,
        ms: 0,
      },
    };
  }
  const cwd = call.cwd ?? call.roots[0];
  const root = (cwd && gitRoot(cwd)) ?? call.roots[0] ?? cwd;
  const home = io.env.HOME || io.env.USERPROFILE;
  const configPath =
    options.configPath ?? (home ? join(home, ".selfhost", "config.json") : undefined);
  const policy = loadPolicy(cwd, io.env, configPath);
  const failures: string[] = [];
  if (policy.failure) {
    failures.push(policy.failure);
    io.writeError(`selfhost hook: ${policy.failure}`);
  }
  const decision = await checkToolCall(policy.config, toToolCall(call, root), {
    env: io.env,
    realpath,
    checkers: options.checkers ?? extraCheckers({ env: io.env, ...(home ? { home } : {}) }),
    budgetMs: options.budgetMs,
  });
  for (const failure of decision.failures) {
    const line = `${failure.checker} ${failure.timedOut ? "timed out" : "failed"}: ${failure.message}`;
    failures.push(line);
    io.writeError(`selfhost hook: ${line}; the call was not held up for it`);
  }

  const answer: Answer =
    decision.verdict === "allow"
      ? "allow"
      : decision.verdict === "ask" && canAsk(agent, call.event)
        ? "ask"
        : "deny";
  // A deferred call is decided by the agent's own hook for it, unless this one blocks it.
  if (call.deferred && decision.verdict !== "block") {
    return { output: answerText(agent, call.event, "allow") };
  }
  const reason = decision.hit ? reasonFor(decision.hit, call, answer) : undefined;
  const guard: GuardRecord = {
    answer,
    ...(decision.hit ? { hit: record(decision.hit) } : {}),
    hits: decision.hits.map(({ rule_id, mode, verdict }) => ({ rule_id, mode, verdict })),
    ...(policy.source ? { policy: policy.source } : {}),
    ...(failures.length > 0 ? { failures } : {}),
    ms: Math.round(performance.now() - started),
  };
  return {
    output: answerText(agent, call.event, answer, answer === "allow" ? undefined : reason),
    guard,
  };
}

/** The check receive.ts loads for pre-tool events. */
export const checkPreTool: CheckPreTool = (agent, payload, io) =>
  checkPreToolCall(agent, payload, io);

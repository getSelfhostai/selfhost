import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  checkToolCall,
  type PolicyHit,
  type ToolCall,
  type ToolCallChecker,
} from "@selfhost/policy/pretool";
import {
  executionLocation,
  formatConfigError,
  parseConfig,
  type ResolvedSelfhostConfig,
  SELFHOST_DECISION_RULE_ID,
  validateConfig,
} from "@selfhost/schema";
import { findConfig, type PolicySource, policyText } from "../find-config.js";
import { gitRepoAt } from "../git-repo.js";
import { extraCheckers } from "./checkers.js";
import {
  type AnyGrant,
  callFingerprint,
  claimGrant,
  claimServerGrant,
  type ExceptionRequest,
  exceptionKey,
  exceptionsDir,
  findGrant,
  findServerGrant,
  REQUEST_SCHEMA,
  requestId,
  setAsideLaptopGrants,
  setAsideNote,
  writeRequest,
} from "./exceptions.js";
import { explain, grantUsedText, ruleLink } from "./explain.js";
import type { CheckPreTool, GuardHit, GuardRecord } from "./receive.js";
import { exceptionTrust } from "./trust.js";
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
 *
 * A block teaches: the agent and the person get the rule id, why, the alternative and a link to
 * the rule (explain.ts), and a review item id that allows this exact call once when a person
 * approves it (exceptions.ts). The hook writes the request and later finds the grant in
 * ~/.selfhost/exceptions; the item itself is made from the spool line on import. A failure in
 * the exception files only drops the exception part: the block still holds. In team mode
 * (trust.ts) only a grant the team server signed counts, checked against the pinned keys.
 */

export interface PreToolOptions {
  /** Extra checkers in place of the built-in ones (the package guard), for tests. */
  checkers?: readonly ToolCallChecker[];
  budgetMs?: number;
  /** ~/.selfhost/config.json, for the team policy fallback. Default: from HOME. */
  configPath?: string;
  /** Default: process.platform. Picks where the root-owned exception trust file is. */
  platform?: string;
  /** Read system paths (the exception trust file) under this folder instead; for tests. */
  systemRoot?: string;
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
  /** The selfhost.toml text in use. */
  text?: string;
  /** The files the policy is made of, to find the line that defines a rule. */
  sources?: PolicySource[];
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
  let text: string;
  let sources: PolicySource[];
  try {
    // On a machine in a team, a repository's file adds to the team policy, never replaces it.
    ({ text, sources } = policyText(location));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { config: defaultConfig(), failure: `${location.path} could not be read: ${message}` };
  }
  const source = { path: location.path, hash: createHash("sha256").update(text).digest("hex") };
  const result = parseConfig(text);
  if (result.ok) return { config: result.config, source, text, sources };
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
  ...(hit.alternative ? { alternative: hit.alternative } : {}),
  irreversible: hit.irreversible,
  ...(hit.hosts ? { hosts: hit.hosts } : {}),
});

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What the exception files say about a blocked call. */
type ExceptionOutcome =
  | { grant: AnyGrant }
  | { request: ExceptionRequest }
  | { failure: string }
  | Record<string, never>;

/** Where the exception files are and which grants count on this laptop. */
interface ExceptionPlace {
  dir: string;
  configPath: string | undefined;
  platform: string;
  systemRoot: string | undefined;
  writeError: (line: string) => void;
}

/**
 * For a call about to be denied: an approved grant for it, claimed (only looked at for a call
 * Cursor's own hook decides next, which claims it), else a new request for a person to approve.
 * In team mode the grant must be one the team server signed with a pinned key, for this call's
 * session, repository and person; grants signed on this laptop are set aside with a note.
 */
function exceptionFor(
  place: ExceptionPlace | undefined,
  call: PreToolCall,
  toolCall: ToolCall,
  rules: string[],
  expiryMinutes: number,
  now: Date,
): ExceptionOutcome {
  if (place === undefined) return {};
  const { dir } = place;
  try {
    const key = exceptionKey(dir, true);
    if (!key) return {};
    const fingerprint = callFingerprint(key, {
      ...toolCall,
      agent: call.vendor,
      ...(call.sessionId !== undefined ? { session: call.sessionId } : {}),
    });
    const trust = exceptionTrust(place.configPath, place.platform, place.systemRoot);
    if (trust.mode === "team") {
      const setAside = setAsideLaptopGrants(dir);
      if (setAside > 0) place.writeError(`selfhost hook: ${setAsideNote(setAside)}`);
      const where = call.cwd ?? toolCall.root;
      const grant = findServerGrant(
        dir,
        trust.keys,
        {
          fingerprint,
          rules,
          ...(call.sessionId !== undefined ? { session: call.sessionId } : {}),
          repo: () => (where === undefined ? undefined : gitRepoAt(where)),
          ...(trust.person !== undefined ? { person: trust.person } : {}),
        },
        now,
      );
      if (grant && (call.deferred || claimServerGrant(dir, grant))) return { grant };
    } else {
      const grant = findGrant(dir, key, fingerprint, rules, now);
      if (grant && (call.deferred || claimGrant(dir, grant))) return { grant };
    }
    const request: ExceptionRequest = {
      schema: REQUEST_SCHEMA,
      id: requestId(now),
      fingerprint,
      rules,
      agent: call.vendor,
      requested_at: now.toISOString(),
      expiry_minutes: expiryMinutes,
    };
    writeRequest(dir, request);
    return { request };
  } catch (error) {
    return { failure: `no one-time exception for this call: ${errorText(error)}` };
  }
}

/**
 * Checks one pre-tool payload and returns the agent's answer and the record for the spool.
 * Throws only on a bug; receive.ts then fails open.
 */
export async function checkPreToolCall(
  agent: HookAgent,
  payload: Record<string, unknown>,
  io: { env: NodeJS.ProcessEnv; writeError: (line: string) => void; now?: Date },
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
        location: executionLocation(io.env),
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
  const toolCall = toToolCall(call, root);
  const decision = await checkToolCall(policy.config, toolCall, {
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
  const now = io.now ?? new Date();
  const rules = [
    ...new Set(decision.hits.filter((hit) => hit.mode === "enforce").map((hit) => hit.rule_id)),
  ];
  // A person's own decision commands are never allowed once: the person runs them.
  const exception =
    answer === "deny" && decision.hit && !rules.includes(SELFHOST_DECISION_RULE_ID)
      ? exceptionFor(
          home
            ? {
                dir: exceptionsDir(join(home, ".selfhost")),
                configPath,
                platform: options.platform ?? process.platform,
                systemRoot: options.systemRoot,
                writeError: io.writeError,
              }
            : undefined,
          call,
          toolCall,
          rules,
          policy.config.review.exception_expiry_minutes,
          now,
        )
      : {};
  if ("failure" in exception) {
    failures.push(exception.failure);
    io.writeError(`selfhost hook: ${exception.failure}`);
  }
  const hit = decision.hit;
  const guard = (fields: Pick<GuardRecord, "answer" | "exception">): GuardRecord => ({
    ...fields,
    ...(hit ? { hit: record(hit) } : {}),
    hits: decision.hits.map(({ rule_id, mode, verdict }) => ({ rule_id, mode, verdict })),
    ...(policy.source ? { policy: policy.source } : {}),
    ...(failures.length > 0 ? { failures } : {}),
    ms: Math.round(performance.now() - started),
    location: executionLocation(io.env),
  });

  if ("grant" in exception && hit) {
    const { grant } = exception;
    // Cursor's own hook for the call claims the grant and records the use.
    if (call.deferred) return { output: answerText(agent, call.event, "allow") };
    const user = grantUsedText(grant, hit.rule_id);
    return {
      output: answerText(agent, call.event, "allow", { agent: user, user }),
      guard: guard({
        answer: "allow",
        exception: {
          id: grant.id,
          rules: grant.rules,
          used: true,
          approved_by: grant.approved_by,
          decision_event_id: grant.decision_event_id,
        },
      }),
    };
  }

  const request = "request" in exception ? exception.request : undefined;
  const text =
    hit && answer !== "allow"
      ? explain({
          agent: AGENT_LABELS[call.vendor],
          hit,
          answer,
          link: ruleLink(hit.rule_id, policy.sources ?? []),
          ...(request ? { exceptionId: request.id } : {}),
        })
      : undefined;
  return {
    output: answerText(agent, call.event, answer, text),
    guard: guard({
      answer,
      ...(request
        ? {
            exception: { id: request.id, fingerprint: request.fingerprint, rules: request.rules },
          }
        : {}),
    }),
  };
}

/** The check receive.ts loads for pre-tool events. */
export const checkPreTool: CheckPreTool = (agent, payload, io) =>
  checkPreToolCall(agent, payload, io);

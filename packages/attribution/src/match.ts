import type { AgentRef, AgentVendor, SessionHint, Signal } from "./types.js";
import {
  AGENT_LOGINS,
  BOT_LOGINS,
  BRANCH_PREFIXES,
  CO_AUTHORS,
  FOOTERS,
  SESSION_LINKS,
} from "./vendors.js";

/** Strongest first. */
export const SIGNALS: readonly Signal[] = [
  "co_author_trailer",
  "session_id",
  "bot_account",
  "branch_prefix",
  "file_time_match",
];

/** One piece of evidence for one agent. */
export interface Match {
  signal: Signal;
  vendor: AgentVendor;
  model?: string;
  sessionId?: string;
}

export interface Attribution {
  agent: AgentRef;
  signal: Signal;
  sessionId?: string;
}

/** Sessions by id, for ids that show up in commit messages and pull request bodies. */
export type KnownSessions = ReadonlyMap<string, Pick<SessionHint, "vendor" | "model">>;

const CO_AUTHOR_LINE = /^[ \t]*co-authored-by:[ \t]*(.*?)[ \t]*<([^>\s]+)>[ \t]*$/gim;
const NOREPLY = /^(?:(\d+)\+)?([^@\s]+)@users\.noreply\.github\.com$/i;

/**
 * The agent behind an account: a GitHub login (with its type) or noreply email, or an agent's
 * own git address such as cursoragent@cursor.com.
 */
export function accountVendor(account: {
  login?: string;
  type?: string;
  email?: string;
}): AgentVendor | undefined {
  const login = account.login?.toLowerCase();
  if (login) {
    const bot = BOT_LOGINS[login];
    if (bot) return bot;
    const agent = AGENT_LOGINS[login];
    if (agent && account.type === "Bot") return agent.vendor;
  }
  if (!account.email) return undefined;
  const email = account.email;
  const rule = CO_AUTHORS.find((r) => r.email.test(email));
  if (rule) return rule.vendor;
  const noreply = NOREPLY.exec(email);
  if (noreply?.[2]) {
    const name = noreply[2].toLowerCase();
    const bot = BOT_LOGINS[name];
    if (bot) return bot;
    const agent = AGENT_LOGINS[name];
    if (agent?.ids.includes(Number(noreply[1]))) return agent.vendor;
  }
  return undefined;
}

/** A GitHub App or agent account rather than a person. */
export function isBotAccount(user: { login: string; type?: string }): boolean {
  return user.type === "Bot" || user.login.toLowerCase().endsWith("[bot]");
}

/**
 * One match per vendor, preferring one with a model, so a commit with both a co-author trailer
 * and a footer from the same agent counts once.
 */
function onePerVendor(matches: Match[]): Match[] {
  const byVendor = new Map<AgentVendor, Match>();
  for (const match of matches) {
    const current = byVendor.get(match.vendor);
    if (!current || (!current.model && match.model)) byVendor.set(match.vendor, match);
  }
  return [...byVendor.values()];
}

/** Co-author trailers and vendor attribution lines in a commit message or pull request body. */
export function trailerMatches(text: string): Match[] {
  const matches: Match[] = [];
  for (const line of text.matchAll(CO_AUTHOR_LINE)) {
    const email = line[2] ?? "";
    const vendor = accountVendor({ email });
    if (!vendor) continue;
    const model = CO_AUTHORS.find((r) => r.email.test(email))?.model?.(line[1] ?? "");
    matches.push({ signal: "co_author_trailer", vendor, ...(model ? { model } : {}) });
  }
  for (const rule of FOOTERS) {
    if (rule.pattern.test(text)) matches.push({ signal: "co_author_trailer", vendor: rule.vendor });
  }
  return onePerVendor(matches);
}

const ID_TOKEN = /[A-Za-z0-9][A-Za-z0-9_-]{7,}/g;

/** Vendor session links, and ids of known sessions, in a commit message or pull request body. */
export function sessionMatches(text: string, known: KnownSessions): Match[] {
  const matches: Match[] = [];
  const seen = new Set<string>();
  for (const rule of SESSION_LINKS) {
    for (const link of text.matchAll(rule.pattern)) {
      const sessionId = link[1];
      if (!sessionId || seen.has(sessionId)) continue;
      seen.add(sessionId);
      const hint = known.get(sessionId);
      const model = hint?.vendor === rule.vendor ? hint.model : undefined;
      matches.push({
        signal: "session_id",
        vendor: rule.vendor,
        sessionId,
        ...(model ? { model } : {}),
      });
    }
  }
  if (known.size === 0) return onePerVendor(matches);
  for (const token of text.matchAll(ID_TOKEN)) {
    const sessionId = token[0];
    const hint = known.get(sessionId);
    if (!hint || seen.has(sessionId)) continue;
    seen.add(sessionId);
    matches.push({
      signal: "session_id",
      vendor: hint.vendor,
      sessionId,
      ...(hint.model ? { model: hint.model } : {}),
    });
  }
  return onePerVendor(matches);
}

export function botMatch(account: {
  login?: string;
  type?: string;
  email?: string;
}): Match | undefined {
  const vendor = accountVendor(account);
  return vendor ? { signal: "bot_account", vendor } : undefined;
}

/** The agent a branch name belongs to; remote names such as `origin/` are stripped first. */
export function branchVendor(ref: string): AgentVendor | undefined {
  const name = ref.replace(/^refs\/(?:heads|remotes\/[^/]+)\//, "");
  return BRANCH_PREFIXES.find(([prefix]) => name.startsWith(prefix))?.[1];
}

export function branchMatch(ref: string): Match | undefined {
  const vendor = branchVendor(ref);
  return vendor ? { signal: "branch_prefix", vendor } : undefined;
}

/** The single most common value, or undefined when there is none or a tie. */
function majority<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: T | undefined;
  let bestCount = 0;
  let tie = false;
  for (const [value, n] of counts) {
    if (n > bestCount) {
      best = value;
      bestCount = n;
      tie = false;
    } else if (n === bestCount) {
      tie = true;
    }
  }
  return tie ? undefined : best;
}

/**
 * The agent the strongest signal points to. When that signal names more than one vendor, the one
 * it names most often wins; a tie leaves the record unattributed rather than picking one. The
 * model and session come from evidence for the winning vendor, strongest first.
 */
export function resolve(matches: Match[]): Attribution | undefined {
  for (const signal of SIGNALS) {
    const level = matches.filter((m) => m.signal === signal);
    if (level.length === 0) continue;
    const vendor = majority(level.map((m) => m.vendor));
    if (!vendor) return undefined;
    const same = matches
      .filter((m) => m.vendor === vendor)
      .sort((a, b) => SIGNALS.indexOf(a.signal) - SIGNALS.indexOf(b.signal));
    const topModels = level.filter((m) => m.vendor === vendor && m.model).map((m) => m.model);
    const model = topModels.length
      ? majority(topModels)
      : majority(same.filter((m) => m.model).map((m) => m.model));
    const sessionId = same.find((m) => m.sessionId)?.sessionId;
    return {
      agent: { vendor, ...(model ? { model } : {}) },
      signal,
      ...(sessionId ? { sessionId } : {}),
    };
  }
  return undefined;
}

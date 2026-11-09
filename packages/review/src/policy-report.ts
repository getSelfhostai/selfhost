import { basename } from "node:path";
import { stableEventId } from "@selfhost/ledger";
import {
  type LedgerEvent,
  REVIEW_ITEM_SCHEMA,
  type ReviewItem,
  type Rule,
  type RuleMode,
} from "@selfhost/schema";

export interface PolicyReportOptions {
  /** Start of the window, inclusive. */
  since: Date;
  /** End of the window, exclusive. The id depends only on since and until. */
  until: Date;
  /** When the item is created. */
  now: Date;
  /** The rules in selfhost.toml. Without them no hit is marked as a likely false positive. */
  rules?: readonly Rule[];
  /** Where the rules were read from, named in the brief. */
  policyPath?: string;
}

export type ObservedVerdict = "block" | "ask";

export interface ObservedExample {
  tool: string;
  /** tool.input_summary, else target.value, as stored: redacted values stay redacted. */
  input: string | null;
  hits: number;
  /** Why this call looks like a false positive, or null. */
  likely_false_positive: string | null;
}

export interface ObservedRule {
  rule_id: string;
  verdicts: ObservedVerdict[];
  hits: number;
  sessions: number;
  likely_false_positives: number;
  /** The most frequent distinct calls, most hits first. */
  examples: ObservedExample[];
  /** Distinct calls left out of examples. */
  more_examples: number;
  /** Mode in selfhost.toml now, or null when the rule is not there or no rules were given. */
  mode: RuleMode | null;
  /** Ids of the policy.evaluated events counted, oldest first. */
  event_ids: string[];
}

const MAX_EXAMPLES = 3;
const DAY_MS = 86_400_000;

/** Ids for the allowlists, which are not [[rules]] tables. */
const PSEUDO_RULES: Record<string, string> = {
  "mcp.allow": "MCP allowlist",
  "models.allow": "model allowlist",
};

/** Tools that only read: Claude Code, Codex and OpenCode names. */
const READ_ONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "NotebookRead",
  "read_file",
  "list_dir",
  "grep_files",
  "view_image",
  "read",
  "grep",
  "glob",
  "list",
]);

/** Commands whose arguments are text to print or search for, never something to run. */
const TEXT_COMMANDS = new Set(["echo", "printf", "grep", "egrep", "fgrep", "rg"]);

/** Commands that run a string argument (or piped text) as code. */
const CODE_RUNNERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "eval",
  "ssh",
  "watch",
  "python",
  "python3",
  "node",
  "perl",
  "ruby",
]);

const SEPARATORS = new Set([";", "&", "|", "\n", "<", ">", "(", ")"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const FALSE_POSITIVE = {
  readOnly: (tool: string) => `${tool} only reads, and the rule matches a path for any tool`,
  inertText:
    "the command matched only inside quotes, a comment or the arguments of echo, grep or rg",
};

/**
 * Marks the characters of a shell command that are never run: quoted strings, comments and
 * the arguments of echo, printf, grep and rg up to the next `|`, `;`, `&`, redirect or newline.
 * Returns undefined when the command could run text that looks inert, so no match in it is
 * called a false positive: command substitution, or any shell or interpreter in the command
 * (`bash -c "..."`, `echo ... | sh`).
 */
export function inertCharacters(command: string): boolean[] | undefined {
  if (/\$\(|`|[<>]\(/.test(command)) return undefined;
  const inert: boolean[] = new Array(command.length).fill(false);
  let quote: string | null = null;
  let comment = false;
  let word = "";
  let inWord = false;
  let commandSeen = false;
  let argsInert = false;
  let runsCode = false;

  const endWord = () => {
    if (!inWord) return;
    const name = basename(word);
    if (CODE_RUNNERS.has(name)) runsCode = true;
    if (!commandSeen && !ASSIGNMENT.test(word)) {
      commandSeen = true;
      argsInert = TEXT_COMMANDS.has(name);
    }
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    commandSeen = false;
    argsInert = false;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (comment) {
      if (ch === "\n") {
        comment = false;
        endSegment();
      } else {
        inert[i] = true;
      }
      continue;
    }
    if (quote) {
      inert[i] = true;
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        inert[i + 1] = true;
        word += command[i + 1];
        i += 1;
      } else if (ch === quote) {
        quote = null;
      } else {
        word += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inWord = true;
      quote = ch;
      inert[i] = true;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      inWord = true;
      word += command[i + 1];
      inert[i] = argsInert;
      inert[i + 1] = argsInert;
      i += 1;
      continue;
    }
    if (SEPARATORS.has(ch)) {
      endSegment();
      continue;
    }
    if (/\s/.test(ch)) {
      endWord();
      inert[i] = argsInert;
      continue;
    }
    if (ch === "#" && !inWord) {
      comment = true;
      inert[i] = true;
      continue;
    }
    inWord = true;
    word += ch;
    inert[i] = argsInert;
  }
  endWord();
  return runsCode ? undefined : inert;
}

/**
 * true when the pattern matches the command somewhere, and every match lies in inert text.
 * Tries every start position, so a real match is not hidden behind an earlier inert one.
 */
export function matchesOnlyInertText(pattern: string, command: string): boolean {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "y");
  } catch {
    return false;
  }
  const inert = inertCharacters(command);
  if (!inert) return false;
  let found = false;
  for (let start = 0; start <= command.length; start++) {
    regex.lastIndex = start;
    const match = regex.exec(command);
    if (!match) continue;
    const end = start + match[0].length;
    if (end === start) return false;
    for (let k = start; k < end; k++) if (!inert[k]) return false;
    found = true;
  }
  return found;
}

function commandText(event: LedgerEvent): string | undefined {
  if (event.target?.type === "command") return event.target.value;
  return event.tool?.input_summary;
}

/**
 * Why a would-block hit is likely a false positive, or null. Two checks, both needing the rule:
 *
 * (a) A path rule that names no tool matched a tool that only reads (Read, Grep, Glob, LS and
 *     the like). Path rules are mostly written to keep agents from changing files; reading the
 *     same file is usually fine. A rule that names a tool meant to catch that tool, so it is
 *     never marked.
 * (b) A command rule matched only text that the shell does not run: inside quotes, after `#`,
 *     or in the arguments of echo, grep or rg. `git commit -m "no rm -rf"` is a message, not a
 *     deletion. Commands that could run that text (`bash -c`, `| sh`, `$(...)`) are never marked.
 *
 * Not used: a session that ran the same command again later without trouble says nothing about
 * whether the rule was right.
 */
export function falsePositiveReason(event: LedgerEvent, rule: Rule | undefined): string | null {
  if (!rule) return null;
  const tool = event.tool?.name;
  if (rule.match.path !== undefined && rule.match.tool === undefined && tool) {
    if (READ_ONLY_TOOLS.has(tool)) return FALSE_POSITIVE.readOnly(tool);
  }
  const command = commandText(event);
  if (rule.match.command !== undefined && command !== undefined) {
    if (matchesOnlyInertText(rule.match.command, command)) return FALSE_POSITIVE.inertText;
  }
  return null;
}

/** One rule's verdict on one call, from a policy.evaluated event. */
export interface EvaluatedHit {
  rule_id: string;
  mode: "observe" | "enforce";
  verdict: "block" | "ask";
}

function asHit(value: unknown): EvaluatedHit | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { rule_id, mode, verdict } = value as Record<string, unknown>;
  if (typeof rule_id !== "string" || rule_id === "") return undefined;
  if (mode !== "observe" && mode !== "enforce") return undefined;
  if (verdict !== "block" && verdict !== "ask") return undefined;
  return { rule_id, mode, verdict };
}

/**
 * Every rule that stopped or would have stopped the call of a policy.evaluated event: the hook
 * lists them all in data.hits, where decision names only the one that decided. An observe rule
 * that fired next to an enforced guardrail is in data.hits only. Events without data.hits give
 * their decision.
 */
export function evaluatedHits(event: LedgerEvent): EvaluatedHit[] {
  if (event.kind !== "policy.evaluated") return [];
  const listed = event.data?.hits;
  if (Array.isArray(listed)) {
    const seen = new Set<string>();
    return listed.flatMap((value) => {
      const hit = asHit(value);
      if (!hit || seen.has(hit.rule_id)) return [];
      seen.add(hit.rule_id);
      return [hit];
    });
  }
  const decision = event.decision;
  const hit = asHit({
    rule_id: decision?.rule_id,
    mode: decision?.mode ?? "enforce",
    verdict: decision?.verdict,
  });
  return hit ? [hit] : [];
}

/** One counted hit: a rule's verdict on a call, with the event that recorded it. */
export interface CountedHit extends EvaluatedHit {
  event: LedgerEvent;
}

/**
 * The hits in `mode` across events, oldest first. The same tool call evaluated twice by one rule
 * (data.tool_event_id) counts once.
 */
export function countedHits(
  events: readonly LedgerEvent[],
  mode: EvaluatedHit["mode"],
): CountedHit[] {
  const seen = new Set<string>();
  const out: CountedHit[] = [];
  for (const event of [...events].sort(byTimeThenId)) {
    for (const hit of evaluatedHits(event)) {
      if (hit.mode !== mode) continue;
      const toolEventId = event.data?.tool_event_id;
      const key =
        typeof toolEventId === "string"
          ? `${hit.rule_id}\u0000${toolEventId}`
          : `${hit.rule_id}\u0000${event.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...hit, event });
    }
  }
  return out;
}

const byTimeThenId = (a: LedgerEvent, b: LedgerEvent) =>
  a.ts === b.ts ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : Date.parse(a.ts) - Date.parse(b.ts);

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Groups observe-mode would-block and would-ask hits by rule, most hits first, counting every
 * hit an event lists (evaluatedHits). The same tool call evaluated twice by one rule
 * (data.tool_event_id) counts once.
 */
export function observedRules(
  events: readonly LedgerEvent[],
  rules?: readonly Rule[],
): ObservedRule[] {
  const ruleById = new Map((rules ?? []).map((rule) => [rule.id, rule]));
  const groups = new Map<string, CountedHit[]>();
  for (const hit of countedHits(events, "observe")) {
    const group = groups.get(hit.rule_id);
    if (group) group.push(hit);
    else groups.set(hit.rule_id, [hit]);
  }

  const observed = [...groups].map(([ruleId, hits]): ObservedRule => {
    const rule = ruleById.get(ruleId);
    const calls = new Map<string, ObservedExample>();
    let falsePositives = 0;
    for (const { event } of hits) {
      const tool = event.tool?.name ?? "(unknown tool)";
      const input = event.tool?.input_summary || event.target?.value || null;
      const reason = falsePositiveReason(event, rule);
      if (reason) falsePositives += 1;
      const key = `${tool}\u0000${input ?? ""}\u0000${reason ?? ""}`;
      const call = calls.get(key);
      if (call) call.hits += 1;
      else calls.set(key, { tool, input, hits: 1, likely_false_positive: reason });
    }
    const examples = [...calls.values()].sort(
      (a, b) =>
        b.hits - a.hits || compareText(a.tool, b.tool) || compareText(a.input ?? "", b.input ?? ""),
    );
    const verdicts = new Set<ObservedVerdict>(hits.map((hit) => hit.verdict));
    const sessions = new Set(
      hits.flatMap(({ event }) => (event.session_id ? [event.session_id] : [])),
    );
    return {
      rule_id: ruleId,
      verdicts: (["block", "ask"] as const).filter((verdict) => verdicts.has(verdict)),
      hits: hits.length,
      sessions: sessions.size,
      likely_false_positives: falsePositives,
      examples: examples.slice(0, MAX_EXAMPLES),
      more_examples: Math.max(0, examples.length - MAX_EXAMPLES),
      mode: rule ? (rule.mode ?? "observe") : null,
      event_ids: hits.map(({ event }) => event.id),
    };
  });
  return observed.sort((a, b) => b.hits - a.hits || compareText(a.rule_id, b.rule_id));
}

const day = (date: Date) => date.toISOString().slice(0, 10);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A Markdown code span that survives backticks in the text. */
function code(text: string): string {
  const flat = text.replace(/\s+/g, " ");
  const longest = Math.max(0, ...[...flat.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

function ruleSection(rule: ObservedRule, haveRules: boolean): string[] {
  const label = PSEUDO_RULES[rule.rule_id];
  const action = rule.verdicts.join(" or ");
  const lines = [
    `### ${rule.rule_id}${label ? ` (${label})` : ""}`,
    "",
    `Would ${action}: ${plural(rule.hits, "hit")} in ${plural(rule.sessions, "session")}, ` +
      `${plural(rule.likely_false_positives, "likely false positive")}.`,
    "",
  ];
  for (const example of rule.examples) {
    const input = example.input === null ? "no input recorded" : code(example.input);
    const flag = example.likely_false_positive
      ? `. Likely false positive: ${example.likely_false_positive}.`
      : "";
    lines.push(`- ${example.tool}: ${input} (${plural(example.hits, "hit")})${flag}`);
  }
  if (rule.more_examples > 0) lines.push(`- and ${plural(rule.more_examples, "other call")}`);
  lines.push("");
  if (label) return lines;
  if (haveRules && rule.mode === null) lines.push("No longer in selfhost.toml.", "");
  else if (rule.mode !== null && rule.mode !== "observe") {
    lines.push(`Now in ${rule.mode} mode in selfhost.toml.`, "");
  } else lines.push(`Promote with \`selfhost policy promote ${rule.rule_id}\`.`, "");
  return lines;
}

/**
 * The weekly policy_report review item: per rule in observe mode, what it would have blocked
 * or sent for approval between since and until, with likely false positives marked. The id is
 * a pure function of the window, so building the report for the same window again gives the
 * same item.
 */
export function buildPolicyReport(
  events: readonly LedgerEvent[],
  options: PolicyReportOptions,
): ReviewItem {
  const { since, until, now } = options;
  const inWindow = events.filter((event) => {
    const ts = Date.parse(event.ts);
    return ts >= since.getTime() && ts < until.getTime();
  });
  const observed = observedRules(inWindow, options.rules);
  const hits = observed.reduce((sum, rule) => sum + rule.hits, 0);
  const falsePositives = observed.reduce((sum, rule) => sum + rule.likely_false_positives, 0);
  const eventIds = observed.flatMap((rule) => rule.event_ids).sort();
  const counted = new Set(eventIds);
  const hitEvents = inWindow.filter((event) => counted.has(event.id));
  const sessions = new Set(
    hitEvents.flatMap((event) => (event.session_id ? [event.session_id] : [])),
  );
  const repos = new Set(hitEvents.map((event) => event.repo ?? ""));
  const repo = repos.size === 1 ? [...repos][0] : undefined;

  const from = day(since);
  const to = day(new Date(Math.max(since.getTime(), until.getTime() - 1)));
  const range = `${from} to ${to}`;
  const haveRules = options.rules !== undefined;
  const policy = options.policyPath ?? "selfhost.toml";

  const brief = [
    "Rules in observe mode record what they would have done and never stop an agent.",
    "",
    hits === 0
      ? `No observed rule fired from ${range} (UTC).`
      : `From ${range} (UTC) they would have stopped ${plural(hits, "tool call")} in ` +
        `${plural(sessions.size, "session")}. Likely false positives: ${falsePositives}.`,
    "",
    haveRules
      ? `Likely false positives are checked against the rules in \`${policy}\`.`
      : "No selfhost.toml was read, so likely false positives are not marked.",
    "",
    ...observed.flatMap((rule) => ruleSection(rule, haveRules)),
  ];

  const reasons = ["Observe mode only: no agent was stopped"];
  if (hits > 0) reasons.push(`Likely false positives: ${falsePositives} of ${plural(hits, "hit")}`);
  const timestamp = now.toISOString();
  return {
    id: stableEventId(
      since.toISOString(),
      `selfhost.policy_report:${since.toISOString()}:${until.toISOString()}`,
    ),
    schema: REVIEW_ITEM_SCHEMA,
    kind: "policy_report",
    title:
      hits === 0
        ? `No observed rule fired (${range})`
        : `Observed rules would have stopped ${plural(hits, "tool call")} (${range})`,
    created_at: timestamp,
    updated_at: timestamp,
    state: "open",
    blocking: false,
    risk: { score: hits === 0 ? 0 : 10, reasons },
    ...(repo ? { repo } : {}),
    owners: [],
    brief: brief.join("\n").trimEnd(),
    source_event_ids: eventIds,
  };
}

/** The window as whole UTC days: from the day `since` falls on through the end of `now`'s day. */
export function reportWindow(since: Date, now: Date): { since: Date; until: Date } {
  const start = Math.floor(since.getTime() / DAY_MS) * DAY_MS;
  const end = (Math.floor(now.getTime() / DAY_MS) + 1) * DAY_MS;
  return { since: new Date(start), until: new Date(end) };
}

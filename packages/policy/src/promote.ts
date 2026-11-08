import {
  type ConfigResult,
  formatConfigError,
  parseConfig,
  type ResolvedSelfhostConfig,
  RULE_MODES,
  type RuleMode,
  TomlLineIndex,
} from "@selfhost/schema";

export interface PromoteOptions {
  /** Set the mode in [teams.<team>.rules.<id>] instead of the rule itself. */
  team?: string;
  /** Default: enforce. */
  to?: RuleMode;
}

export interface PromoteResult {
  /** The new file text. The same text when nothing changed. */
  text: string;
  changed: boolean;
  /** Mode before the change. For a team, its override, else the rule's own mode. */
  from: RuleMode;
  to: RuleMode;
  /** 1-based line of the mode setting in the new text, or null when nothing changed. */
  line: number | null;
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const KEY_PART = String.raw`(?:[A-Za-z0-9_-]+|"[^"\\]*"|'[^']*')`;
/** `mode = "observe"`, possibly behind a dotted key, with an optional trailing comment. */
const MODE_LINE = new RegExp(
  String.raw`^(\s*(?:${KEY_PART}\s*\.\s*)*(?:mode|"mode"|'mode')\s*=\s*)(["'])[A-Za-z]*\2(\s*(?:#.*)?)$`,
);
const ID_LINE = /^(\s*)(?:id|"id"|'id')\s*=\s*(["'])/;

const tomlKey = (key: string) => (BARE_KEY.test(key) ? key : JSON.stringify(key));

const editByHand = (what: string) =>
  new Error(
    `${what}. promote only edits [[rules]], [teams.<team>.rules.<id>] and [guardrails] tables; edit it by hand.`,
  );

function invalid(result: Extract<ConfigResult, { ok: false }>, intro: string): Error {
  const errors = result.errors.map((error) => `  ${formatConfigError(error)}`);
  return new Error([intro, ...errors].join("\n"));
}

/** The file split on \n; a CRLF file keeps its \r at the end of each line. */
class Lines {
  readonly rows: string[];
  readonly index: TomlLineIndex;

  constructor(text: string) {
    this.rows = text.split("\n");
    this.index = new TomlLineIndex(text);
  }

  at(line: number): string {
    return this.rows[line - 1] ?? "";
  }

  /** Sets the string value on a `mode = "..."` line, keeping the key, quotes and comment. */
  setMode(line: number, mode: RuleMode): boolean {
    const row = this.at(line);
    const cr = row.endsWith("\r") ? "\r" : "";
    const match = MODE_LINE.exec(cr ? row.slice(0, -1) : row);
    if (!match) return false;
    const [, head, quote, tail] = match;
    this.rows[line - 1] = `${head}${quote}${mode}${quote}${tail}${cr}`;
    return true;
  }

  /** Inserts `mode = "..."` after `line`, with that line's indentation and line ending. */
  insertModeAfter(line: number, mode: RuleMode, quote = '"'): number {
    const row = this.at(line);
    const cr = row.endsWith("\r") ? "\r" : "";
    const indent = /^[ \t]*/.exec(row)?.[0] ?? "";
    this.rows.splice(line, 0, `${indent}mode = ${quote}${mode}${quote}${cr}`);
    return line + 1;
  }

  text(): string {
    return this.rows.join("\n");
  }
}

function parseValid(text: string): ResolvedSelfhostConfig {
  const result = parseConfig(text);
  if (!result.ok) {
    throw invalid(result, "selfhost.toml is not valid. Fix it before promoting a rule:");
  }
  return result.config;
}

function setRuleMode(lines: Lines, index: number, ruleId: string, to: RuleMode): number {
  const header = lines.index.lineOf(["rules", index]);
  if (header === undefined || !lines.at(header).trim().startsWith("[[")) {
    throw editByHand(`Rule "${ruleId}" is written as an inline table`);
  }
  // lineOf falls back to the [[rules]] header when the rule has no mode key of its own.
  const modeLine = lines.index.lineOf(["rules", index, "mode"]);
  if (modeLine !== undefined && modeLine !== header) {
    if (!lines.setMode(modeLine, to)) {
      throw editByHand(`Could not read the mode of rule "${ruleId}" on line ${modeLine}`);
    }
    return modeLine;
  }
  const idLine = lines.index.lineOf(["rules", index, "id"]);
  if (idLine === undefined || idLine === header) {
    throw editByHand(`Could not find the id line of rule "${ruleId}"`);
  }
  const quote = ID_LINE.exec(lines.at(idLine))?.[2];
  return lines.insertModeAfter(idLine, to, quote);
}

function setTeamMode(
  text: string,
  config: ResolvedSelfhostConfig,
  team: string,
  ruleId: string,
  to: RuleMode,
): { text: string; line: number } {
  const lines = new Lines(text);
  const path = ["teams", team, "rules", ruleId];
  const override = config.teams[team]?.rules[ruleId];
  if (!override) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    let base = text;
    if (base !== "" && !base.endsWith("\n")) base += eol;
    const gap = base === "" || base.endsWith(`${eol}${eol}`) ? "" : eol;
    const before = `${base}${gap}`;
    const block = `[teams.${tomlKey(team)}.rules.${tomlKey(ruleId)}]${eol}mode = "${to}"${eol}`;
    return { text: before + block, line: before.split("\n").length + 1 };
  }
  const table = lines.index.lineOf(path);
  if (override.mode !== undefined) {
    const modeLine = lines.index.lineOf([...path, "mode"]);
    if (modeLine === undefined || !lines.setMode(modeLine, to)) {
      throw editByHand(`Could not read the mode of the ${team} override for "${ruleId}"`);
    }
    return { text: lines.text(), line: modeLine };
  }
  const header = table === undefined ? "" : lines.at(table).trim();
  if (table === undefined || !header.startsWith("[") || header.startsWith("[[")) {
    throw editByHand(`The ${team} override for "${ruleId}" is written as an inline table`);
  }
  const line = lines.insertModeAfter(table, to);
  return { text: lines.text(), line };
}

/**
 * Changes one rule's mode in selfhost.toml text, by default to enforce, and returns the new
 * text. Only the mode line changes (or one line is added), so comments, blank lines, quoting
 * and key order stay exactly as they were. With a team, the mode goes into
 * [teams.<team>.rules.<id>], and that table is added at the end of the file when missing.
 * Throws when the rule or team is unknown, the file is invalid, or the edit would not parse.
 */
export function promoteRule(
  text: string,
  ruleId: string,
  options: PromoteOptions = {},
): PromoteResult {
  const to = options.to ?? "enforce";
  if (!RULE_MODES.includes(to)) {
    throw new Error(`Expected a mode of enforce, observe or off, got "${to}"`);
  }
  const config = parseValid(text);
  const index = config.rules.findIndex((rule) => rule.id === ruleId);
  const rule = config.rules[index];
  if (!rule) {
    const known = config.rules.map((r) => r.id);
    const list = known.length > 0 ? ` Rules: ${known.join(", ")}.` : " It has no rules.";
    throw new Error(`No rule "${ruleId}" in selfhost.toml.${list}`);
  }
  const team = options.team;
  if (team !== undefined && !config.teams[team]) {
    const known = Object.keys(config.teams);
    const list = known.length > 0 ? ` Teams: ${known.join(", ")}.` : " It has no [teams].";
    throw new Error(`No team "${team}" in selfhost.toml.${list}`);
  }

  const from =
    team === undefined ? rule.mode : (config.teams[team]?.rules[ruleId]?.mode ?? rule.mode);
  if (from === to) return { text, changed: false, from, to, line: null };

  let next: { text: string; line: number };
  if (team === undefined) {
    const lines = new Lines(text);
    const line = setRuleMode(lines, index, ruleId, to);
    next = { text: lines.text(), line };
  } else {
    next = setTeamMode(text, config, team, ruleId, to);
  }

  const result = parseConfig(next.text);
  if (!result.ok) {
    throw invalid(result, "The change would leave selfhost.toml invalid, so nothing was written:");
  }
  const after = result.config.rules.find((r) => r.id === ruleId);
  const mode =
    team === undefined
      ? after?.mode
      : (result.config.teams[team]?.rules[ruleId]?.mode ?? after?.mode);
  if (mode !== to) {
    throw editByHand(`The edit did not set rule "${ruleId}" to ${to}`);
  }
  return { text: next.text, changed: true, from, to, line: next.line };
}

/**
 * Sets `[guardrails] mode` in selfhost.toml text, by default to enforce, and returns the new
 * text. Like promoteRule, only the mode line changes, or one line is added after the
 * [guardrails] header, or a [guardrails] table is added at the end of a file that has none.
 * Guardrails enforce when the file says nothing, so from is enforce then.
 * Throws when the file is invalid, guardrails are written as an inline table or dotted keys,
 * or the edit would not parse.
 */
export function setGuardrailsMode(text: string, to: RuleMode = "enforce"): PromoteResult {
  if (!RULE_MODES.includes(to)) {
    throw new Error(`Expected a mode of enforce, observe or off, got "${to}"`);
  }
  const config = parseValid(text);
  const from = config.guardrails.mode;
  if (from === to) return { text, changed: false, from, to, line: null };

  const lines = new Lines(text);
  const table = lines.index.lineOf(["guardrails"]);
  let next: { text: string; line: number };
  if (table === undefined) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    let base = text;
    if (base !== "" && !base.endsWith("\n")) base += eol;
    const gap = base === "" || base.endsWith(`${eol}${eol}`) ? "" : eol;
    const before = `${base}${gap}`;
    next = {
      text: `${before}[guardrails]${eol}mode = "${to}"${eol}`,
      line: before.split("\n").length + 1,
    };
  } else {
    const header = lines.at(table).trim();
    if (!header.startsWith("[") || header.startsWith("[[")) {
      throw editByHand("[guardrails] is written as an inline table or with dotted keys");
    }
    const modeLine = lines.index.lineOf(["guardrails", "mode"]);
    if (modeLine !== undefined && modeLine !== table) {
      if (!lines.setMode(modeLine, to)) {
        throw editByHand(`Could not read the [guardrails] mode on line ${modeLine}`);
      }
      next = { text: lines.text(), line: modeLine };
    } else {
      const line = lines.insertModeAfter(table, to);
      next = { text: lines.text(), line };
    }
  }

  const result = parseConfig(next.text);
  if (!result.ok) {
    throw invalid(result, "The change would leave selfhost.toml invalid, so nothing was written:");
  }
  if (result.config.guardrails.mode !== to) {
    throw editByHand(`The edit did not set [guardrails] mode to ${to}`);
  }
  return { text: next.text, changed: true, from, to, line: next.line };
}

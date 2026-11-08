import {
  CONFIG_SCHEMA_DIRECTIVE,
  formatConfigError,
  parseConfig,
  type Runtime,
} from "@selfhost/schema";
import { parse as parseToml } from "smol-toml";

/** What migrate does to one selfhost.toml. */
export interface ConfigPlan {
  path: string;
  /** The file before; null when it does not exist. */
  before: string | null;
  /** The file to write; null when nothing is written. */
  after: string | null;
  action: "created" | "updated" | "replaced" | "unchanged" | "kept" | "none";
  message: string | null;
}

export interface RuntimeNote {
  /** The Conductor file the section came from, relative to the repository. */
  from: string;
  /** YYYY-MM-DD. */
  date: string;
  /** [runtime.env] keys kept under a Conductor name, and the script files that read them. */
  aliases: { name: string; files: string[] }[];
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/** A control character other than tab, which TOML strings may only hold escaped. */
function hasControl(text: string, allowNewline: boolean): boolean {
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (ch === "\t" || (allowNewline && ch === "\n")) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function basicString(text: string): string {
  let out = '"';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

const readsBack = (rendered: string, text: string) => {
  try {
    return parseToml(`v = ${rendered}`).v === text;
  } catch {
    return false;
  }
};

/**
 * A TOML string that reads back as `text`: a multi-line literal string for scripts, a literal
 * string for commands with quotes or backslashes, else a basic string.
 */
export function tomlString(text: string, multiline = true): string {
  let candidate: string | undefined;
  if (text.includes("\n")) {
    if (multiline && !text.includes("'''") && !hasControl(text, true)) {
      candidate = `'''\n${text}'''`;
    }
  } else if (/["\\]/.test(text) && !text.includes("'") && !hasControl(text, false)) {
    candidate = `'${text}'`;
  }
  return candidate !== undefined && readsBack(candidate, text) ? candidate : basicString(text);
}

export const tomlKey = (key: string) => (BARE_KEY.test(key) ? key : basicString(key));

/**
 * The [runtime] section as TOML, with a comment saying where it came from. A file with CRLF
 * line endings gets scripts as one-line strings, so no line ending lands inside a value.
 */
export function runtimeToml(runtime: Runtime, note: RuntimeNote, crlf = false): string {
  const str = (text: string) => tomlString(text, !crlf);
  const lines = [
    "# How each agent workspace is set up, run and cleaned up, read by selfhost's runtime.",
    `# Moved from Conductor's ${note.from} by selfhost migrate conductor on ${note.date}.`,
    "[runtime]",
  ];
  if (runtime.setup !== undefined) lines.push(`setup = ${str(runtime.setup)}`);
  if (runtime.archive !== undefined) lines.push(`archive = ${str(runtime.archive)}`);
  if (runtime.run_mode !== undefined) lines.push(`run_mode = ${str(runtime.run_mode)}`);
  for (const [name, command] of Object.entries(runtime.run ?? {})) {
    lines.push("", `[runtime.run.${tomlKey(name)}]`, `command = ${str(command.command)}`);
    if (command.cwd !== undefined) lines.push(`cwd = ${str(command.cwd)}`);
    if (command.default !== undefined) lines.push(`default = ${command.default}`);
  }
  const env = Object.entries(runtime.env ?? {});
  if (env.length > 0) {
    lines.push("", "[runtime.env]");
    const aliases = new Map(note.aliases.map((alias) => [alias.name, alias.files]));
    const own = env.filter(([name]) => !aliases.has(name));
    const kept = env.filter(([name]) => aliases.has(name));
    for (const [name, value] of own) lines.push(`${tomlKey(name)} = ${str(value)}`);
    if (kept.length > 0) {
      const files = [...new Set(kept.flatMap(([name]) => aliases.get(name) ?? []))];
      lines.push(
        `# Conductor names still read by ${files.join(", ")}.`,
        "# Remove each one once no script reads it.",
      );
      for (const [name, value] of kept) lines.push(`${tomlKey(name)} = ${str(value)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const NEW_FILE_HEADER = `${CONFIG_SCHEMA_DIRECTIVE}
# selfhost.toml: team config for every coding agent working in this repository.
# Check it with \`selfhost policy check\`.
version = 1
`;

interface Scan {
  depth: number;
  openMultiline: '"""' | "'''" | null;
}

/** Brackets and braces left open, and a multi-line string left open, outside strings and comments. */
function scanLine(line: string): Scan {
  let depth = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i] as string;
    if (ch === "#") break;
    const triple = line.slice(i, i + 3);
    if (triple === '"""' || triple === "'''") {
      const close = line.indexOf(triple, i + 3);
      if (close === -1) return { depth, openMultiline: triple };
      i = close + 3;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += ch === '"' && line[j] === "\\" ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    if (ch === "]" || ch === "}") depth -= 1;
    i += 1;
  }
  return { depth, openMultiline: null };
}

/** The first key of a table header such as [runtime.run."e2e tests"], unquoted. */
function headerRoot(trimmed: string): string {
  const inner = trimmed.replace(/^\[\[?/, "").trimStart();
  const quote = inner[0];
  if (quote === '"' || quote === "'") {
    const end = inner.indexOf(quote, 1);
    const raw = inner.slice(0, end + 1);
    if (quote === "'") return raw.slice(1, -1);
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  return (/^[^.\]\s]*/.exec(inner)?.[0] ?? "").trim();
}

/** For each line, the first key of the table it opens, or null when it opens none. */
function tableHeaders(rows: string[]): (string | null)[] {
  const out: (string | null)[] = [];
  let multiline: Scan["openMultiline"] = null;
  let depth = 0;
  for (const row of rows) {
    if (multiline) {
      const close = row.indexOf(multiline);
      if (close !== -1) {
        multiline = null;
        const rest = scanLine(row.slice(close + 3));
        depth = Math.max(rest.depth, 0);
      }
      out.push(null);
      continue;
    }
    if (depth > 0) {
      depth += scanLine(row).depth;
      out.push(null);
      continue;
    }
    const trimmed = row.trim();
    if (trimmed.startsWith("[")) {
      out.push(headerRoot(trimmed));
      continue;
    }
    const scan = scanLine(row);
    if (scan.openMultiline) multiline = scan.openMultiline;
    else if (scan.depth > 0) depth = scan.depth;
    out.push(null);
  }
  return out;
}

const isComment = (row: string) => row.trim().startsWith("#");
const isBlank = (row: string) => row.trim() === "";

/**
 * Takes the [runtime] tables out of a selfhost.toml and puts `block` where the first one was.
 * Comment lines right above [runtime] go with it; comments that end the section stay, as they
 * usually belong to the table after it.
 */
function replaceRuntime(text: string, block: string[]): string | undefined {
  const rows = text.split("\n");
  const headers = tableHeaders(rows);
  const spans: [number, number][] = [];
  for (let i = 0; i < rows.length; i++) {
    if (headers[i] !== "runtime") continue;
    let end = i + 1;
    while (end < rows.length && headers[end] === null) end++;
    let keep = end;
    while (keep > i + 1 && (isBlank(rows[keep - 1] ?? "") || isComment(rows[keep - 1] ?? ""))) {
      keep--;
    }
    while (keep < end && isBlank(rows[keep] ?? "")) keep++;
    let start = i;
    if (spans.length === 0 || (spans[spans.length - 1]?.[1] ?? -1) < i) {
      while (start > 0 && isComment(rows[start - 1] ?? "")) start--;
    }
    spans.push([start, keep]);
    i = end - 1;
  }
  if (spans.length === 0) return undefined;
  const at = spans[0]?.[0] ?? 0;
  for (const [start, end] of [...spans].reverse()) rows.splice(start, end - start);
  const cr = text.includes("\r\n") ? "\r" : "";
  const before = rows.slice(0, at);
  const after = rows.slice(at);
  const lead = before.length > 0 && !isBlank(before[before.length - 1] ?? "") ? [cr] : [];
  const trail = after.length > 0 && !isBlank(after[0] ?? "") ? [cr] : [];
  return [...before, ...lead, ...block.map((line) => line + cr), ...trail, ...after].join("\n");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function invalid(path: string, text: string): Error | undefined {
  const result = parseConfig(text);
  if (result.ok) return undefined;
  const lines = result.errors.map((error) => `  ${formatConfigError(error, path)}`);
  return new Error(
    [`${path} is invalid. Fix it first (selfhost policy check shows the same):`, ...lines].join(
      "\n",
    ),
  );
}

/**
 * Plans the selfhost.toml change: a new file, the [runtime] section added at the end of an
 * existing one (every other byte kept), or, with force, an existing [runtime] replaced in place.
 * An existing [runtime] that differs is never touched without force.
 */
export function planConfig(
  path: string,
  before: string | null,
  runtime: Runtime | undefined,
  note: RuntimeNote,
  force: boolean,
): ConfigPlan {
  const plan = (action: ConfigPlan["action"], after: string | null, message: string | null) => ({
    path,
    before,
    after,
    action,
    message,
  });
  if (!runtime) return plan("none", null, "nothing to move into [runtime]");
  if (before !== null) {
    const error = invalid(path, before);
    if (error) throw error;
  }
  const eol = before?.includes("\r\n") ? "\r\n" : "\n";
  const block = runtimeToml(runtime, note, eol === "\r\n");
  let after: string;
  let action: ConfigPlan["action"];
  if (before === null) {
    after = `${NEW_FILE_HEADER}\n${block}`;
    action = "created";
  } else {
    const existing = (parseToml(before) as Record<string, unknown>).runtime;
    if (existing !== undefined && stable(existing) === stable(runtime)) {
      return plan("unchanged", null, "[runtime] already holds these settings");
    }
    if (existing !== undefined && !force) {
      return plan(
        "kept",
        null,
        "already has a different [runtime]; it was left as is. Pass --force to replace it",
      );
    }
    if (existing !== undefined) {
      const replaced = replaceRuntime(before, block.replace(/\n$/, "").split("\n"));
      if (replaced === undefined) {
        throw new Error(
          `${path} sets runtime with dotted keys or an inline table; replace it by hand`,
        );
      }
      after = replaced;
      action = "replaced";
    } else {
      let base = before;
      if (base !== "" && !base.endsWith("\n")) base += eol;
      const gap = base === "" || base.endsWith(`${eol}${eol}`) ? "" : eol;
      after = `${base}${gap}${block.replaceAll("\n", eol)}`;
      action = "updated";
    }
  }
  const error = invalid(path, after);
  const readBack = (parseToml(after) as Record<string, unknown>).runtime;
  if (error || stable(readBack) !== stable(runtime)) {
    throw new Error(
      `the [runtime] section for ${path} did not read back as planned, so nothing was written${error ? `:\n${error.message}` : ""}`,
    );
  }
  return plan(action, after, null);
}

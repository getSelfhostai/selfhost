import { type IntegrationKind, TomlLineIndex } from "@selfhost/schema";
import { parse as parseToml } from "smol-toml";

/** The table can only be changed by hand, such as one written inline. */
export class IntegrationEditError extends Error {
  override name = "IntegrationEditError";
}

type Table = Record<string, unknown>;

const isTable = (value: unknown): value is Table =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const tomlKey = (key: string) => (BARE_KEY.test(key) ? key : JSON.stringify(key));

/** A value in inline form. JSON string escapes are valid TOML basic-string escapes. */
function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (isTable(value)) {
    const pairs = Object.entries(value).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`);
    return pairs.length === 0 ? "{}" : `{ ${pairs.join(", ")} }`;
  }
  throw new IntegrationEditError(`Cannot write ${String(value)} in selfhost.toml`);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (isTable(a) && isTable(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => sameValue(a[key], b[key]));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  return a === b;
}

function parse(text: string): Table {
  try {
    const raw = parseToml(text);
    return isTable(raw) ? raw : {};
  } catch (error) {
    throw new IntegrationEditError(
      `selfhost.toml is not valid TOML, so it was left alone: ${(error as Error).message}`,
    );
  }
}

const integrationOf = (raw: Table, kind: IntegrationKind) =>
  isTable(raw.integrations) ? raw.integrations[kind] : undefined;

/** The value at a dotted path of parsed TOML, undefined when any part is missing. */
function valueAt(raw: Table, path: readonly string[]): unknown {
  let value: unknown = raw;
  for (const part of path) {
    if (!isTable(value)) return undefined;
    value = value[part];
  }
  return value;
}

const startsWith = (key: readonly string[], path: readonly string[]) =>
  path.every((part, i) => key[i] === part);

/**
 * Replaces the table at `path` (with its sub-tables), or with null removes it, keeping every
 * other line as it was, comments included. A table that was there stays in its place; a new one
 * goes at the end. Throws IntegrationEditError when the table is written in a way this cannot
 * replace line by line, such as inline or with dotted keys.
 */
function replaceTable(text: string, path: readonly string[], table: Table | null): string {
  const name = `[${path.map(tomlKey).join(".")}]`;
  const raw = parse(text);
  const index = new TomlLineIndex(text);
  const rows = text.split("\n");
  const cr = text.includes("\r\n") ? "\r" : "";
  const ours = index.headers.filter((header) => startsWith(header.key, path));
  if (valueAt(raw, path) !== undefined && ours.length === 0) {
    throw new IntegrationEditError(
      `${name} is written inline or with dotted keys, so it cannot be replaced safely. Write it as a ${name} table, or change selfhost.toml by hand.`,
    );
  }

  // Each of our tables runs to the next header. The comments right above that header, and the
  // blank lines above them, belong to what follows.
  const spans = ours.map((header) => {
    const next = index.headers.find((other) => other.line > header.line)?.line;
    let end = next === undefined ? rows.length : next - 1;
    const row = (at: number) => (rows[at - 1] ?? "").trim();
    if (next !== undefined) while (end > header.line && row(end).startsWith("#")) end -= 1;
    while (end > header.line && row(end) === "") end -= 1;
    return { start: header.line - 1, end };
  });
  const block =
    table === null
      ? []
      : [
          name,
          ...Object.entries(table)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => `${tomlKey(key)} = ${tomlValue(value)}`),
        ].map((row) => `${row}${cr}`);

  let next: string;
  const [first] = spans;
  if (first) {
    const out = [...rows];
    for (const span of [...spans].reverse()) out.splice(span.start, span.end - span.start);
    out.splice(first.start, 0, ...block);
    if (block.length === 0) {
      // A removed table takes one of the blank lines around it along, as adding it put one in.
      const blank = (at: number) => at >= out.length || (out[at] ?? "").trim() === "";
      let at = first.start;
      while (at > 0 && blank(at - 1) && blank(at)) out.splice(--at, 1);
    }
    next = out.join("\n");
  } else if (block.length === 0) {
    next = text;
  } else {
    next = appendRows(text, block, cr);
  }

  const after = valueAt(parse(next), path);
  if (!sameValue(after, table ?? undefined)) {
    throw new IntegrationEditError(
      `${name} is also set somewhere this cannot replace, such as with dotted keys. Change selfhost.toml by hand.`,
    );
  }
  return next;
}

function appendRows(text: string, block: string[], cr: string): string {
  const eol = `${cr}\n`;
  let base = text;
  if (base !== "" && !base.endsWith("\n")) base += eol;
  const gap = base === "" || base.endsWith(`${eol}${eol}`) ? "" : eol;
  return `${base}${gap}${block.join("\n")}\n`;
}

/**
 * Sets one key of the `[<table>]` table to a string, or with null removes it, keeping every other
 * line. The table is added at the end when the file has none.
 */
function setTableKey(text: string, table: string, key: string, value: string | null): string {
  const raw = parse(text);
  const index = new TomlLineIndex(text);
  const rows = text.split("\n");
  const cr = text.includes("\r\n") ? "\r" : "";
  const line = value === null ? "" : `${tomlKey(key)} = ${tomlValue(value)}${cr}`;
  const header = index.headers.find((h) => h.key.length === 1 && h.key[0] === table && !h.array);
  const isKey = new RegExp(`^\\s*${key}\\s*=`);
  let next = text;
  if (header) {
    const end = index.headers.find((other) => other.line > header.line)?.line ?? rows.length + 1;
    const out = [...rows];
    const at = out.findIndex((row, i) => i >= header.line && i < end - 1 && isKey.test(row));
    if (at !== -1) {
      if (value === null) out.splice(at, 1);
      else out[at] = line;
    } else if (value !== null) {
      out.splice(header.line, 0, line);
    }
    next = out.join("\n");
  } else if (value !== null) {
    next = appendRows(text, [`[${tomlKey(table)}]${cr}`, line], cr);
  } else if (valueAt(raw, [table, key]) === undefined) {
    return text;
  }
  let after: unknown;
  try {
    after = valueAt(parse(next), [table, key]);
  } catch {
    after = Symbol("unparsable");
  }
  if (after !== (value ?? undefined)) {
    throw new IntegrationEditError(
      `[${table}] ${key} is set in a way this cannot change, such as with dotted keys. Change selfhost.toml by hand.`,
    );
  }
  return next;
}

/**
 * Replaces the `[integrations.<kind>]` table of selfhost.toml text, or with null removes it, and
 * keeps every other line as it was, comments included. A table that was there stays in its place;
 * a new one goes at the end. The result is only checked to hold exactly the table given: whether
 * the file is a valid policy is the caller's check (parseConfig, checkLayer). Throws
 * IntegrationEditError when the table is written in a way this cannot replace line by line, such
 * as inline or with dotted keys.
 */
export function setIntegrationTable(
  text: string,
  kind: IntegrationKind,
  table: Table | null,
): string {
  return replaceTable(text, ["integrations", kind], table);
}

/**
 * Where a kind's choice is written: `[integrations.<kind>]`, except the runtime, which is
 * `[runtime] default` with its settings in `[runtime.providers.<tool>]`.
 */
export function integrationPlace(kind: IntegrationKind, tool?: string | null): string {
  if (kind !== "runtime") return `[integrations.${kind}]`;
  return tool ? `[runtime] default = "${tool}"` : "[runtime] default";
}

/**
 * Writes a kind's tool and settings into selfhost.toml text, or with null removes them. The
 * runtime goes into [runtime]: default = <tool>, and the settings in [runtime.providers.<tool>].
 * A deprecated [integrations.runtime] table is taken out on the way. The other kinds are
 * setIntegrationTable.
 */
export function setIntegration(text: string, kind: IntegrationKind, table: Table | null): string {
  if (kind !== "runtime") return setIntegrationTable(text, kind, table);
  const raw = parse(text);
  const alias = integrationOf(raw, "runtime");
  const previous =
    valueAt(raw, ["runtime", "default"]) ?? (isTable(alias) ? alias.tool : undefined);
  let next = alias === undefined ? text : setIntegrationTable(text, "runtime", null);
  if (table === null) {
    next = setTableKey(next, "runtime", "default", null);
    if (typeof previous === "string")
      next = replaceTable(next, ["runtime", "providers", previous], null);
    return next;
  }
  const { tool, ...settings } = table;
  if (typeof tool !== "string") throw new IntegrationEditError("Expected the runtime's tool");
  const own = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined));
  next = replaceTable(
    next,
    ["runtime", "providers", tool],
    Object.keys(own).length > 0 ? own : null,
  );
  return setTableKey(next, "runtime", "default", tool);
}

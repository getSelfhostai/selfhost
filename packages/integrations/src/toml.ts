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
  const raw = parse(text);
  const index = new TomlLineIndex(text);
  const rows = text.split("\n");
  const cr = text.includes("\r\n") ? "\r" : "";
  const inKind = (key: readonly string[]) => key[0] === "integrations" && key[1] === kind;
  const ours = index.headers.filter((header) => inKind(header.key));
  if (integrationOf(raw, kind) !== undefined && ours.length === 0) {
    throw new IntegrationEditError(
      `[integrations.${kind}] is written inline or with dotted keys, so it cannot be replaced safely. Write it as an [integrations.${kind}] table, or change selfhost.toml by hand.`,
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
          `[integrations.${tomlKey(kind)}]`,
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
    const eol = `${cr}\n`;
    let base = text;
    if (base !== "" && !base.endsWith("\n")) base += eol;
    const gap = base === "" || base.endsWith(`${eol}${eol}`) ? "" : eol;
    next = `${base}${gap}${block.join("\n")}\n`;
  }

  const after = integrationOf(parse(next), kind);
  if (!sameValue(after, table ?? undefined)) {
    throw new IntegrationEditError(
      `[integrations.${kind}] is also set somewhere this cannot replace, such as with dotted keys under [integrations]. Change selfhost.toml by hand.`,
    );
  }
  return next;
}

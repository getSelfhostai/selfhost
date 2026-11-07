import type { Segment } from "./validate.js";

const SEP = "\u001f";

function keyOf(segments: readonly Segment[]): string {
  return segments.map(String).join(SEP);
}

/** Splits a TOML key such as `a."b.c".d` into its parts. */
function splitKey(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (quote) {
      if (ch === "\\" && quote === '"') {
        current += raw.slice(i, i + 2);
        i += 1;
      } else if (ch === quote) {
        quote = null;
        current += ch;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ".") {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((part) => unquote(part.trim()));
}

function unquote(part: string): string {
  if (part.startsWith('"') && part.endsWith('"') && part.length >= 2) {
    try {
      return JSON.parse(part) as string;
    } catch {
      return part.slice(1, -1);
    }
  }
  if (part.startsWith("'") && part.endsWith("'") && part.length >= 2) return part.slice(1, -1);
  return part;
}

interface Scan {
  /** Index of the first `=` outside quotes, or -1. */
  equals: number;
  /** Net count of `[` and `{` minus `]` and `}` outside strings and comments. */
  depth: number;
  /** A multi-line string delimiter left open at the end of the line. */
  openMultiline: '"""' | "'''" | null;
}

function scanLine(line: string): Scan {
  let equals = -1;
  let depth = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i] as string;
    if (ch === "#") break;
    const triple = line.slice(i, i + 3);
    if (triple === '"""' || triple === "'''") {
      const close = line.indexOf(triple, i + 3);
      if (close === -1) return { equals, depth, openMultiline: triple };
      i = close + 3;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += ch === '"' && line[j] === "\\" ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (ch === "=" && equals === -1) equals = i;
    if (ch === "[" || ch === "{") depth += 1;
    if (ch === "]" || ch === "}") depth -= 1;
    i += 1;
  }
  return { equals, depth, openMultiline: null };
}

/**
 * Maps TOML paths (as segments, with array-of-tables indexes) to the 1-based line where
 * they are defined. Best effort: values inside multi-line arrays or inline tables resolve
 * to the line of their key.
 */
export class TomlLineIndex {
  private readonly lines = new Map<string, number>();

  constructor(text: string) {
    const rows = text.split(/\r?\n/);
    const arrayCounts = new Map<string, number>();
    const currentArrayIndex = new Map<string, number>();
    let table: Segment[] = [];
    let multiline: '"""' | "'''" | null = null;
    let depth = 0;

    const resolve = (plain: string[]): Segment[] => {
      const out: Segment[] = [];
      for (let i = 0; i < plain.length; i++) {
        out.push(plain[i] as string);
        const index = currentArrayIndex.get(plain.slice(0, i + 1).join(SEP));
        if (index !== undefined) out.push(index);
      }
      return out;
    };

    rows.forEach((row, i) => {
      const lineNo = i + 1;
      if (multiline) {
        if (row.includes(multiline)) multiline = null;
        return;
      }
      if (depth > 0) {
        depth += scanLine(row).depth;
        return;
      }
      const trimmed = row.trim();
      if (trimmed === "" || trimmed.startsWith("#")) return;

      if (trimmed.startsWith("[[")) {
        const plain = splitKey(trimmed.slice(2, trimmed.indexOf("]]")));
        const parent = resolve(plain.slice(0, -1));
        const countKey = keyOf([...parent, plain[plain.length - 1] as string]);
        const index = (arrayCounts.get(countKey) ?? -1) + 1;
        arrayCounts.set(countKey, index);
        const plainKey = plain.join(SEP);
        for (const key of [...currentArrayIndex.keys()]) {
          if (key.startsWith(`${plainKey}${SEP}`)) currentArrayIndex.delete(key);
        }
        currentArrayIndex.set(plainKey, index);
        table = [...parent, plain[plain.length - 1] as string, index];
        this.record(table, lineNo);
        this.record(table.slice(0, -1), lineNo);
        return;
      }
      if (trimmed.startsWith("[")) {
        table = resolve(splitKey(trimmed.slice(1, trimmed.indexOf("]"))));
        this.record(table, lineNo);
        return;
      }

      const scan = scanLine(row);
      if (scan.equals === -1) return;
      const keyPath = splitKey(row.slice(0, scan.equals));
      for (let k = 1; k <= keyPath.length; k++)
        this.record([...table, ...keyPath.slice(0, k)], lineNo);
      if (scan.openMultiline) multiline = scan.openMultiline;
      else if (scan.depth > 0) depth = scan.depth;
    });
  }

  private record(segments: readonly Segment[], line: number): void {
    const key = keyOf(segments);
    if (!this.lines.has(key)) this.lines.set(key, line);
  }

  /** Line of the closest defined ancestor of `segments`, or undefined. */
  lineOf(segments: readonly Segment[]): number | undefined {
    for (let k = segments.length; k > 0; k--) {
      const line = this.lines.get(keyOf(segments.slice(0, k)));
      if (line !== undefined) return line;
    }
    return undefined;
  }
}

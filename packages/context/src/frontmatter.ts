import type { Segment } from "@selfhost/schema";
import { isNode, LineCounter, parseDocument, stringify } from "yaml";

/** A parsed document (YAML front matter or JSON) that can say on which line a field sits. */
export interface Located {
  data: unknown;
  /** Syntax errors, with 1-based lines in the whole file. */
  errors: { line?: number; message: string }[];
  /** The 1-based line of a field, or of the nearest parent that exists. */
  lineOf(segments: readonly Segment[]): number | undefined;
}

/**
 * Parses YAML (or JSON, which is YAML) keeping node positions. `offset` is the number of file
 * lines before the text, so lines point into the whole file.
 */
export function parseLocated(text: string, offset = 0): Located {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, uniqueKeys: true, prettyErrors: false });
  const lineAt = (pos: number) => lineCounter.linePos(pos).line + offset;
  const errors = doc.errors.map((error) => ({
    line: lineAt(error.pos[0]),
    message: error.message.split("\n")[0] ?? error.message,
  }));
  return {
    data: errors.length > 0 ? undefined : doc.toJS(),
    errors,
    lineOf(segments) {
      for (let depth = segments.length; depth >= 0; depth--) {
        const node = depth === 0 ? doc.contents : doc.getIn(segments.slice(0, depth), true);
        if (isNode(node) && node.range) return lineAt(node.range[0]);
      }
      return undefined;
    },
  };
}

export interface FrontMatter {
  /** The YAML between the --- lines; undefined when the file has none. */
  yaml: string | undefined;
  /** File lines before the YAML (the opening ---). */
  offset: number;
  body: string;
}

/** Splits `---` front matter off a Markdown file. The body loses its leading blank lines. */
export function splitFrontMatter(text: string): FrontMatter | { error: string; line: number } {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n") && normalized !== "---") {
    return { yaml: undefined, offset: 0, body: trimBody(normalized) };
  }
  const lines = normalized.split("\n");
  const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
  if (end === -1) return { error: "The front matter has no closing --- line", line: 1 };
  return {
    yaml: lines.slice(1, end).join("\n"),
    offset: 1,
    body: trimBody(lines.slice(end + 1).join("\n")),
  };
}

function trimBody(body: string): string {
  const trimmed = body.replace(/^\n+/, "").replace(/\s+$/, "");
  return trimmed === "" ? "" : `${trimmed}\n`;
}

/** YAML for front matter: keys in the order given, long strings never folded. */
export function toYaml(data: Record<string, unknown>): string {
  return Object.keys(data).length === 0 ? "" : stringify(data, { lineWidth: 0 });
}

/**
 * A Markdown file with front matter. `comment` goes on the first line inside the front matter,
 * as a YAML comment, so the file still starts with `---` as agents expect.
 */
export function markdownWithFrontMatter(
  data: Record<string, unknown>,
  body: string,
  comment?: string,
): string {
  const head = `---\n${comment === undefined ? "" : `# ${comment}\n`}${toYaml(data)}---\n`;
  return body === "" ? head : `${head}\n${body}`;
}

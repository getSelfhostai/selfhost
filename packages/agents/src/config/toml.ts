import { parse as parseToml } from "smol-toml";
import { isPlainObject, type Plain } from "./docs.js";
import type { FilePlan } from "./tree.js";
import type { ManifestFile, PlanItem, TomlBlock, TomlTarget } from "./types.js";

export const BLOCK_START = "# >>> selfhost >>>";
export const BLOCK_END = "# <<< selfhost <<<";
const BLOCK_NOTE =
  "# Written by `selfhost agents configure`. Edits inside this block are replaced.";

const MAIN_BLOCK: TomlBlock = { start: BLOCK_START, end: BLOCK_END, note: BLOCK_NOTE };

/** The block markers for a profile: the main setup's, or ones named after the profile. */
export function tomlBlock(profile: string | undefined, writer?: string): TomlBlock {
  if (profile === undefined) return MAIN_BLOCK;
  return {
    start: `# >>> selfhost ${profile} >>>`,
    end: `# <<< selfhost ${profile} <<<`,
    note: `# Written by \`${writer ?? `selfhost ${profile}`}\`. Edits inside this block are replaced.`,
  };
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

export function tomlKey(key: string): string {
  return BARE_KEY.test(key) ? key : JSON.stringify(key);
}

/** A TOML value in inline form. JSON string escapes are valid TOML basic-string escapes. */
export function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (isPlainObject(value)) {
    const pairs = Object.entries(value).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`);
    return pairs.length === 0 ? "{}" : `{ ${pairs.join(", ")} }`;
  }
  throw new Error(`cannot write ${String(value)} as TOML`);
}

/** `[header]` followed by `key = value` lines. */
export function tomlTable(header: string, body: Plain): string {
  const lines = [header];
  for (const [key, value] of Object.entries(body))
    lines.push(`${tomlKey(key)} = ${tomlValue(value)}`);
  return lines.join("\n");
}

type Extracted = { ok: true; base: string; block: string | null } | { ok: false; error: string };

/** Splits a file into the user's part and selfhost's block (with the blank line before it). */
export function extractBlock(
  text: string,
  path: string,
  markers: TomlBlock = MAIN_BLOCK,
): Extracted {
  const lines = text.split("\n");
  const start = lines.indexOf(markers.start);
  if (start === -1) return { ok: true, base: text, block: null };
  const end = lines.indexOf(markers.end, start);
  if (end === -1) {
    return { ok: false, error: `${path} has a selfhost block with no end marker; fix it by hand` };
  }
  const from = start > 0 && lines[start - 1] === "" ? start - 1 : start;
  const block = lines.slice(start + 1, end).join("\n");
  const base = [...lines.slice(0, from), ...lines.slice(end + 1)].join("\n");
  return { ok: true, base, block };
}

export function insertBlock(base: string, body: string, markers: TomlBlock = MAIN_BLOCK): string {
  const block = `${markers.start}\n${markers.note}\n${body}\n${markers.end}\n`;
  if (base.trim() === "") return block;
  return `${base.endsWith("\n") ? base : `${base}\n`}\n${block}`;
}

function parse(text: string): { ok: true; doc: Plain } | { ok: false; error: string } {
  try {
    return { ok: true, doc: parseToml(text) as Plain };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error),
    };
  }
}

/** Items a parsed selfhost block holds, for reporting what a removal takes out. */
function blockItems(doc: Plain): string[] {
  const items: string[] = [];
  if (doc.otel !== undefined) items.push("otel");
  if (isPlainObject(doc.mcp_servers)) {
    for (const name of Object.keys(doc.mcp_servers)) items.push(`mcp:${name}`);
  }
  if (doc.hooks !== undefined) items.push("hooks");
  return items;
}

/**
 * Plans a TOML file. selfhost keeps everything it writes in one marked block at the end of
 * the file, so the rest of the file, comments included, is never rewritten.
 */
export function planToml(
  target: TomlTarget,
  before: string | null,
  previous: ManifestFile | undefined,
): FilePlan {
  const fail = (message: string): FilePlan => ({
    items: target.items.map(({ item }) => ({ item, status: "error", path: target.path, message })),
    after: before,
    manifest: previous,
  });
  const markers = target.block ?? MAIN_BLOCK;
  const extracted = extractBlock(before ?? "", target.path, markers);
  if (!extracted.ok) return fail(extracted.error);
  const base = parse(extracted.base);
  if (!base.ok) return fail(`${target.path} is not valid TOML: ${base.error}`);
  const oldBlockText = extracted.block ?? "";
  const oldParsed = parse(oldBlockText);
  const oldBlock = oldParsed.ok ? oldParsed.doc : {};

  const items: PlanItem[] = [];
  const snippets: string[] = [];
  for (const want of target.items) {
    const conflict = want.conflict(base.doc);
    if (conflict) {
      items.push({
        item: want.item,
        status: "conflict",
        path: target.path,
        message: `left as is: ${conflict}`,
      });
      continue;
    }
    const snippet = want.snippet(base.doc);
    if (snippet === "") {
      items.push({
        item: want.item,
        status: "unchanged",
        path: target.path,
        message: "already set",
      });
      continue;
    }
    snippets.push(snippet);
    const status = oldBlockText.includes(snippet)
      ? "unchanged"
      : want.presentIn(oldBlock)
        ? "update"
        : "create";
    items.push({ item: want.item, status, path: target.path, message: want.note ?? null });
  }
  const wanted = new Set(target.items.map(({ item }) => item));
  for (const item of blockItems(oldBlock)) {
    if (!wanted.has(item)) items.push({ item, status: "remove", path: target.path, message: null });
  }

  let after: string | null =
    snippets.length > 0
      ? insertBlock(extracted.base, snippets.join("\n\n"), markers)
      : extracted.base;
  if (snippets.length > 0) {
    const check = parse(after);
    if (!check.ok) {
      return fail(`adding selfhost's settings would break ${target.path}: ${check.error}`);
    }
  }
  const created = previous?.created ?? before === null;
  if (created && after.trim() === "") after = null;
  if (before === null && snippets.length === 0) after = null;
  const manifest: ManifestFile | undefined =
    snippets.length > 0 ? { format: "toml", created, owned: [] } : undefined;
  return { items, after, manifest };
}

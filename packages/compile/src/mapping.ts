import type { Mapping } from "./types.js";

/** What one native form covers: its entries, or why it can't be written. */
export interface Part<E> {
  entries: E[];
  native: string[];
  /** What the entries miss of the calls this part matches. Undefined when they cover all. */
  gap?: string;
}

export const unmapped = <E>(reason: string): Part<E> => ({ entries: [], native: [], gap: reason });

function unique(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}

/**
 * One check's mapping from its parts: compiled when every part is written with no gap,
 * not_expressible when none is written, partial otherwise.
 */
export function combine<E>(
  parts: Part<E>[],
  hook: boolean,
  notes: { covered?: string; extra?: string } = {},
): Mapping<E> {
  const written = parts.filter((part) => part.entries.length > 0);
  const entries = written.flatMap((part) => part.entries);
  const native = unique(written.flatMap((part) => part.native));
  const gaps = unique(parts.map((part) => part.gap));
  const status =
    written.length === 0
      ? "not_expressible"
      : gaps.length === 0 && written.length === parts.length
        ? "compiled"
        : "partial";
  const sentences =
    status === "compiled"
      ? notes.covered === undefined
        ? []
        : [notes.covered]
      : gaps.map((gap) => `${capitalize(gap)}.`);
  if (notes.extra) sentences.push(notes.extra);
  return { status, entries, native, hook, detail: sentences.join(" ") };
}

export function notApplicable<E>(detail: string): Mapping<E> {
  return { status: "not_applicable", entries: [], native: [], hook: false, detail };
}

export function notExpressible<E>(detail: string, hook: boolean): Mapping<E> {
  return { status: "not_expressible", entries: [], native: [], hook, detail };
}

/** Capitalizes a sentence that starts with a plain lower-case word, not with a name. */
export function capitalize(text: string): string {
  return /^[a-z]+\b/.test(text) ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** Text in backticks, safe when it holds a backtick itself. */
export function code(text: string): string {
  return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
}

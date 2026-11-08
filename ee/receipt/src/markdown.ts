/** An inline code span that holds any text, backticks included, on one line. */
export function code(text: string): string {
  const value = text.replace(/\r?\n/g, " ");
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

/** A fenced block that shows text as written: no Markdown, no HTML, no mentions. */
export function block(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/** Plain text on one line, with the characters that would start Markdown or HTML escaped. */
export function escapeText(text: string): string {
  return text
    .replace(/\r?\n/g, " ")
    .replace(/[\\`*[\]<>|~]/g, "\\$&")
    .replace(/(?<!\w)_|_(?!\w)/g, "\\_")
    .replace(/@(?=\w)/g, "@​");
}

/** A link whose text is shown as typed; only http(s) URLs become links. */
export function link(text: string, url: string | undefined): string {
  if (!url || !/^https?:\/\//i.test(url)) return escapeText(text);
  return `[${escapeText(text)}](${url.replace(/[()\s]/g, encodeURIComponent)})`;
}

export const plural = (n: number, word: string, many = `${word}s`) =>
  `${n} ${n === 1 ? word : many}`;

/** 850 ms, 3.1 s, 2 min 5 s. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

export const shortSha = (sha: string) => sha.slice(0, 7).toLowerCase();

/** Number formats shared by the text, HTML and SVG output. */

export const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

export function usd(value: number): string {
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function tokens(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(value);
}

/** "1 session", "2 sessions". */
export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

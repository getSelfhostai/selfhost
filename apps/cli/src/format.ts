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

/** Prints rows as aligned columns; the last `rightAligned` columns are aligned right. */
export function table(rows: string[][], write: (line: string) => void, rightAligned = 0): void {
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  for (const row of rows) {
    write(
      row
        .map((cell, column) =>
          column < row.length - rightAligned
            ? cell.padEnd(widths?.[column] ?? 0)
            : cell.padStart(widths?.[column] ?? 0),
        )
        .join("  ")
        .trimEnd(),
    );
  }
}

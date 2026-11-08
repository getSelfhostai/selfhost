import { readFileSync } from "node:fs";

/** The needles that appear in none of the files. Binaries are searched as bytes. */
export function missingStrings(files: readonly string[], needles: readonly string[]): string[] {
  const left = new Set(needles);
  for (const file of files) {
    if (left.size === 0) break;
    const bytes = readFileSync(file);
    for (const needle of [...left]) if (bytes.includes(needle)) left.delete(needle);
  }
  return needles.filter((needle) => left.has(needle));
}

/** The event list Claude Code's doctor prints when settings name a hook event it does not know. */
export function doctorValidEvents(output: string): string[] | undefined {
  const list = output.match(/Valid events: ([A-Za-z]+(?:, [A-Za-z]+)*)/)?.[1];
  return list?.split(", ");
}

/** The lines under "Invalid settings" in Claude Code's doctor output. */
export function doctorInvalidSettings(output: string): string[] {
  const lines = output.split("\n");
  const start = lines.findIndex((line) => line.trim() === "Invalid settings");
  if (start === -1) return [];
  const problems: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    if (line.startsWith("- ")) problems.push(line.slice(2));
  }
  return problems;
}

/** Field names of an `export interface Name { ... }` in a generated .d.ts file. */
export function interfaceFields(dts: string, name: string): string[] | undefined {
  const start = dts.indexOf(`export interface ${name} {`);
  if (start === -1) return undefined;
  const body = dts.slice(start, dts.indexOf("\n}", start));
  return [...body.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((m) => m[1] as string);
}

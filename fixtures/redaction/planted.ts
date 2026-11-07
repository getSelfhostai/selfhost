import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The fake secrets and PII planted in this folder. manifest.json keeps each value in parts and
 * the fixture files keep a {{kind}} placeholder, so the repository holds no key-shaped string;
 * tests join the parts here.
 */
export interface Planted {
  kind: string;
  value: string;
}

export function plantedValues(): Planted[] {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "manifest.json"), "utf8")) as {
    planted: { kind: string; parts: string[] }[];
  };
  return manifest.planted.map(({ kind, parts }) => ({ kind, value: parts.join("") }));
}

/** A file from this folder with every {{kind}} placeholder replaced by its planted value. */
export function readPlanted(file: string): string {
  let text = readFileSync(join(import.meta.dirname, file), "utf8");
  for (const { kind, value } of plantedValues()) text = text.replaceAll(`{{${kind}}}`, value);
  return text;
}

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PACKAGE_ROOT = join(import.meta.dirname, "..");
export const PRESETS_DIR = join(PACKAGE_ROOT, "..", "..", "presets");
export const GENERATED_PATH = "src/init/presets.generated.ts";

const TEST_SUFFIX = ".test.toml";

/** Preset files in presets/, sorted, without their test files. Names are what --preset takes. */
export function presetFiles(): string[] {
  const files = readdirSync(PRESETS_DIR)
    .filter((file) => file.endsWith(".toml") && !file.endsWith(TEST_SUFFIX))
    .sort();
  for (const file of files) {
    if (!/^[a-z][a-z0-9]*\.toml$/.test(file)) {
      throw new Error(`presets/${file}: name presets with lowercase letters and digits only`);
    }
  }
  return files;
}

/**
 * Builds src/init/presets.generated.ts from presets/*.toml. The files are the source; the
 * generated module embeds them so the bundle and compiled binaries need no files on disk.
 */
export function buildPresetsModule(): string {
  const files = presetFiles();
  const names = files.map((file) => file.replace(/\.toml$/, ""));
  // Template literals keep each preset readable, and biome leaves their text as it is.
  const literal = (text: string) =>
    `\`${text.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${")}\``;
  const entries = files.map(
    (file, i) => `  ${names[i]}: ${literal(readFileSync(join(PRESETS_DIR, file), "utf8"))},`,
  );
  return [
    "// Generated from presets/*.toml. Run `pnpm --filter @selfhost/cli embed-presets` after changing them. Do not edit by hand.",
    "",
    `export const PRESET_NAMES = [${names.map((name) => JSON.stringify(name)).join(", ")}] as const;`,
    "",
    "export type PresetName = (typeof PRESET_NAMES)[number];",
    "",
    "export const PRESETS: Readonly<Record<PresetName, string>> = {",
    ...entries,
    "};",
    "",
  ].join("\n");
}

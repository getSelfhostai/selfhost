import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// Helpers for golden-file tests: a folder of fixtures holds what a compile writes, and a test
// fails when the output drifts from it. Kept free of any test framework.

/** Every file under dir, as /-separated paths relative to it. */
export function listFiles(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? listFiles(path, base)
      : [relative(base, path).split("\\").join("/")];
  });
}

/** Replaces dir with exactly these files. */
export function writeFolder(dir: string, files: ReadonlyMap<string, string | Uint8Array>): void {
  rmSync(dir, { recursive: true, force: true });
  for (const [name, content] of files) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
}

/** Path segments git often ignores locally (.git/info/exclude), so fixtures keep them as .out. */
const HIDDEN_SEGMENTS = new Set(["CLAUDE.md", "CLAUDE.local.md", ".claude"]);

/** The path a generated file is kept under in a fixture folder: CLAUDE.md becomes CLAUDE.md.out. */
export function goldenPath(path: string): string {
  return path
    .split("/")
    .map((segment) => (HIDDEN_SEGMENTS.has(segment) ? `${segment}.out` : segment))
    .join("/");
}

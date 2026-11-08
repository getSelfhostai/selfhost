import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

export const FIXTURE_REPO = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "fixtures",
  "context",
  "repo",
);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export interface Temp {
  root: string;
  path(...parts: string[]): string;
  write(relative: string, content: string): string;
  link(relative: string, target: string): void;
}

/** A temporary folder, removed after each test; `fixture` starts it as a copy of the repo. */
export function temp(fixture = false): Temp {
  const root = mkdtempSync(join(tmpdir(), "selfhost-context-test-"));
  dirs.push(root);
  if (fixture) cpSync(FIXTURE_REPO, root, { recursive: true });
  const path = (...parts: string[]) => join(root, ...parts);
  return {
    root,
    path,
    write(relative, content) {
      mkdirSync(dirname(path(relative)), { recursive: true });
      writeFileSync(path(relative), content);
      return path(relative);
    },
    link(relative, target) {
      mkdirSync(dirname(path(relative)), { recursive: true });
      symlinkSync(target, path(relative));
    },
  };
}

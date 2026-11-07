import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

export interface Fixture {
  home: string;
  path(...parts: string[]): string;
  write(relative: string, content: string, mode?: number): string;
  link(relative: string, target: string): string;
}

const cleanups: string[] = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway home directory; removed after each test. */
export function fixtureHome(prefix = "home"): Fixture {
  const home = mkdtempSync(join(tmpdir(), `selfhost-agents-${prefix}-`));
  cleanups.push(home);
  const path = (...parts: string[]) => join(home, ...parts);
  return {
    home,
    path,
    write(relative, content, mode) {
      const file = path(relative);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
      if (mode !== undefined) chmodSync(file, mode);
      return file;
    },
    link(relative, target) {
      const file = path(relative);
      mkdirSync(dirname(file), { recursive: true });
      symlinkSync(target, file);
      return file;
    },
  };
}

export const EXECUTABLE = 0o755;

import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Most folders `gitBranchAt` walks up looking for .git. */
const BRANCH_DEPTH = 40;

/**
 * The branch checked out at `cwd`, read from .git/HEAD without running git, so a hook pays a few
 * file reads at most. Works in worktrees, where .git is a file naming the git dir. Undefined for
 * a detached HEAD, or a folder that is gone or not in git. No workspace imports: the hook loads it.
 */
export function gitBranchAt(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (let depth = 0; depth < BRANCH_DEPTH; depth++) {
    const dotGit = join(dir, ".git");
    try {
      const info = statSync(dotGit, { throwIfNoEntry: false });
      if (info) {
        let gitDir = dotGit;
        if (info.isFile()) {
          const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
          if (!pointer) return undefined;
          gitDir = resolve(dir, pointer);
        }
        const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
        const branch = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
        return branch && branch.length <= 255 ? branch : undefined;
      }
    } catch {
      return undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

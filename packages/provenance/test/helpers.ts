import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Keeps git hermetic: no global or system config, so signing or hooks on this machine stay out. */
export function isolateGit() {
  process.env.GIT_CONFIG_GLOBAL = devNull;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
}

export interface Person {
  name: string;
  email: string;
}

export const ALICE: Person = { name: "Alice Example", email: "alice@example.com" };
export const BOB: Person = { name: "Bob Example", email: "bob@example.com" };
export const CURSOR_AGENT: Person = { name: "Cursor Agent", email: "cursoragent@cursor.com" };
export const GITHUB: Person = { name: "GitHub", email: "noreply@github.com" };

export interface CommitInput {
  message: string;
  /** Author and commit time, ISO 8601. */
  at: string;
  author?: Person;
  /** Committer, default the author. GitHub commits squash and rebase merges as itself. */
  committer?: Person;
  /** Committer time when it differs from `at`, as for a rebase merge. */
  committedAt?: string;
  /** New content per path, or null to delete. */
  files?: Record<string, string | null>;
  rename?: [string, string];
}

/** `n` numbered lines, `prefix 1` to `prefix n`. */
export function lines(n: number, prefix = "line", from = 1): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix} ${from + i}`);
}

export const text = (rows: string[]) => `${rows.join("\n")}\n`;

/** A git repository in a temp dir, built commit by commit with fixed people and dates. */
export class FixtureRepo {
  readonly dir = mkdtempSync(join(tmpdir(), "selfhost-provenance-"));

  constructor() {
    isolateGit();
    this.git("init", "-q", "-b", "main");
  }

  git(...args: string[]): string {
    return execFileSync("git", ["-C", this.dir, ...args], { encoding: "utf8" }).trim();
  }

  private env(input: Pick<CommitInput, "at" | "author" | "committer" | "committedAt">) {
    const author = input.author ?? ALICE;
    const committer = input.committer ?? author;
    return {
      ...process.env,
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: input.at,
      GIT_COMMITTER_NAME: committer.name,
      GIT_COMMITTER_EMAIL: committer.email,
      GIT_COMMITTER_DATE: input.committedAt ?? input.at,
    };
  }

  private stage(input: CommitInput) {
    if (input.rename) this.git("mv", ...input.rename);
    for (const [path, content] of Object.entries(input.files ?? {})) {
      if (content === null) {
        this.git("rm", "-q", path);
        continue;
      }
      const full = join(this.dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      this.git("add", path);
    }
  }

  commit(input: CommitInput): string {
    this.stage(input);
    execFileSync("git", ["-C", this.dir, "commit", "-q", "--allow-empty", "-F", "-"], {
      input: input.message,
      env: this.env(input),
    });
    return this.git("rev-parse", "HEAD");
  }

  checkout(...args: string[]) {
    this.git("checkout", "-q", ...args);
  }

  /** A merge commit of `branch` into the current branch, as GitHub's merge button makes it. */
  merge(branch: string, input: Omit<CommitInput, "files" | "rename">): string {
    execFileSync(
      "git",
      ["-C", this.dir, "merge", "-q", "--no-ff", "--no-edit", "-m", input.message, branch],
      { env: this.env(input) },
    );
    return this.git("rev-parse", "HEAD");
  }

  /** `git revert` of `sha` with its standard message. */
  revert(sha: string, input: Omit<CommitInput, "message" | "files" | "rename">): string {
    execFileSync("git", ["-C", this.dir, "revert", "--no-edit", sha], {
      env: this.env(input),
      stdio: "ignore",
    });
    return this.git("rev-parse", "HEAD");
  }

  write(path: string, content: string) {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  remove() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** ISO time `days` (and `hours`) after 2026-10-01T09:00:00Z. */
export function day(days: number, hours = 0): string {
  return new Date(Date.parse("2026-10-01T09:00:00Z") + (days * 24 + hours) * 3_600_000)
    .toISOString()
    .replace(".000Z", "Z");
}

export const SINCE = new Date("2026-10-01T00:00:00Z");
export const UNTIL = new Date("2026-11-08T00:00:00Z");

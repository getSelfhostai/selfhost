import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommitRecord } from "../src/index.js";

export const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
export const GITHUB_FIXTURES = join(FIXTURES, "github");
export const REPO = "acme/acme-api";
export const SINCE = new Date("2026-10-01T00:00:00Z");

/** Keeps git hermetic: no global or system config, so signing or hooks on this machine do not leak in. */
export function isolateGit() {
  process.env.GIT_CONFIG_GLOBAL = devNull;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
}

export interface CommitInput {
  message: string;
  at: string;
  author?: { name: string; email: string };
  /** Path to new content, or null to delete. */
  files: Record<string, string | Buffer | null>;
  rename?: [string, string];
}

/** A git repository in a temp dir, built commit by commit with fixed authors and dates. */
export class TempRepo {
  readonly dir = mkdtempSync(join(tmpdir(), "selfhost-attribution-"));

  constructor() {
    isolateGit();
    this.git("init", "-q", "-b", "main");
  }

  git(...args: string[]): string {
    return execFileSync("git", ["-C", this.dir, ...args], { encoding: "utf8" }).trim();
  }

  commit(input: CommitInput): string {
    if (input.rename) this.git("mv", ...input.rename);
    for (const [path, content] of Object.entries(input.files)) {
      const full = join(this.dir, path);
      if (content === null) {
        this.git("rm", "-q", path);
        continue;
      }
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      this.git("add", path);
    }
    const author = input.author ?? { name: "Alice Example", email: "alice@example.com" };
    execFileSync("git", ["-C", this.dir, "commit", "-q", "--allow-empty", "-F", "-"], {
      input: input.message,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_AUTHOR_DATE: input.at,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
        GIT_COMMITTER_DATE: input.at,
      },
    });
    return this.git("rev-parse", "HEAD");
  }

  remove() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export function lines(n: number, prefix = "line"): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join("");
}

/**
 * Plays recorded `gh api` responses from fixtures/github: the endpoint path, without its query,
 * names the file. Records every call; fails on anything not recorded.
 */
export function recordedGh(dir = GITHUB_FIXTURES) {
  const calls: string[] = [];
  const run = async (args: string[]): Promise<string> => {
    const endpoint = args[args.length - 1] ?? "";
    calls.push(endpoint);
    if (args[0] !== "api") throw new Error(`unexpected gh ${args.join(" ")}`);
    const [path, query = ""] = endpoint.split("?");
    const page = new URLSearchParams(query).get("page");
    if (page !== null && page !== "1") throw new Error(`no recorded page ${page} for ${path}`);
    try {
      return readFileSync(join(dir, `${path}.json`), "utf8");
    } catch {
      throw new Error(`no recorded response for ${endpoint}`);
    }
  };
  return { run, calls };
}

const SHA_105 = "fe177453d010cd2495459e4c037ee286a2cad19b";
const SHA_108 = "19c07f7bdedce372d371a4a63d535014041b1222";

/** What readCommits found locally for two of the pull requests' commits. */
export const LOCAL_COMMITS: CommitRecord[] = [
  {
    sha: SHA_105,
    authoredAt: "2026-10-08T08:30:00.000Z",
    authorEmail: "alice@example.com",
    subject: "Add billing export",
    files: ["src/billing.ts"],
    additions: 700,
    deletions: 120,
    agent: { vendor: "claude_code", model: "claude-opus-4-5" },
    signal: "session_id",
    sessionId: "7b0c2c1e-4f5a-4c8e-9d2b-3a1f0e6d5c4b",
  },
  {
    sha: SHA_108,
    authoredAt: "2026-10-14T08:40:00.000Z",
    authorEmail: "carol@example.com",
    subject: "Warm cache on boot",
    files: ["src/cache.ts"],
    additions: 35,
    deletions: 0,
    agent: { vendor: "goose", model: "gpt-5.5" },
    signal: "file_time_match",
    sessionId: "goose-1",
  },
  {
    sha: "0123456789abcdef0123456789abcdef01234567",
    authoredAt: "2026-10-16T08:00:00.000Z",
    authorEmail: "bob@example.com",
    subject: "Pushed straight to main",
    files: ["README.md"],
    additions: 1,
    deletions: 1,
  },
];

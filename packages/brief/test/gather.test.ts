import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Ledger, MEMORY_DATA_DIR, openLedger, stableEventId } from "@selfhost/ledger";
import { type PullRequestApi, readPullRequest } from "@selfhost/pr";
import { EVENT_SCHEMA, type LedgerEvent } from "@selfhost/schema";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { briefInputs, buildBrief, gatherBrief, renderBrief } from "../src/index.js";
import { BRIEF_FIXTURES } from "./helpers.js";

const dirs: string[] = [];
let ledger: Ledger;

beforeAll(async () => {
  // As a team that opted in to storing prompts, so the task can show the first one.
  ledger = await openLedger({
    dataDir: MEMORY_DATA_DIR,
    redaction: { logPrompts: true, patterns: [] },
  });
});

afterAll(async () => {
  await ledger.close();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `selfhost-brief-${prefix}-`));
  dirs.push(dir);
  return dir;
}

/** A git repository with fixed authors and dates, and no global git config. */
function repository() {
  process.env.GIT_CONFIG_GLOBAL = devNull;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  const dir = tempDir("repo");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  const commit = (message: string, at: string, files: Record<string, string | null>) => {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) {
        git("rm", "-q", path);
        continue;
      }
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
      git("add", path);
    }
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Alice Example",
      GIT_AUTHOR_EMAIL: "alice@example.com",
      GIT_AUTHOR_DATE: at,
      GIT_COMMITTER_NAME: "Alice Example",
      GIT_COMMITTER_EMAIL: "alice@example.com",
      GIT_COMMITTER_DATE: at,
    };
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", message], { env });
    return git("rev-parse", "HEAD");
  };
  return { dir, git, commit };
}

let counter = 0;

function event(
  kind: LedgerEvent["kind"],
  session: string,
  ts: string,
  fields: Partial<LedgerEvent> = {},
): LedgerEvent {
  counter += 1;
  return {
    id: stableEventId(ts, `brief-test:${kind}:${session}:${counter}`),
    schema: EVENT_SCHEMA,
    ts,
    source: "hook",
    kind,
    actor: { kind: "agent", id: `codex:session:${session}` },
    agent: { vendor: "codex" },
    model: "gpt-5-codex",
    session_id: session,
    ...fields,
  };
}

const command = (value: string) => ({
  tool: { name: "exec_command", input_summary: value },
  target: { type: "command" as const, value },
});

const lines = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join("");

describe("gatherBrief from local commits", () => {
  it("reads hunks, risky lines, the run's tests and its trace, and links lines on GitHub", async () => {
    const repo = repository();
    repo.git("remote", "add", "origin", "git@github.com:acme/acme-api.git");
    repo.commit("Initial", "2026-10-01T10:00:00Z", {
      "package.json": `${JSON.stringify({ dependencies: { hono: "^4.13.0" } }, null, 2)}\n`,
      "src/auth/session.ts": lines(12, "session"),
      "test/old.test.ts": 'it("a", () => {});\nit("b", () => {});\n',
    });
    repo.git("checkout", "-q", "-b", "topic");
    const head = repo.commit("Limit session refresh", "2026-10-05T09:30:00Z", {
      "package.json": `${JSON.stringify({ dependencies: { hono: "^4.13.0", ioredis: "^5.4.1" } }, null, 2)}\n`,
      "src/auth/session.ts": lines(12, "session").replace("session 7\n", "session 7\nlimit()\n"),
      "src/limiter.test.ts": 'it.skip("refills", () => {});\n',
      "test/old.test.ts": null,
    });
    const base = repo.git("merge-base", "main", "topic");

    const session = "local-session-1";
    const vitest = event(
      "tool.called",
      session,
      "2026-10-05T09:20:00Z",
      command("pnpm vitest run"),
    );
    const push = event("tool.called", session, "2026-10-05T09:25:00Z", command("git push --force"));
    await ledger.append([
      event("session.started", session, "2026-10-05T09:00:00Z", { data: { cwd: repo.dir } }),
      vitest,
      event("tool.result", session, "2026-10-05T09:20:30Z", {
        ...command("pnpm vitest run"),
        source: "otel",
        data: { success: true },
      }),
      push,
      event("policy.evaluated", session, "2026-10-05T09:25:00Z", {
        ...command("git push --force"),
        source: "cli",
        actor: { kind: "system", id: "selfhost-policy" },
        decision: { verdict: "block", rule_id: "no-force-push", mode: "enforce" },
        data: { tool_event_id: push.id },
      }),
      event("commit.created", session, "2026-10-05T09:30:05Z", {
        tool: { name: "exec_command", input_summary: "git commit" },
        links: { commit_sha: head.slice(0, 7) },
      }),
    ]);

    const brief = await gatherBrief({
      repoDir: repo.dir,
      target: { base: "main" },
      ledger,
      highRiskPaths: ["src/auth/**"],
    });

    const blob = (sha: string, path: string, line?: number) =>
      `https://github.com/acme/acme-api/blob/${sha}/${path}${line ? `#L${line}` : ""}`;
    expect(brief.target).toEqual({ repo: "acme/acme-api", base, head, commits: [head] });
    expect(brief.task).toEqual({ title: "Limit session refresh", titleFrom: "commit" });
    expect(brief.agent).toEqual({ vendor: "codex", model: "gpt-5-codex" });
    expect(brief.risky.map(({ kind, path, line, url }) => ({ kind, path, line, url }))).toEqual([
      {
        kind: "protected_path",
        path: "src/auth/session.ts",
        line: 8,
        url: blob(head, "src/auth/session.ts", 8),
      },
      { kind: "new_dependency", path: "package.json", line: 4, url: blob(head, "package.json", 4) },
      {
        kind: "deleted_test_file",
        path: "test/old.test.ts",
        line: undefined,
        url: blob(base, "test/old.test.ts"),
      },
      {
        kind: "skipped_test",
        path: "src/limiter.test.ts",
        line: 1,
        url: blob(head, "src/limiter.test.ts", 1),
      },
    ]);
    expect(brief.files.map((f) => [f.path, f.status, f.protected])).toEqual([
      ["package.json", "modified", false],
      ["src/auth/session.ts", "modified", true],
      ["src/limiter.test.ts", "added", false],
      ["test/old.test.ts", "removed", false],
    ]);
    expect(brief.tests.map((t) => [t.command, t.result])).toEqual([["pnpm vitest run", "passed"]]);
    expect(brief.blocked).toMatchObject([
      { rule_id: "no-force-push", mode: "enforce", target: "git push --force" },
    ]);
    expect(brief.trace).toMatchObject([
      { id: session, command: "selfhost review trace local-session-1" },
    ]);
    expect(renderBrief(brief)).toContain(
      `- Protected path: [\`src/auth/session.ts:8\`](${blob(head, "src/auth/session.ts", 8)}) matches \`src/auth/**\``,
    );
  });

  it("says no run was found without a ledger", async () => {
    const repo = repository();
    repo.commit("Initial", "2026-10-01T10:00:00Z", { "a.txt": "a\n" });
    repo.git("checkout", "-q", "-b", "topic");
    repo.commit("Docs", "2026-10-05T10:00:00Z", { "README.md": "hi\n" });
    const brief = await gatherBrief({
      repoDir: repo.dir,
      target: { base: "main" },
      highRiskPaths: [],
    });
    expect(brief.target.repo).toBeUndefined();
    expect(brief.notes.trace).toEqual(["No trace found: no ledger."]);
    expect(brief.notes.tests).toEqual(["No tests known: no agent run was found."]);
  });
});

const GITHUB = join(BRIEF_FIXTURES, "github");

/** Recorded `gh api` responses; fails on anything else, and on any request that is not a GET. */
function recordedGh() {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (
      args[0] !== "api" ||
      args.some((arg) => /^(?:-X|--method|-f|-F|--field|--raw-field|--input)$/.test(arg))
    ) {
      throw new Error(`not a read: gh ${args.join(" ")}`);
    }
    const endpoint = args[args.length - 1] ?? "";
    const [path = "", query = ""] = endpoint.split("?");
    const contents = /^repos\/acme\/acme-api\/contents\/(.+)$/.exec(path);
    const file = contents
      ? join(
          GITHUB,
          "repos/acme/acme-api/contents",
          new URLSearchParams(query).get("ref") ?? "",
          decodeURIComponent(contents[1] ?? ""),
        )
      : join(GITHUB, `${path}.json`);
    try {
      return readFileSync(file, "utf8");
    } catch {
      throw new Error(`gh: HTTP 404 for ${endpoint}`);
    }
  };
  return { run, calls };
}

describe("gatherBrief from a pull request", () => {
  it("reads the pull request through gh, links lines in its diff view and joins the run", async () => {
    const repo = repository();
    repo.git("remote", "add", "origin", "https://github.com/acme/acme-api.git");
    repo.commit("Initial", "2026-10-01T10:00:00Z", { "a.txt": "a\n" });
    const { inputs } = JSON.parse(readFileSync(join(BRIEF_FIXTURES, "agent-pr.json"), "utf8")) as {
      inputs: { run: { events: LedgerEvent[] } };
    };
    await ledger.append(inputs.run.events);
    const gh = recordedGh();

    const brief = await gatherBrief({
      repoDir: repo.dir,
      target: { pr: 142 },
      ledger,
      highRiskPaths: ["src/auth/**", "db/migrations/**"],
      server: "https://selfhost.acme.example.com/",
      gh: gh.run,
      ghCacheDir: tempDir("gh-cache"),
    });

    const diff = (path: string, side: string) =>
      `https://github.com/acme/acme-api/pull/142/files#diff-${createHash("sha256").update(path).digest("hex")}${side}`;
    expect(brief.target.pr).toEqual({
      number: 142,
      url: "https://github.com/acme/acme-api/pull/142",
    });
    expect(brief.task.title).toBe("Add per-key rate limiting to the public API");
    expect(brief.task.prompt).toMatch(/^Add per-key rate limiting/);
    expect(brief.agent).toEqual({ vendor: "claude_code", model: "claude-sonnet-4-5" });
    expect(brief.risky.map((r) => [r.kind, r.url])).toEqual([
      ["protected_path", diff("db/migrations/0042_rate_limits.sql", "R1")],
      ["protected_path", diff("src/auth/keys.ts", "R20")],
      ["new_dependency", diff("package.json", "R16")],
      ["deleted_test_file", diff("test/legacy-limits.test.ts", "")],
      ["deleted_test", diff("src/billing/invoice.test.ts", "L44")],
      ["skipped_test", diff("src/middleware/rate-limit.test.ts", "R9")],
    ]);
    // Only the session that made a commit in the pull request is its run.
    expect(brief.trace.map((s) => s.url)).toEqual([
      "https://selfhost.acme.example.com/v1/events?session=5f0c2b1e-7d4a-4c8e-9a51-3e2d1c0b9a87",
    ]);
    expect(brief.tests.map((t) => t.result)).toEqual(["failed", "passed"]);
    expect(gh.calls.every((args) => args[0] === "api")).toBe(true);
  });

  it("builds the same brief from GitHub's API alone, with no clone and no gh", async () => {
    const repo = repository();
    repo.git("remote", "add", "origin", "https://github.com/acme/acme-api.git");
    repo.commit("Initial", "2026-10-01T10:00:00Z", { "a.txt": "a\n" });
    const { inputs } = JSON.parse(readFileSync(join(BRIEF_FIXTURES, "agent-pr.json"), "utf8")) as {
      inputs: { run: { events: LedgerEvent[] } };
    };
    await ledger.append(inputs.run.events);
    const settings = {
      highRiskPaths: ["src/auth/**", "db/migrations/**"],
      server: "https://selfhost.acme.example.com",
    };
    const fromGh = await gatherBrief({
      repoDir: repo.dir,
      target: { pr: 142 },
      ledger,
      ...settings,
      gh: recordedGh().run,
      ghCacheDir: tempDir("gh-cache"),
    });

    const recorded = (path: string) =>
      JSON.parse(readFileSync(join(GITHUB, "repos/acme/acme-api", `${path}.json`), "utf8"));
    const pull = recorded("pulls/142");
    const reads: string[] = [];
    const api: PullRequestApi = {
      files: async () => recorded("pulls/142/files"),
      commits: async () => recorded("pulls/142/commits"),
      contents: async (path, ref) => {
        reads.push(`${ref}:${path}`);
        try {
          return readFileSync(join(GITHUB, "repos/acme/acme-api/contents", ref, path), "utf8");
        } catch {
          return undefined;
        }
      },
    };
    const change = await readPullRequest({
      repo: "acme/acme-api",
      pull: {
        number: 142,
        url: pull.html_url,
        title: pull.title,
        body: pull.body,
        base: pull.base.sha,
        head: pull.head.sha,
      },
      api,
      ledger,
      agent: fromGh.agent,
    });
    expect(change.target.root).toBeUndefined();
    expect(change.run?.sessions).toEqual(["5f0c2b1e-7d4a-4c8e-9a51-3e2d1c0b9a87"]);
    // Contents only for the changed manifest, at the base and the head.
    expect(reads).toEqual([`${pull.base.sha}:package.json`, `${pull.head.sha}:package.json`]);
    expect(buildBrief(briefInputs(change, settings))).toEqual(fromGh);
  });

  it("says the run data is missing when no session made the commits", async () => {
    const recorded = (path: string) =>
      JSON.parse(readFileSync(join(GITHUB, "repos/acme/acme-api", `${path}.json`), "utf8"));
    const empty = await openLedger({ dataDir: MEMORY_DATA_DIR });
    try {
      const change = await readPullRequest({
        repo: "acme/acme-api",
        pull: {
          number: 142,
          url: "https://github.com/acme/acme-api/pull/142",
          title: "Add per-key rate limiting to the public API",
          base: "2b4d6f8a0c1e3a5b7d9f1a3c5e7b9d0f2a4c6e8b",
          head: "9c1e5a7b3d2f4e6a8b0c1d3e5f7a9b2c4d6e8f0a",
        },
        api: {
          files: async () => recorded("pulls/142/files"),
          commits: async () => recorded("pulls/142/commits"),
          contents: async () => undefined,
        },
        ledger: empty,
      });
      expect(change.run).toBeUndefined();
      expect(change.runMissing).toBe("no session in the ledger made these commits");
      expect(change.manifestProblem).toBe("could not read package.json from GitHub");
      const brief = buildBrief(briefInputs(change, { highRiskPaths: [] }));
      expect(brief.notes.trace).toEqual([
        "No trace found: no session in the ledger made these commits.",
      ]);
    } finally {
      await empty.close();
    }
  });
});

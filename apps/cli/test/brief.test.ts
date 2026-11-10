import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import { openLedger } from "@selfhost/ledger";
import { EVENT_SCHEMA, type LedgerEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { run, tempDir } from "./run.js";

const RISK_TOML = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "fixtures", "risk", "selfhost.toml"),
  "utf8",
);

/** main with one commit, then a topic branch with one commit that touches a protected path. */
function repo() {
  process.env.GIT_CONFIG_GLOBAL = devNull;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  const dir = tempDir("brief");
  const env = (at: string) => ({
    ...process.env,
    GIT_AUTHOR_NAME: "Alice Example",
    GIT_AUTHOR_EMAIL: "alice@example.com",
    GIT_AUTHOR_DATE: at,
    GIT_COMMITTER_NAME: "Alice Example",
    GIT_COMMITTER_EMAIL: "alice@example.com",
    GIT_COMMITTER_DATE: at,
  });
  const git = (at: string, ...args: string[]) =>
    execFileSync("git", ["-C", dir.root, ...args], { env: env(at), encoding: "utf8" }).trim();
  git("2026-10-01T10:00:00Z", "init", "-q", "-b", "main");
  dir.write("README.md", "acme\n");
  dir.write("selfhost.toml", RISK_TOML);
  git("2026-10-01T10:00:00Z", "add", ".");
  git("2026-10-01T10:00:00Z", "commit", "-q", "-m", "Initial");
  git("2026-10-05T09:30:00Z", "checkout", "-q", "-b", "topic");
  dir.write("src/auth/session.ts", "export const ttl = 60;\n");
  git("2026-10-05T09:30:00Z", "add", ".");
  git("2026-10-05T09:30:00Z", "commit", "-q", "-m", "Shorten the session ttl");
  return { dir, head: git("2026-10-05T09:30:00Z", "rev-parse", "HEAD") };
}

/** No ledger: a data folder that does not exist, never the real ~/.selfhost/data. */
const noLedger = () => ({ SELFHOST_DATA_DIR: tempDir("data").path("none") });

let counter = 0;
function event(kind: LedgerEvent["kind"], ts: string, fields: Partial<LedgerEvent>): LedgerEvent {
  counter += 1;
  return {
    id: `0199b3a0-0000-7000-8000-${String(counter).padStart(12, "0")}`,
    schema: EVENT_SCHEMA,
    ts,
    source: "hook",
    kind,
    actor: { kind: "agent", id: "codex:session:sess-cli" },
    agent: { vendor: "codex" },
    session_id: "sess-cli",
    ...fields,
  };
}

describe("selfhost review brief", () => {
  it("prints the brief as a Markdown comment, with every section and the marker first", async () => {
    const { dir } = repo();
    const result = await run(["review", "brief", "--base", "main"], {
      cwd: dir.root,
      env: noLedger(),
    });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    const lines = result.out.split("\n");
    expect(lines[0]).toBe("<!-- selfhost:brief v1 -->");
    expect(lines.filter((line) => line.startsWith("### "))).toEqual([
      "### Task",
      "### Plan",
      "### Lines to look at",
      "### Files touched",
      "### Commands run",
      "### Tests run",
      "### Blocked actions",
      "### Cost",
      "### Trace",
    ]);
    expect(result.out).toContain(
      "**Shorten the session ttl** (first commit subject; no pull request)",
    );
    expect(result.out).toContain("- Protected path: `src/auth/session.ts:1` matches `src/auth/**`");
    expect(result.out).toContain("No tests known: no agent run was found.");
    expect(result.out).toContain("No trace found: no ledger.");
  });

  it("prints the brief as JSON", async () => {
    const { dir, head } = repo();
    const result = await run(["review", "brief", "--base", "main", "--json"], {
      cwd: dir.root,
      env: noLedger(),
    });
    const brief = JSON.parse(result.out);
    expect(brief).toMatchObject({
      schema: "selfhost.review_brief/v1",
      target: { head, commits: [head] },
      risky: [{ kind: "protected_path", path: "src/auth/session.ts", line: 1 }],
      tests: [],
    });
    expect(brief.notes.tests).toEqual(["No tests known: no agent run was found."]);
  });

  it("links the trace to the team server and prints it with review trace", async () => {
    const { dir, head } = repo();
    const data = tempDir("ledger").path("data");
    const ledger = await openLedger({ dataDir: data });
    try {
      await ledger.append([
        event("session.started", "2026-10-05T09:00:00.000Z", { data: { cwd: dir.root } }),
        event("tool.called", "2026-10-05T09:10:00.000Z", {
          tool: { name: "exec_command", input_summary: "pnpm test" },
          target: { type: "command", value: "pnpm test" },
        }),
        event("tool.result", "2026-10-05T09:11:00.000Z", {
          source: "otel",
          tool: { name: "exec_command", input_summary: "pnpm test" },
          target: { type: "command", value: "pnpm test" },
          data: { success: true },
        }),
        event("commit.created", "2026-10-05T09:30:01.000Z", {
          tool: { name: "exec_command", input_summary: "git commit" },
          links: { commit_sha: head },
        }),
      ]);
    } finally {
      await ledger.close();
    }
    const configPath = tempDir("config").write(
      "config.json",
      JSON.stringify({
        server: "https://selfhost.acme.example.com",
        token: "selfhost_pt_x",
        person: "alice@example.com",
        team: "platform",
      }),
    );

    const brief = await run(["review", "brief", "--base", "main", "--data-dir", data], {
      cwd: dir.root,
      configPath,
    });
    expect(brief.err).toBe("");
    expect(brief.out).toContain("1 test run: 1 passed. The last run passed.");
    expect(brief.out).toContain(
      "- `sess-cli` (codex, 4 events, 2026-10-05 09:00 to 09:30 UTC): [run view](https://selfhost.acme.example.com/?screen=run&run=sess-cli)",
    );

    const trace = await run(["review", "trace", "sess-cli", "--data-dir", data], { cwd: dir.root });
    expect(trace.err).toBe("");
    expect(trace.out.split("\n")).toEqual([
      "2026-10-05T09:00:00.000Z  session.started",
      "2026-10-05T09:10:00.000Z  tool.called  exec_command  pnpm test",
      "2026-10-05T09:11:00.000Z  tool.result  exec_command  pnpm test  succeeded",
      `2026-10-05T09:30:01.000Z  commit.created  exec_command  git commit  ${head}`,
    ]);
    const json = await run(["review", "trace", "sess-cli", "--data-dir", data, "--json"], {
      cwd: dir.root,
    });
    expect(JSON.parse(json.out)).toMatchObject({
      schema: "selfhost.review_trace/v1",
      session: "sess-cli",
    });
  });

  it.each([
    [["review", "brief"], "Pass a pull request number or --base <ref>"],
    [["review", "brief", "7", "--base", "main"], "Pass a pull request number or --base <ref>"],
    [["review", "brief", "seven"], 'Expected a pull request number, got "seven"'],
    [["review", "trace", "sess-none"], "No ledger on this machine"],
  ])("exits 1 on %j", async (args, message) => {
    const { dir } = repo();
    const result = await run([...args, "--json"], { cwd: dir.root, env: noLedger() });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).error).toContain(message);
  });

  it("runs without ee/: the command never loads the commercial edition", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "src", "brief.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["'](?:\.\/ee\.js|@selfhost\/ee-)/);
  });
});

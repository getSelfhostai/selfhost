import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { dirname, join } from "node:path";
import { openLedger, stableEventId } from "@selfhost/ledger";
import { EVENT_SCHEMA, type LedgerEvent, type ProvenanceReport } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { createProgram } from "../src/program.js";
import { gitAttribution } from "../src/scan/git-attribution.js";
import { run, tempDir } from "./run.js";

const NOW = new Date("2026-11-08T00:00:00Z");

const day = (days: number, hours = 0) =>
  new Date(Date.parse("2026-10-01T09:00:00Z") + (days * 24 + hours) * 3_600_000).toISOString();

const rows = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join("");

/** A repository on main with plain commits only: no trailers, links or bot authors. */
function fixtureRepo() {
  process.env.GIT_CONFIG_GLOBAL = devNull;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  const dir = tempDir("provenance");
  const git = (args: string[], at = day(0), email = "alice@example.com") =>
    execFileSync("git", ["-C", dir.root, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Dev",
        GIT_AUTHOR_EMAIL: email,
        GIT_AUTHOR_DATE: at,
        GIT_COMMITTER_NAME: "Dev",
        GIT_COMMITTER_EMAIL: email,
        GIT_COMMITTER_DATE: at,
      },
    }).trim();
  const commit = (message: string, at: string, files: Record<string, string>, email?: string) => {
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir.root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      git(["add", path], at, email);
    }
    git(["commit", "-q", "-m", message], at, email);
    return git(["rev-parse", "HEAD"]);
  };
  git(["init", "-q", "-b", "main"]);
  const shas = {
    base: commit("Initial", day(0), { "README.md": "acme\n", "api/app.ts": rows(4, "app") }),
    // The Claude Code session recorded this commit in the ledger.
    billing: commit("Add billing", day(1), { "api/billing.ts": rows(30, "bill") }),
    // A Codex session edited this file just before the commit: a file and time match.
    report: commit("Add report", day(2), { "web/report.ts": rows(10, "report") }),
    // Bob fixes forward five of the billing lines three days after the merge.
    fix: commit(
      "Fix billing rounding",
      day(4),
      {
        "api/billing.ts": rows(30, "bill")
          .split("\n")
          .map((row, i) => (i < 5 ? `${row} fixed` : row))
          .join("\n"),
      },
      "bob@example.com",
    ),
    // Squash merge of pull request #4, which the ledger says Copilot made.
    cache: commit("Add cache (#4)", day(5), { "api/cache.ts": rows(8, "cache") }),
  };
  return { dir, shas };
}

let counter = 0;
function event(fields: Partial<LedgerEvent> & Pick<LedgerEvent, "kind" | "ts">): LedgerEvent {
  counter += 1;
  return {
    id: stableEventId(fields.ts, `provenance-test:${counter}`),
    schema: EVENT_SCHEMA,
    source: "hook",
    actor: { kind: "agent", id: "agent" },
    ...fields,
  };
}

/** The runs behind the fixture commits, as hooks and the GitHub App record them. */
function fixtureRuns(root: string, shas: Record<string, string>): LedgerEvent[] {
  const claude = { agent: { vendor: "claude_code" as const }, model: "claude-opus-4-5" };
  const codex = { agent: { vendor: "codex" as const }, model: "gpt-5.5" };
  return [
    event({
      kind: "session.started",
      ts: day(1, -1),
      session_id: "s-claude",
      ...claude,
      data: { cwd: root },
    }),
    event({
      kind: "commit.created",
      ts: day(1, 0),
      session_id: "s-claude",
      ...claude,
      links: { commit_sha: (shas.billing as string).slice(0, 7) },
    }),
    event({
      kind: "session.started",
      ts: day(2, -1),
      session_id: "s-codex",
      ...codex,
      data: { cwd: root },
    }),
    event({
      kind: "tool.called",
      ts: day(2, -0.25),
      session_id: "s-codex",
      ...codex,
      tool: { name: "apply_patch" },
      target: { type: "file", value: join(root, "web/report.ts") },
    }),
    event({
      kind: "pr.merged",
      source: "github",
      ts: day(5),
      repo: "acme/api",
      actor: { kind: "person", id: "alice" },
      agent: { vendor: "copilot" },
      links: { pr_url: "https://github.com/acme/api/pull/4" },
      data: { number: 4, additions: 8 },
    }),
  ];
}

async function seededLedger(root: string, shas: Record<string, string>) {
  const data = tempDir("provenance-data");
  const ledger = await openLedger({ dataDir: data.root });
  await ledger.append(fixtureRuns(root, shas));
  await ledger.close();
  return data.root;
}

describe("selfhost provenance", () => {
  it("is registered on the program", () => {
    expect(createProgram().commands.map((command) => command.name())).toContain("provenance");
  });

  it("joins merged lines to the ledger's runs and counts the fix-forward as rework", async () => {
    const { dir, shas } = fixtureRepo();
    // The pull request event names acme/api; the repo has no remote, so say which it is.
    execFileSync("git", [
      "-C",
      dir.root,
      "remote",
      "add",
      "origin",
      "https://github.com/acme/api.git",
    ]);
    const dataDir = await seededLedger(dir.root, shas);
    const result = await run(
      ["provenance", "--json", "--no-github", "--since", "2026-10-01", "--data-dir", dataDir],
      { cwd: dir.root, now: NOW, env: {} },
    );
    expect(result.err).toBe("");
    const report = JSON.parse(result.out) as ProvenanceReport;
    expect(report).toMatchObject({ repo: "acme/api", branch: "main", status: "computed" });
    expect(
      report.by_agent.map((row) => [
        row.vendor,
        row.model,
        row.lines,
        row.runs,
        row.reworked_lines,
      ]),
    ).toEqual([
      ["claude_code", "claude-opus-4-5", 30, 1, 5],
      ["codex", "gpt-5.5", 10, 1, 0],
      ["copilot", null, 8, 0, 0],
      ["unattributed", null, 10, 0, 0],
    ]);
    expect(report.modules.map((row) => [row.module, row.agent_lines, row.above_threshold])).toEqual(
      [
        ["api", 38, false],
        ["web", 10, false],
        ["(root)", 0, false],
      ],
    );
  });

  it("prints the tables and the definitions as text", async () => {
    const { dir, shas } = fixtureRepo();
    const dataDir = await seededLedger(dir.root, shas);
    const result = await run(["provenance", "--since", "2026-10-01", "--data-dir", dataDir], {
      cwd: dir.root,
      now: NOW,
      env: {},
    });
    expect(result.code).toBe(0);
    const out = result.out;
    expect(out).toContain("selfhost provenance: ");
    expect(out).toContain("Lines merged: 58, 40 by agents (69.0%), in 5 merges.");
    expect(out).toContain(
      "Agent lines reverted or reworked within 14 days of merge: 5 of 40 (12.5%).",
    );
    expect(out).toMatch(/Claude Code \(claude-opus-4-5\)\s+30\s+51\.7%\s+1\s+0\s+5\s+16\.7%\s+0/);
    expect(out).toContain("fix-forward edits count");
  });

  it("works with no ledger, from git alone", async () => {
    const { dir } = fixtureRepo();
    const result = await run(
      ["provenance", "--json", "--since", "2026-10-01", "--data-dir", tempDir("none").path("x")],
      { cwd: dir.root, now: NOW, env: {} },
    );
    const report = JSON.parse(result.out) as ProvenanceReport;
    expect(report.totals.lines).toBe(58);
    expect(report.totals.agent_lines).toBe(0);
    expect(report.by_agent.map((row) => row.vendor)).toEqual(["unattributed"]);
  });

  it("shows vendor stats next to the git numbers and refuses a malformed file", async () => {
    const { dir } = fixtureRepo();
    const stats = dir.write(
      "stats.json",
      JSON.stringify([{ vendor: "cursor", day: "2026-10-03", lines_added: 25, lines_removed: 3 }]),
    );
    const ok = await run(
      [
        "provenance",
        "--json",
        "--since",
        "2026-10-01",
        "--vendor-stats",
        stats,
        "--data-dir",
        tempDir("none").path("x"),
      ],
      { cwd: dir.root, now: NOW, env: {} },
    );
    expect((JSON.parse(ok.out) as ProvenanceReport).vendor_reported).toEqual([
      { vendor: "cursor", lines_added: 25, lines_removed: 3 },
    ]);
    const bad = dir.write("bad.json", JSON.stringify({ stats: [{ vendor: "cursor" }] }));
    const refused = await run(
      ["provenance", "--json", "--vendor-stats", bad, "--data-dir", tempDir("none").path("x")],
      { cwd: dir.root, now: NOW, env: {} },
    );
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.out).error).toBe(
      "--vendor-stats: stats[0].lines_added: Expected required property",
    );
  });
});

describe("selfhost scan with provenance", () => {
  it("adds the merged lines to the JSON, the text and the HTML report", async () => {
    const { dir } = fixtureRepo();
    const empty = tempDir("scan-logs");
    const common = {
      cwd: dir.root,
      now: NOW,
      env: { CLAUDE_CONFIG_DIR: empty.path("claude"), CODEX_HOME: empty.path("codex") },
      collectAttribution: gitAttribution({ github: false }),
    };
    const json = await run(
      ["scan", "--json", "--since", "2026-10-01", "--report", dir.path("r.html")],
      common,
    );
    const report = JSON.parse(json.out);
    expect(report.provenance).toMatchObject({
      schema: "selfhost.provenance/v1",
      totals: { lines: 58, agent_lines: 0 },
    });
    const text = await run(["scan", "--since", "2026-10-01"], common);
    expect(text.out).toContain("Merged lines");
    expect(text.out).toContain("agents wrote 0 of 58 merged lines (0.0%)");
  });
});

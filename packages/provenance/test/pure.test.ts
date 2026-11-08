import type { CommitRecord } from "@selfhost/attribution";
import { LOCKFILES as PR_LOCKFILES } from "@selfhost/pr";
import { EVENT_SCHEMA, type LedgerEvent, parseConfig } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import {
  assignFates,
  DEFAULT_SETTINGS,
  isRevertStep,
  type LandedLine,
  type Landing,
  LOCKFILES,
  ledgerOnlyReport,
  lineAuthors,
  type MainlineCommit,
  mergedPulls,
  moduleOf,
  parseBlame,
  parseNumstat,
  pullNumber,
  revertsLanding,
  revertTargets,
  runCommits,
  settingsFromConfig,
  type TrackedLanding,
  touchedModules,
} from "../src/index.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_M = "c".repeat(40);

function commit(partial: Partial<MainlineCommit> & { sha: string }): MainlineCommit {
  return {
    parents: ["0".repeat(40)],
    committedAt: "2026-10-01T09:00:00.000Z",
    committerEmail: "alice@example.com",
    authorEmail: "alice@example.com",
    subject: "Change",
    message: "Change\n",
    files: [],
    ...partial,
  };
}

const landingOf = (...commits: MainlineCommit[]): Landing => ({
  commits,
  mergedAt: commits[commits.length - 1]?.committedAt ?? "",
});

describe("lockfiles", () => {
  it("leaves out the same lockfiles as the risk score's size", () => {
    expect([...LOCKFILES].sort()).toEqual([...PR_LOCKFILES].sort());
  });
});

describe("parseBlame", () => {
  it("keeps origin, path and line of each non-boundary line and marks blank ones", () => {
    const out = [
      `${SHA_A} 1 1 2`,
      "author Alice",
      "boundary",
      "filename src/a.ts",
      "\told",
      `${SHA_A} 2 2`,
      "author Alice",
      "boundary",
      "filename src/a.ts",
      "\told 2",
      `${SHA_B} 7 3 2`,
      "author Bob",
      `previous ${SHA_A} src/old.ts`,
      "filename src/old.ts",
      "\tnew",
      `${SHA_B} 8 4`,
      "filename src/old.ts",
      "\t   ",
      "",
    ].join("\n");
    expect(parseBlame(out)).toEqual([
      { origin: SHA_B, path: "src/old.ts", line: 7, blank: false },
      { origin: SHA_B, path: "src/old.ts", line: 8, blank: true },
    ]);
  });
});

describe("parseNumstat", () => {
  it("reads renames, binary files and plain changes", () => {
    expect(
      parseNumstat("\n3\t1\tsrc/a.ts\x000\t0\t\x00pkg/old.ts\x00pkg/new.ts\x00-\t-\tlogo.png\x00"),
    ).toEqual([
      { path: "src/a.ts", additions: 3, deletions: 1, binary: false },
      { path: "pkg/new.ts", previousPath: "pkg/old.ts", additions: 0, deletions: 0, binary: false },
      { path: "logo.png", additions: 0, deletions: 0, binary: true },
    ]);
  });
});

describe("modules", () => {
  it("uses the first matching glob, then the top folders, then (root)", () => {
    const settings = {
      modules: { billing: ["apps/*/src/billing/**"], api: ["apps/server/**"] },
      moduleDepth: 2,
    };
    expect(moduleOf("apps/server/src/billing/x.ts", settings)).toBe("billing");
    expect(moduleOf("apps/server/src/app.ts", settings)).toBe("api");
    expect(moduleOf("packages/provenance/src/read.ts", settings)).toBe("packages/provenance");
    expect(moduleOf("docs/a.md", settings)).toBe("docs");
    expect(moduleOf("README.md", settings)).toBe("(root)");
    expect(
      touchedModules(
        [{ path: "apps/server/a.ts", previousPath: "lib/a.ts" }, { path: "README.md" }],
        {
          modules: {},
          moduleDepth: 1,
        },
      ),
    ).toEqual(["(root)", "apps", "lib"]);
  });

  it("reads the settings from [review] in selfhost.toml", () => {
    const parsed = parseConfig(
      'version = 1\n[review]\nrevert_rate_threshold = 0.4\nrevert_window_days = 7\nmodule_depth = 2\n[review.modules]\napi = ["apps/server/**"]\n',
    );
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    expect(settingsFromConfig(parsed.config)).toEqual({
      modules: { api: ["apps/server/**"] },
      moduleDepth: 2,
      windowDays: 7,
      threshold: 0.4,
    });
    const defaults = parseConfig("version = 1\n");
    if (!defaults.ok) throw new Error("defaults");
    expect(settingsFromConfig(defaults.config)).toEqual(DEFAULT_SETTINGS);
  });

  it("rejects a threshold outside 0 to 1 and a window over 90 days", () => {
    const bad = parseConfig(
      "version = 1\n[review]\nrevert_rate_threshold = 25\nrevert_window_days = 120\n",
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.map((e) => e.field).sort()).toEqual([
        "review.revert_rate_threshold",
        "review.revert_window_days",
      ]);
    }
  });
});

describe("reverts", () => {
  it("reads the pull request a merge or squash commit merged", () => {
    expect(pullNumber({ subject: "Merge pull request #7 from acme/x", parents: ["a", "b"] })).toBe(
      7,
    );
    expect(pullNumber({ subject: "Add flags (#12)", parents: ["a"] })).toBe(12);
    expect(pullNumber({ subject: "Add flags", parents: ["a"] })).toBeUndefined();
  });

  it("finds the commits, pull requests and subject a revert names", () => {
    expect(
      revertTargets(
        `Revert "Add flags (#12)" (#13)\n\nReverts acme/api#12\n\nThis reverts commit ${SHA_A}.\n`,
      ),
    ).toEqual({ shas: [SHA_A], pulls: [12], subject: "Add flags (#12)" });
  });

  it("matches a landing by its commits, the origins of its lines, its pull request or its subject", () => {
    const landing = { ...landingOf(commit({ sha: SHA_A, subject: "Add flags (#12)" })), pr: 12 };
    const by = (message: string) =>
      revertsLanding({ message, subject: message.split("\n")[0] ?? "" }, landing, [SHA_B]);
    expect(by(`Revert x\n\nThis reverts commit ${SHA_A.slice(0, 7)}.`)).toBe(true);
    expect(by(`Revert x\n\nThis reverts commit ${SHA_B.slice(0, 10)}.`)).toBe(true);
    expect(by("Undo\n\nReverts acme/api#12")).toBe(true);
    expect(by('Revert "Add flags (#12)" (#13)')).toBe(true);
    expect(by('Revert "Add other (#14)"')).toBe(false);
    expect(by("Fix flags (#15)")).toBe(false);
  });
});

describe("fates", () => {
  const landing = landingOf(commit({ sha: SHA_A }));
  const lines: LandedLine[] = Array.from({ length: 10 }, (_, i) => ({
    key: `${SHA_A}:a.ts:${i + 1}`,
    origin: SHA_A,
    path: "a.ts",
    module: "(root)",
  }));
  const step = (
    sha: string,
    keys: number[],
    aliveBefore: number,
    added: number,
    message = "Edit",
  ) => ({
    commit: commit({ sha, message, subject: message }),
    lost: new Map(keys.map((k) => [`${SHA_A}:a.ts:${k}`, 1])),
    aliveBefore,
    addedToFiles: added,
  });

  it("counts edits as rework and a removal of all that is left, with little added, as a revert", () => {
    const steps = [step(SHA_B, [1, 2], 10, 2), step(SHA_M, [3, 4, 5, 6, 7, 8, 9, 10], 8, 0)];
    const fates = assignFates(landing, lines, steps);
    expect(fates.filter((l) => l.fate === "reworked").map((l) => l.by)).toEqual([SHA_B, SHA_B]);
    expect(fates.filter((l) => l.fate === "reverted")).toHaveLength(8);
  });

  it("calls a full rewrite rework: it removes every line but adds as many back", () => {
    expect(isRevertStep(step(SHA_B, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10, 10), landing, [])).toBe(
      false,
    );
    expect(isRevertStep(step(SHA_B, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10, 1), landing, [])).toBe(
      true,
    );
    expect(isRevertStep(step(SHA_B, [1, 2], 10, 0), landing, [])).toBe(false);
    expect(
      isRevertStep(
        step(SHA_B, [1, 2], 10, 30, `Revert\n\nThis reverts commit ${SHA_A}.`),
        landing,
        [],
      ),
    ).toBe(true);
  });
});

describe("lineAuthors", () => {
  const squash = commit({ sha: SHA_A, subject: "Add cache (#11)" });
  const merge = commit({
    sha: SHA_M,
    parents: ["0".repeat(40), SHA_B],
    subject: "Merge pull request #5 from x/y",
  });
  const tracked = (landing: Landing, origins: string[]): TrackedLanding => ({
    landing,
    lines: origins.map((origin, i) => ({
      key: `${origin}:f:${i}`,
      origin,
      path: "f",
      module: "(root)",
      fate: "kept",
    })),
    open: false,
    revertedBy: [],
  });
  const record = (sha: string, extra: Partial<CommitRecord> = {}): CommitRecord => ({
    sha,
    authoredAt: "2026-10-01T09:00:00.000Z",
    authorEmail: "Alice@Example.com",
    subject: "x",
    files: ["f"],
    additions: 10,
    deletions: 0,
    ...extra,
  });

  it("prefers the run that recorded the commit, then the commit, then the pull request, then vendor stats", () => {
    const landing = { ...landingOf(squash), pr: 11 };
    const commits = [record(SHA_A, { agent: { vendor: "codex" }, signal: "session_id" })];
    const pulls = [{ number: 11, agent: { vendor: "copilot" as const } }];
    const stats = [{ vendor: "cursor" as const, commit: SHA_A.slice(0, 8), lines_added: 9 }];
    const run = {
      sha: SHA_A.slice(0, 9),
      agent: { vendor: "goose" as const, model: "m" },
      sessionId: "s1",
    };
    const t = tracked(landing, [SHA_A]);
    expect(lineAuthors({ commits, pulls, vendorStats: stats, runs: [run] })(SHA_A, t)).toEqual({
      agent: { vendor: "goose", model: "m" },
      person: "alice@example.com",
      sessionId: "s1",
      signal: "run",
    });
    expect(lineAuthors({ commits, pulls, vendorStats: stats })(SHA_A, t).agent).toEqual({
      vendor: "codex",
    });
    expect(
      lineAuthors({ commits: [record(SHA_A)], pulls, vendorStats: stats })(SHA_A, t).signal,
    ).toBe("pull_request");
    expect(lineAuthors({ commits: [record(SHA_A)], vendorStats: stats })(SHA_A, t)).toEqual({
      agent: { vendor: "cursor" },
      person: "alice@example.com",
      signal: "vendor_stats",
    });
    // A vendor that claims under half of the commit's lines does not name its agent.
    const few = [{ vendor: "cursor" as const, commit: SHA_A, lines_added: 4 }];
    expect(
      lineAuthors({ commits: [record(SHA_A)], vendorStats: few })(SHA_A, t).agent,
    ).toBeUndefined();
  });

  it("gives a merge commit's own lines to the agent behind most of the pull request's lines", () => {
    const landing = { ...landingOf(merge), pr: 5 };
    const t = tracked(landing, [SHA_B, SHA_B, SHA_M]);
    const commits = [
      record(SHA_B, {
        agent: { vendor: "claude_code", model: "claude-opus-4-5" },
        signal: "session_id",
      }),
    ];
    expect(lineAuthors({ commits })(SHA_M, t)).toEqual({
      agent: { vendor: "claude_code", model: "claude-opus-4-5" },
      person: "alice@example.com",
      signal: "merge",
    });
    expect(
      lineAuthors({ commits, pulls: [{ number: 5, agent: { vendor: "codex" } }] })(SHA_M, t).agent,
    ).toEqual({
      vendor: "codex",
    });
  });
});

const event = (partial: Partial<LedgerEvent> & Pick<LedgerEvent, "kind" | "ts">): LedgerEvent => ({
  id: "01960000-0000-7000-8000-000000000000",
  schema: EVENT_SCHEMA,
  source: "github",
  actor: { kind: "system", id: "github" },
  ...partial,
});

describe("from the ledger", () => {
  const events: LedgerEvent[] = [
    event({
      id: "01960000-0000-7000-8000-000000000001",
      kind: "pr.merged",
      ts: "2026-10-05T10:00:00.000Z",
      repo: "acme/api",
      agent: { vendor: "claude_code" },
      model: "claude-opus-4-5",
      actor: { kind: "person", id: "alice" },
      links: { pr_url: "https://github.com/acme/api/pull/3" },
      data: { number: 3, additions: 120 },
    }),
    event({
      id: "01960000-0000-7000-8000-000000000002",
      kind: "pr.merged",
      ts: "2026-10-06T10:00:00.000Z",
      repo: "acme/api",
      actor: { kind: "person", id: "bob" },
      links: { pr_url: "https://github.com/acme/api/pull/4" },
      data: { number: 4, additions: 40 },
    }),
    event({
      id: "01960000-0000-7000-8000-000000000003",
      kind: "pr.merged",
      ts: "2026-10-06T10:00:00.000Z",
      repo: "acme/web",
      data: { number: 9, additions: 999 },
    }),
    event({
      id: "01960000-0000-7000-8000-000000000004",
      source: "cli",
      kind: "commit.created",
      ts: "2026-10-05T09:00:00.000Z",
      session_id: "sess-1",
      agent: { vendor: "claude_code" },
      model: "claude-opus-4-5",
      links: { commit_sha: "ABCDEF1", pr_url: "https://github.com/acme/api/pull/3" },
    }),
  ];

  it("reads the runs that recorded commits and the merged pull requests of a repo", () => {
    expect(runCommits(events)).toEqual([
      {
        sha: "abcdef1",
        agent: { vendor: "claude_code", model: "claude-opus-4-5" },
        sessionId: "sess-1",
      },
    ]);
    expect(
      mergedPulls(events, "acme/api").map((p) => [p.number, p.agent?.vendor, p.person]),
    ).toEqual([
      [3, "claude_code", "alice"],
      [4, undefined, "bob"],
    ]);
  });

  it("builds a ledger-only report with lines by agent and person and no rates", () => {
    const report = ledgerOnlyReport({
      repo: "acme/api",
      from: new Date("2026-10-01T00:00:00Z"),
      to: new Date("2026-11-01T00:00:00Z"),
      settings: DEFAULT_SETTINGS,
      events,
      note: "no clone of acme/api",
    });
    expect(report).toMatchObject({
      status: "ledger_only",
      note: "no clone of acme/api",
      modules: [],
      totals: { lines: 160, agent_lines: 120, landings: 2, agent_revert_rework_rate: null },
    });
    expect(report.by_agent).toEqual([
      expect.objectContaining({
        vendor: "claude_code",
        model: "claude-opus-4-5",
        lines: 120,
        runs: 1,
        revert_rework_rate: null,
      }),
      expect.objectContaining({ vendor: "unattributed", lines: 40, runs: 0, reverted_lines: null }),
    ]);
    expect(report.by_person.map((p) => [p.person, p.lines, p.agent_lines])).toEqual([
      ["alice", 120, 120],
      ["bob", 40, 0],
    ]);
  });
});

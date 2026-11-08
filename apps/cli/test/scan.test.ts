import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { percent, usd } from "../src/format.js";
import { createProgram } from "../src/program.js";
import type { SessionHint } from "../src/scan/attribution.js";
import {
  buildScanReport,
  readLocalEvents,
  runScan,
  type ScanReport,
  sessionHintsFromEvents,
} from "../src/scan/index.js";
import { LEAK_RULES } from "../src/scan/leaks.js";
import { CCUSAGE_CREDIT, NEXT_STEP } from "../src/scan/report.js";
import { summarizeSessions } from "../src/scan/sessions.js";
import { AGENT_COUNT_QUESTION } from "../src/scan/telemetry.js";
import { run, tempDir } from "./run.js";
import {
  attributionFor,
  type LogDirs,
  leakySessions,
  monthOfSessions,
  uuid,
  writeSessions,
} from "./scan-logs.js";

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");
const FIXTURE_LOGS = {
  claudeDir: join(fixtures, "claude-code"),
  codexDir: join(fixtures, "codex"),
};
const MARKER_LOGS = {
  claudeDir: join(fixtures, "markers", "claude-code"),
  codexDir: join(fixtures, "markers", "codex"),
};
const NOW = new Date("2026-10-31T00:00:00Z");
const LEAK_DAY = new Date("2026-10-20T08:00:00Z");

const envFor = (logs: LogDirs, extra: Record<string, string> = {}) => ({
  CLAUDE_CONFIG_DIR: logs.claudeDir,
  CODEX_HOME: logs.codexDir,
  ...extra,
});

/** A working folder with no git repo, and a config path inside it. */
function workspace(prefix: string, git = false) {
  const dir = tempDir(prefix);
  if (git) mkdirSync(dir.path(".git"));
  return { dir, deps: { cwd: dir.root, configPath: dir.path("home", "config.json"), now: NOW } };
}

function leakyLogs(): LogDirs {
  return writeSessions(tempDir("scan-leaks").root, leakySessions(LEAK_DAY));
}

async function scanJson(logs: LogDirs, args: string[] = [], deps = {}): Promise<ScanReport> {
  const { deps: base } = workspace("scan-json");
  const result = await run(["scan", "--json", "--since", "2026-10-01", ...args], {
    env: envFor(logs),
    ...base,
    ...deps,
  });
  expect(result.err).toBe("");
  return JSON.parse(result.out) as ScanReport;
}

describe("session hints for the git join", () => {
  it("gives each session its window, vendor, main model, cwd and edited files", async () => {
    const events = await readLocalEvents({ since: new Date("2026-10-01"), ...FIXTURE_LOGS });
    const hints = sessionHintsFromEvents(events);
    expect(hints).toHaveLength(6);
    const byId = new Map(hints.map((hint) => [hint.sessionId, hint]));
    const claude = byId.get("665bce74-4bdc-4164-8bb1-cc4246de2400") as SessionHint;
    const own = events.filter((event) => event.session_id === claude.sessionId).map((e) => e.ts);
    expect(claude).toMatchObject({
      vendor: "claude_code",
      model: "claude-opus-5-5",
      cwd: "/home/dev/acme-api",
      start: own.sort()[0],
      end: own.sort().at(-1),
    });
    expect(claude.files).toContain("src/app.ts");
    expect(byId.get("01a10ca6-8deb-75c0-92f6-bb789b300b1a")).toMatchObject({
      vendor: "codex",
      model: "gpt-5.5",
      files: ["src/middleware/logger.ts"],
    });
    // The read-only codex exec session edited nothing.
    expect(byId.get("01a11f7b-344a-7dcf-a38c-f382a684ecd2")?.files).toEqual([]);
  });
});

describe("selfhost scan", () => {
  it("is registered with its options", () => {
    const scan = createProgram().commands.find((command) => command.name() === "scan");
    expect(scan?.options.map((option) => option.long)).toEqual([
      "--since",
      "--repo",
      "--json",
      "--report",
      "--share",
    ]);
  });

  it("gives cost by agent and model that matches ccusage on the fixture logs", async () => {
    const report = await scanJson(FIXTURE_LOGS);
    const expected = JSON.parse(
      readFileSync(join(fixtures, "expected", "ccusage-all-daily.json"), "utf8"),
    ) as {
      daily: { modelBreakdowns: Record<string, number | string>[] }[];
      totals: { totalCost: number; totalTokens: number };
    };
    type Sums = { cost: number; input: number; output: number; read: number; write: number };
    const models = new Map<string, Sums>();
    for (const day of expected.daily) {
      for (const breakdown of day.modelBreakdowns) {
        const name = String(breakdown.modelName);
        const sum = models.get(name) ?? { cost: 0, input: 0, output: 0, read: 0, write: 0 };
        sum.cost += Number(breakdown.cost);
        sum.input += Number(breakdown.inputTokens);
        sum.output += Number(breakdown.outputTokens);
        sum.read += Number(breakdown.cacheReadTokens);
        sum.write += Number(breakdown.cacheCreationTokens);
        models.set(name, sum);
      }
    }
    expect(report.cost.by_model.map((row) => row.model).sort()).toEqual([...models.keys()].sort());
    for (const row of report.cost.by_model) {
      const want = models.get(row.model ?? "") as Sums;
      expect(row.usd).toBeCloseTo(want.cost, 9);
      expect([
        row.input_tokens,
        row.output_tokens,
        row.cache_read_tokens,
        row.cache_write_tokens,
      ]).toEqual([want.input, want.output, want.read, want.write]);
    }
    expect(report.totals.usd).toBeCloseTo(expected.totals.totalCost, 9);
    expect(report.totals.tokens).toBe(expected.totals.totalTokens);
    expect(report.cost.by_agent.map((row) => row.vendor).sort()).toEqual(["claude_code", "codex"]);
    expect(report.credit).toBe(CCUSAGE_CREDIT);
    for (const readme of [
      join(fixtures, "..", "README.md"),
      join(fixtures, "..", "apps", "cli", "README.md"),
    ]) {
      const text = readFileSync(readme, "utf8");
      expect(text).toContain("dev scan");
      expect(text).toContain("[ccusage](https://github.com/ccusage/ccusage)");
    }
  });

  it("says the git numbers need a repo, credits ccusage and ends with the next step", async () => {
    const { deps } = workspace("scan-text");
    const result = await run(["scan", "--since", "2026-10-01"], {
      env: envFor(FIXTURE_LOGS),
      ...deps,
    });
    const lines = result.out.split("\n");
    expect(lines[0]).toBe(
      "selfhost scan: 2026-10-01 to 2026-10-31, 6 sessions from Claude Code and Codex",
    );
    expect(lines[2]).toMatch(/^Git: .* need a git repo\. Run selfhost scan --repo <dir>\.$/);
    expect(result.out).toContain("Cost by agent and model: $");
    expect(lines.at(-2)).toBe(CCUSAGE_CREDIT);
    expect(lines.at(-1)).toBe(NEXT_STEP);
  });

  it("leads with the three git-joined numbers when attribution is provided", async () => {
    const logs = leakyLogs();
    const { dir, deps } = workspace("scan-git", true);
    const idle = uuid(2);
    const collectAttribution = vi.fn(async (_repo: string, _sessions: SessionHint[]) =>
      attributionFor([idle]),
    );
    const result = await run(["scan", "--since", "2026-10-01"], {
      env: envFor(logs),
      ...deps,
      collectAttribution,
    });
    expect(collectAttribution).toHaveBeenCalledOnce();
    const [repo, sessions] = collectAttribution.mock.calls[0] ?? [];
    expect(repo).toBe(dir.root);
    expect(sessions?.map((hint) => hint.sessionId).sort()).toEqual(
      leakySessions(LEAK_DAY)
        .map((spec) => spec.id)
        .sort(),
    );

    const json = await scanJson(logs, [], { collectAttribution, cwd: dir.root });
    const events = await readLocalEvents({ since: new Date("2026-10-01"), ...logs });
    const idleUsd = summarizeSessions(events).find((s) => s.sessionId === idle)?.usd ?? -1;
    expect(idleUsd).toBeGreaterThan(0);
    expect(json.git).toMatchObject({
      status: "joined",
      repo: "acme/api",
      unreviewed_merges: { count: 1, merged: 2 },
      no_commit_spend: { sessions: 1 },
    });
    expect(json.git.no_commit_spend?.usd).toBeCloseTo(idleUsd, 9);

    const lines = result.out.split("\n");
    expect(lines.slice(2, 6)).toEqual([
      "Git: acme/api",
      "  Commits by agent                  Claude Code 50.0% (2), Codex 25.0% (1), unattributed 25.0% (1)",
      "  Agent PRs merged with no review   1 of 2",
      `  Spend on sessions with no commit  ${usd(idleUsd)}, ${percent(json.git.no_commit_spend?.share ?? 0)} of spend, 1 session`,
    ]);
    expect(lines.findIndex((line) => line.startsWith("Cost by agent"))).toBeGreaterThan(5);
  });

  it("adds the cost per merged agent PR to the text, JSON, HTML and SVG", async () => {
    const logs = leakyLogs();
    const { dir, deps } = workspace("scan-roi", true);
    const [joined, other] = [uuid(1), uuid(2)];
    // joined made the commit on the merged PR; other ran in the repo with no PR: shared.
    const collectAttribution = async () => {
      const base = attributionFor([other]);
      return {
        ...base,
        commits: [{ sha: "e5f6a7b", sessionId: joined, additions: 5, deletions: 0 }],
        pulls: [
          {
            ...(base.pulls[0] as (typeof base.pulls)[number]),
            state: "merged" as const,
            mergedAt: "2026-10-25T10:00:00Z",
            commits: ["e5f6a7b"],
          },
        ],
        sessions: [joined, other],
      };
    };
    const all = { env: envFor(logs), ...deps, collectAttribution };
    const json = await run(
      ["scan", "--json", "--since", "2026-10-01", "--report", "r.html", "--share", "c.svg"],
      all,
    );
    const report = JSON.parse(json.out) as ScanReport;
    const events = await readLocalEvents({ since: new Date("2026-10-01"), ...logs });
    const spend = (id: string) => summarizeSessions(events).find((s) => s.sessionId === id)?.usd;
    const [a = -1, b = -1] = [spend(joined), spend(other)];
    expect(report.roi).toMatchObject({ merged_prs: 1, human_prs: 0, closed_prs: 0 });
    expect(report.roi?.attributed_usd).toBeCloseTo(a, 6);
    expect(report.roi?.unattributed_usd).toBeCloseTo(b, 6);
    expect(report.roi?.shared_usd).toBeCloseTo(b, 6);
    expect(report.roi?.cost_per_merged_pr).toBeCloseTo(a + b, 6);
    expect(report.roi?.by_agent.map((row) => [row.agent, row.merged_prs])).toEqual([
      ["claude_code", 1],
    ]);

    const value = usd(report.roi?.cost_per_merged_pr ?? -1);
    const text = await run(["scan", "--since", "2026-10-01"], all);
    expect(text.out).toContain(`Cost per merged agent PR          ${value} per merged agent PR`);
    expect(readFileSync(dir.path("r.html"), "utf8")).toContain(value);
    expect(readFileSync(dir.path("c.svg"), "utf8")).toContain(
      `Cost per merged agent PR: ${value} per merged agent PR`,
    );
  });

  it("rejects a --repo that is not a folder", async () => {
    const { deps } = workspace("scan-repo");
    const result = await run(["scan", "--json", "--repo", "missing"], {
      env: envFor(FIXTURE_LOGS),
      ...deps,
    });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({ schema: "selfhost.error/v1" });
  });
});

describe("leak findings", () => {
  it("finds each leak and explains the five most expensive sessions", async () => {
    const report = await scanJson(leakyLogs());
    const found = (kind: string, title?: string) =>
      report.leaks
        .filter((leak) => leak.kind === kind && (title === undefined || leak.title === title))
        .flatMap((leak) => leak.sessions.map((session) => session.session_id));
    expect(found("status_loop", "Status polling loops")).toEqual([uuid(2)]);
    expect(found("status_loop", "Status-line and background loops")).toEqual([uuid(6, 7)]);
    expect(found("cache_miss")).toEqual([uuid(3)]);
    expect(found("retry_loop")).toEqual([uuid(4)]);
    expect(found("oversized_context")).toEqual([uuid(5)]);
    expect(report.leaks.flatMap((leak) => leak.sessions.map((s) => s.session_id))).not.toContain(
      uuid(1),
    );
    expect(report.waste.map((flag) => flag.request_type)).toContain("background");
    expect(report.totals.leak_usd).toBeGreaterThan(0);
    expect(report.totals.leak_usd).toBeLessThanOrEqual(report.totals.usd);

    expect(report.top_sessions).toHaveLength(5);
    const spend = report.top_sessions.map((session) => session.usd);
    expect(spend).toEqual([...spend].sort((a, b) => b - a));
    for (const session of report.top_sessions) expect(session.reason).not.toBe("");
    const reason = (id: string) => report.top_sessions.find((s) => s.session_id === id)?.reason;
    expect(reason(uuid(5))).toMatch(/requests over 150k tokens of context/);
    expect(reason(uuid(3))).toMatch(/cache misses, \d+\.\d% from cache/);
  });

  it("stays quiet just under each threshold", async () => {
    const logs = writeSessions(tempDir("scan-near").root, [
      {
        vendor: "claude_code",
        id: uuid(11),
        start: LEAK_DAY,
        requests: 40,
        repeat: LEAK_RULES.repeatedCalls - 1,
        retries: [20],
      },
      {
        vendor: "claude_code",
        id: uuid(12),
        start: LEAK_DAY,
        requests: 8,
        input: 30_000,
        cacheRead: 31_000,
      },
      {
        vendor: "claude_code",
        id: uuid(13),
        start: LEAK_DAY,
        requests: LEAK_RULES.contextRequests,
        cacheRead: 180_000,
      },
    ]);
    const report = await scanJson(logs);
    expect(report.leaks).toEqual([]);
    expect(report.totals.leak_usd).toBe(0);
  });

  it("is pure: the same input gives the same report", async () => {
    const events = await readLocalEvents({ since: new Date("2026-10-01"), ...FIXTURE_LOGS });
    const input = { events, waste: [], from: new Date("2026-10-01"), to: NOW };
    expect(buildScanReport(input)).toEqual(buildScanReport(structuredClone(input)));
    expect(buildScanReport(input).git.status).toBe("needs_repo");
  });
});

describe("outputs", () => {
  it("--report, --share and --json carry the same totals", async () => {
    const logs = leakyLogs();
    const { dir, deps } = workspace("scan-outputs", true);
    const collectAttribution = async () => attributionFor([uuid(2), uuid(6, 7)]);
    const all = { env: envFor(logs), ...deps, collectAttribution };
    const json = await run(
      ["scan", "--json", "--since", "2026-10-01", "--report", "report.html", "--share", "card.svg"],
      all,
    );
    const text = await run(["scan", "--since", "2026-10-01"], all);
    const report = JSON.parse(json.out) as ScanReport;
    const html = readFileSync(dir.path("report.html"), "utf8");
    const svg = readFileSync(dir.path("card.svg"), "utf8");

    const lead = report.git.commit_share?.[0];
    const totals = [
      usd(report.totals.usd),
      usd(report.totals.leak_usd),
      `${report.git.unreviewed_merges?.count} of ${report.git.unreviewed_merges?.merged}`,
      usd(report.git.no_commit_spend?.usd ?? -1),
      percent(lead?.share ?? -1),
    ];
    expect(report.totals.leak_usd).toBeGreaterThan(0);
    for (const value of totals) {
      expect(html).toContain(value);
      expect(svg).toContain(value);
    }
    expect(text.out).toContain(`Cost by agent and model: ${usd(report.totals.usd)}`);
    expect(text.out).toContain(`Leaks: ${usd(report.totals.leak_usd)} of spend`);
    expect(text.out).toContain(totals[2]);
    expect(text.out).toContain(totals[3]);

    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1"');
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).not.toMatch(/<(script|link|img)\b/);
    expect(html).toContain(CCUSAGE_CREDIT);
    expect(svg).toContain(`${lead?.agent} ${percent(lead?.share ?? -1)}`);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(svg).not.toMatch(/<(script|image)\b/);
  });

  it("never shows the marker strings planted in prompts and code", async () => {
    const manifest = JSON.parse(
      readFileSync(join(fixtures, "markers", "manifest.json"), "utf8"),
    ) as { markers: { value: string }[]; files: { path: string }[] };
    const markers = manifest.markers.map((marker) => marker.value);
    const raw = manifest.files
      .map((file) => readFileSync(join(fixtures, "markers", file.path), "utf8"))
      .join("\n");
    for (const marker of markers) expect(raw).toContain(marker);
    // The scan reads the code marker (a command's first line), so not printing it is a choice.
    const events = await readLocalEvents({ since: new Date("2026-10-01"), ...MARKER_LOGS });
    expect(JSON.stringify(events)).toContain("MARKER-CODE-z9h4");

    const { dir, deps } = workspace("scan-markers", true);
    const all = {
      env: envFor(MARKER_LOGS),
      ...deps,
      collectAttribution: async () => attributionFor(["7d3e0c55-6a1f-4c2b-9e8d-1f2a3b4c5d6e"]),
    };
    const json = await run(
      ["scan", "--json", "--since", "2026-10-01", "--report", "r.html", "--share", "c.svg"],
      all,
    );
    const text = await run(["scan", "--since", "2026-10-01"], all);
    const outputs = {
      json: json.out,
      text: text.out,
      html: readFileSync(dir.path("r.html"), "utf8"),
      svg: readFileSync(dir.path("c.svg"), "utf8"),
    };
    expect(JSON.parse(outputs.json).totals.sessions).toBe(2);
    for (const [name, output] of Object.entries(outputs)) {
      for (const marker of markers) {
        expect(output.includes(marker), `${marker} in ${name}`).toBe(false);
      }
      expect(output).not.toMatch(/MARKER-/);
    }
  });

  it("scans 30 days of about 50 sessions in under 10 seconds", async () => {
    const logs = writeSessions(tempDir("scan-month").root, monthOfSessions(NOW));
    const { dir } = workspace("scan-month-out");
    const started = performance.now();
    const report = await runScan(
      { since: "30d", json: true, report: "r.html", share: "c.svg" },
      { env: envFor(logs), cwd: dir.root, home: dir.path("home"), write: () => {}, now: NOW },
    );
    const elapsed = performance.now() - started;
    expect(report.totals.sessions).toBe(50);
    expect(report.totals.requests).toBeGreaterThan(5000);
    expect(elapsed).toBeLessThan(10_000);
  });
});

describe("anonymous agent count", () => {
  const configOf = (path: string) => JSON.parse(readFileSync(path, "utf8"));

  it("is not asked without a terminal, and nothing is remembered or sent", async () => {
    const { dir, deps } = workspace("scan-tty");
    const sendTelemetry = vi.fn(async () => {});
    await run(["scan", "--since", "2026-10-01"], {
      env: envFor(FIXTURE_LOGS, { SELFHOST_TELEMETRY_URL: "http://127.0.0.1:9/count" }),
      ...deps,
      sendTelemetry,
    });
    expect(() => readFileSync(dir.path("home", "config.json"))).toThrow();
    expect(sendTelemetry).not.toHaveBeenCalled();
  });

  it("is asked once, keeps the answer and sends nothing when declined", async () => {
    const { deps } = workspace("scan-no");
    const ask = vi.fn(async () => false);
    const sendTelemetry = vi.fn(async () => {});
    const opts = {
      env: envFor(FIXTURE_LOGS, { SELFHOST_TELEMETRY_URL: "http://127.0.0.1:9/count" }),
      ...deps,
      ask,
      sendTelemetry,
    };
    await run(["scan", "--since", "2026-10-01"], opts);
    await run(["scan", "--since", "2026-10-01"], opts);
    expect(ask).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledWith(AGENT_COUNT_QUESTION);
    expect(configOf(deps.configPath)).toEqual({ telemetry: { agent_count: false } });
    expect(sendTelemetry).not.toHaveBeenCalled();
  });

  it("sends only the agent count when accepted and an endpoint is set", async () => {
    const { deps } = workspace("scan-yes");
    mkdirSync(join(deps.configPath, ".."), { recursive: true });
    writeFileSync(deps.configPath, '{ "data_dir": "/home/dev/.selfhost/data" }\n');
    const sendTelemetry = vi.fn(async () => {});
    await run(["scan", "--since", "2026-10-01"], {
      env: envFor(FIXTURE_LOGS, { SELFHOST_TELEMETRY_URL: "http://127.0.0.1:9/count" }),
      ...deps,
      ask: async () => true,
      sendTelemetry,
    });
    expect(sendTelemetry).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:9/count", {
      schema: "selfhost.agent_count/v1",
      agents: 2,
    });
    expect(configOf(deps.configPath)).toEqual({
      data_dir: "/home/dev/.selfhost/data",
      telemetry: { agent_count: true },
    });
  });

  it("sends nothing when accepted with no endpoint configured, and never asks in --json mode", async () => {
    const { deps } = workspace("scan-noendpoint");
    const sendTelemetry = vi.fn(async () => {});
    const ask = vi.fn(async () => true);
    await run(["scan", "--json", "--since", "2026-10-01"], {
      env: envFor(FIXTURE_LOGS),
      ...deps,
      ask,
      sendTelemetry,
    });
    expect(ask).not.toHaveBeenCalled();
    await run(["scan", "--since", "2026-10-01"], {
      env: envFor(FIXTURE_LOGS),
      ...deps,
      ask,
      sendTelemetry,
    });
    expect(ask).toHaveBeenCalledOnce();
    expect(sendTelemetry).not.toHaveBeenCalled();
  });
});

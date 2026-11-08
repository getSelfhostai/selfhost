import { writeFileSync } from "node:fs";
import { type Ledger, openLedger } from "@selfhost/ledger";
import {
  EVENT_SCHEMA,
  type LedgerEvent,
  ROI_DEFINITION,
  type RoiBaseline,
  type RoiResponse,
} from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProgram } from "../src/program.js";
import { runRoi } from "../src/roi.js";
import { run, tempDir } from "./run.js";

/**
 * A laptop ledger. First week (11-02 to 11-09): b1 spends $3, joined to pull/9 (merged,
 * claude_code). => $3 per merged agent PR. Range (11-09 to 11-16): w1 spends $6 joined to
 * pull/1 (merged, claude_code claude-opus-4), w2 spends $2 in the repo joined to nothing,
 * pull/2 merges with no agent. => $8 per merged agent PR, 1 human PR.
 */

const NOW = new Date("2026-11-16T00:00:00.000Z");
const PULL = "https://github.com/acme/site/pull";

let n = 0;
const event = (fields: Partial<LedgerEvent>): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: EVENT_SCHEMA,
  ts: "2026-11-10T09:00:00.000Z",
  source: "local_log",
  kind: "session.started",
  actor: { kind: "person", id: "dev@example.com" },
  repo: "acme/site",
  ...fields,
});

const spend = (session: string, usd: number, ts: string, vendor: "claude_code" | "codex") =>
  event({
    kind: "cost.recorded",
    ts,
    session_id: session,
    agent: { vendor },
    cost: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      usd,
      estimated: true,
    },
  });

const commit = (session: string, pr: string) =>
  event({
    kind: "commit.created",
    source: "cli",
    session_id: session,
    links: { commit_sha: (++n).toString(16).padStart(40, "c"), pr_url: pr },
  });

const merged = (url: string, ts: string, model?: string) =>
  event({
    kind: "pr.merged",
    source: "github",
    ts,
    links: { pr_url: url },
    ...(model ? { agent: { vendor: "claude_code" as const }, model } : {}),
  });

const EVENTS = [
  spend("b1", 3, "2026-11-02T10:00:00.000Z", "claude_code"),
  commit("b1", `${PULL}/9`),
  merged(`${PULL}/9`, "2026-11-03T10:00:00.000Z", "claude-opus-4"),
  spend("w1", 6, "2026-11-10T10:00:00.000Z", "claude_code"),
  commit("w1", `${PULL}/1`),
  merged(`${PULL}/1`, "2026-11-11T10:00:00.000Z", "claude-opus-4"),
  spend("w2", 2, "2026-11-12T10:00:00.000Z", "codex"),
  merged(`${PULL}/2`, "2026-11-13T10:00:00.000Z"),
];

describe("selfhost roi", () => {
  let ledger: Ledger;

  beforeAll(async () => {
    ledger = await openLedger({ dataDir: "memory://" });
    await ledger.append(EVENTS);
  });
  afterAll(() => ledger.close());

  const io = (cwd: string, out: string[]) => ({
    env: {},
    cwd,
    write: (line: string) => out.push(line),
    now: NOW,
    configPath: tempDir("roi-config").path("config.json"),
  });

  it("is registered with its options", () => {
    const roi = createProgram().commands.find((command) => command.name() === "roi");
    expect(roi?.options.map((option) => option.long)).toEqual([
      "--since",
      "--baseline",
      "--json",
      "--config",
      "--database",
      "--data-dir",
    ]);
  });

  it("reads this machine's ledger with the first week as the baseline", async () => {
    const out: string[] = [];
    const report = await runRoi({ since: "7d" }, io(tempDir("roi").root, out), ledger);
    expect(report).toMatchObject({
      team: null,
      from: "2026-11-09T00:00:00.000Z",
      merged_prs: 1,
      cost_usd: 8,
      cost_per_merged_pr: 8,
      human_prs: 1,
      attributed_usd: 6,
      shared_usd: 2,
      baseline: {
        from: "2026-11-02T00:00:00.000Z",
        to: "2026-11-09T00:00:00.000Z",
        cost_per_merged_pr: 3,
        period: "first_week",
      },
      by_agent: [{ agent: "claude_code", model: "claude-opus-4", merged_prs: 1, cost_usd: 8 }],
    });
    expect(out.slice(0, 4)).toEqual([
      "Cost per merged agent PR, 2026-11-09 to 2026-11-16, this machine",
      "  This range  $8.00 per merged agent PR ($8.00 over 1)",
      "  Baseline    $3.00 per merged agent PR ($3.00 over 1), 2026-11-02 to 2026-11-09 (first week of data, frozen 2026-11-16)",
      "  Change      +166.7%",
    ]);
    expect(out).toContain(
      "Joined sessions $6.00, shared $2.00 (no pull request $2.00, closed unmerged $0.00), unallocated $0.00. 1 human PR merged, 0 agent PRs closed unmerged.",
    );
  });

  it("prints the baseline alone with --baseline, and takes the period from [roi]", async () => {
    const dir = tempDir("roi-config-period");
    writeFileSync(
      dir.path("selfhost.toml"),
      'version = 1\n\n[roi]\nbaseline_from = "2026-11-09"\nbaseline_to = "2026-11-16"\n',
    );
    const out: string[] = [];
    await runRoi({ baseline: true, json: true }, io(dir.root, out), ledger);
    const baseline = JSON.parse(out.join("\n")) as RoiBaseline;
    expect(baseline).toEqual({
      from: "2026-11-09T00:00:00.000Z",
      to: "2026-11-16T00:00:00.000Z",
      merged_prs: 1,
      cost_usd: 8,
      cost_per_merged_pr: 8,
      human_prs: 1,
      period: "configured",
      definition: ROI_DEFINITION,
      computed_at: NOW.toISOString(),
    });
  });

  it("asks the team server in team mode", async () => {
    const dir = tempDir("roi-team");
    const configPath = dir.path("config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        server: "https://selfhost.test",
        token: "person-token",
        person: "dev@example.com",
        team: "web",
      }),
    );
    const answer: RoiResponse = {
      schema: "selfhost.roi/v1",
      definition: ROI_DEFINITION,
      team: "web",
      from: "2026-11-09T00:00:00.000Z",
      to: NOW.toISOString(),
      merged_prs: 0,
      cost_usd: 0,
      cost_per_merged_pr: null,
      human_prs: 0,
      closed_prs: 0,
      attributed_usd: 0,
      shared_usd: 0,
      unattributed_usd: 4,
      closed_usd: 0,
      unallocated_usd: 4,
      baseline: null,
      by_agent: [],
    };
    const urls: string[] = [];
    const result = await run(["roi"], {
      configPath,
      cwd: dir.root,
      now: NOW,
      fetch: async (url) => {
        urls.push(url);
        return new Response(JSON.stringify(answer), { status: 200 });
      },
    });
    expect(result.err).toBe("");
    expect(urls).toEqual([
      "https://selfhost.test/v1/teams/web/roi?from=2026-11-09T00%3A00%3A00.000Z&to=2026-11-16T00%3A00%3A00.000Z",
    ]);
    expect(result.out.split("\n").slice(0, 3)).toEqual([
      "Cost per merged agent PR, 2026-11-09 to 2026-11-16, team web",
      "  This range  no value: no agent PR merged",
      "  Baseline    not yet: its period has not ended, or there is no data",
    ]);
  });
});

import { randomBytes } from "node:crypto";
import { databaseOf, type Ledger, openLedger } from "@selfhost/ledger";
import {
  createValidator,
  EVENT_SCHEMA,
  type LedgerEvent,
  ROI_DEFINITION,
  RoiResponseSchema,
} from "@selfhost/schema";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  costPerMergedPr,
  readRoiInput,
  roiBaseline,
  roiInputFromEvents,
  roiReport,
} from "../src/index.js";

/**
 * A seeded ledger with teams Web (repos acme/site and acme/docs) and Data (acme/etl). Every
 * number below is worked out by hand from the events, as the comments next to them show.
 *
 * Baseline week, 2026-11-02 to 11-09 (Web's first event is on 11-02):
 * - b2 (codex) spends $2 in acme/site, joined to nothing: shared.
 * - b1 (claude_code) spends $4 by otel and $3.90 by local_log, joined to site/10 (merged 11-04,
 *   agent claude_code, claude-opus-4): otel counts, $4.
 * - site/11 merges with no agent and no session: a human PR.
 * => 1 merged agent PR, cost 4 + 2 = $6, human 1.
 *
 * Range, 2026-11-09 to 11-16:
 * - s1 (claude_code, opus) spends $2 on 11-08 and $10 in the range (otel; local_log says $9),
 *   joined to site/1 and site/2: $12 in all, $6 to each.
 * - s2 (claude_code, sonnet) spends $8, joined to site/2: site/2 has $14, mostly sonnet.
 * - site/1 merges 11-12, attributed to claude_code claude-opus-4; site/2 merges 11-13 with no
 *   agent on the pull request.
 * - s3 (codex) spends $4, joined to site/3, closed unmerged 11-14: closed, shared in acme/site.
 * - s4 (codex) spends $1.50 in acme/site, joined to nothing: shared in acme/site.
 * - $1 of claude_code gateway spend with no session and no repo, written by Web: shared by all.
 * - s7 (codex) spends $2.50 in acme/docs, joined to nothing: no merged PR there, unallocated.
 * - s6 (codex) spends $5, joined to site/4, still open: counted when site/4 merges or closes.
 * - $7 of gateway spend that names no agent: not agent spend.
 * - site/5 merges with no agent and no session: human.
 * - Data: d1 (codex) spends $8 joined to etl/1 (merged 11-11, codex), and $2 unjoined in etl.
 * - s8 spends $100 on 11-17, after the range.
 *
 * Web: attributed 6 + 14 = 20; acme/site pool 1.5 + 4 = 5.5 over 2 PRs = 2.75 each; no-repo
 * pool $1 over 2 = 0.5 each; shared 6.5; cost 26.5; per PR 13.25. site/1 = 6 + 3.25 = 9.25
 * (claude_code, claude-opus-4), site/2 = 14 + 3.25 = 17.25 (claude_code, claude-sonnet-4).
 */

const DATABASE_URL = process.env.DATABASE_URL;

const BACKENDS = [
  {
    name: "pglite",
    skip: false,
    async open() {
      const ledger = await openLedger({ dataDir: "memory://" });
      return { ledger, close: () => ledger.close() };
    },
  },
  {
    name: "postgres",
    skip: !DATABASE_URL,
    async open() {
      const schema = `selfhost_test_${randomBytes(6).toString("hex")}`;
      const admin = postgres(DATABASE_URL ?? "", { onnotice: () => {} });
      await admin.unsafe(`CREATE SCHEMA ${schema}`);
      const scoped = new URL(DATABASE_URL ?? "");
      scoped.searchParams.set("search_path", schema);
      const ledger = await openLedger({ url: scoped.toString() });
      return {
        ledger,
        async close() {
          await ledger.close();
          await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
          await admin.end();
        },
      };
    },
  },
];

const FROM = new Date("2026-11-09T00:00:00.000Z");
const TO = new Date("2026-11-16T00:00:00.000Z");
const NOW = new Date("2026-11-16T12:00:00.000Z");
const SITE = "https://github.com/acme/site/pull";
const ETL = "https://github.com/acme/etl/pull";

let n = 0;
const event = (fields: Partial<LedgerEvent>): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: EVENT_SCHEMA,
  ts: "2026-11-10T09:00:00.000Z",
  source: "otel",
  kind: "session.started",
  actor: { kind: "person", id: "wendy@example.com" },
  ...fields,
});

type Vendor = "claude_code" | "codex";

const spend = (
  ts: string,
  usd: number,
  fields: { session?: string; vendor?: Vendor | null; model?: string; repo?: string } & Partial<
    Pick<LedgerEvent, "source">
  > = {},
) =>
  event({
    ts,
    kind: "cost.recorded",
    ...(fields.source ? { source: fields.source } : {}),
    ...(fields.vendor === null ? {} : { agent: { vendor: fields.vendor ?? "claude_code" } }),
    ...(fields.model ? { model: fields.model } : {}),
    ...(fields.session ? { session_id: fields.session } : {}),
    ...(fields.repo ? { repo: fields.repo } : {}),
    cost: {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      usd,
      estimated: true,
    },
  });

/** A commit a session made on a pull request: the join. */
const commit = (session: string, pr: string, repo: string, vendor: Vendor = "claude_code") =>
  event({
    kind: "commit.created",
    source: "cli",
    session_id: session,
    repo,
    agent: { vendor },
    links: { commit_sha: (++n).toString(16).padStart(40, "a"), pr_url: pr },
  });

const pull = (
  kind: "pr.opened" | "pr.merged" | "pr.closed",
  url: string,
  ts: string,
  repo: string,
  agent?: { vendor: Vendor; model?: string },
) =>
  event({
    kind,
    source: "github",
    ts,
    repo,
    target: { type: "pr", value: url },
    links: { pr_url: url },
    ...(agent ? { agent: { vendor: agent.vendor } } : { data: { unattributed: true } }),
    ...(agent?.model ? { model: agent.model } : {}),
  });

const OPUS = "claude-opus-4";
const SONNET = "claude-sonnet-4";

const WEB: LedgerEvent[] = [
  // Baseline week.
  spend("2026-11-02T10:00:00.000Z", 2, { session: "b2", vendor: "codex", repo: "acme/site" }),
  spend("2026-11-03T10:00:00.000Z", 4, { session: "b1", model: OPUS, repo: "acme/site" }),
  spend("2026-11-03T10:00:00.000Z", 3.9, { session: "b1", model: OPUS, source: "local_log" }),
  commit("b1", `${SITE}/10`, "acme/site"),
  pull("pr.opened", `${SITE}/10`, "2026-11-03T12:00:00.000Z", "acme/site", {
    vendor: "claude_code",
    model: OPUS,
  }),
  pull("pr.merged", `${SITE}/10`, "2026-11-04T12:00:00.000Z", "acme/site", {
    vendor: "claude_code",
    model: OPUS,
  }),
  pull("pr.merged", `${SITE}/11`, "2026-11-06T12:00:00.000Z", "acme/site"),
  // The range.
  spend("2026-11-08T10:00:00.000Z", 2, { session: "s1", model: OPUS, repo: "acme/site" }),
  spend("2026-11-10T10:00:00.000Z", 10, { session: "s1", model: OPUS }),
  spend("2026-11-10T10:00:00.000Z", 9, { session: "s1", model: OPUS, source: "local_log" }),
  spend("2026-11-11T10:00:00.000Z", 8, { session: "s2", model: SONNET, repo: "acme/site" }),
  commit("s1", `${SITE}/1`, "acme/site"),
  commit("s1", `${SITE}/2`, "acme/site"),
  commit("s2", `${SITE}/2`, "acme/site"),
  pull("pr.opened", `${SITE}/1`, "2026-11-11T12:00:00.000Z", "acme/site", {
    vendor: "claude_code",
    model: OPUS,
  }),
  pull("pr.merged", `${SITE}/1`, "2026-11-12T12:00:00.000Z", "acme/site", {
    vendor: "claude_code",
    model: OPUS,
  }),
  pull("pr.opened", `${SITE}/2`, "2026-11-12T12:00:00.000Z", "acme/site"),
  pull("pr.merged", `${SITE}/2`, "2026-11-13T12:00:00.000Z", "acme/site"),
  // The same merge again, from the webhook: counted once.
  pull("pr.merged", `${SITE}/2`, "2026-11-13T12:00:00.000Z", "acme/site"),
  spend("2026-11-12T10:00:00.000Z", 4, { session: "s3", vendor: "codex", repo: "acme/site" }),
  commit("s3", `${SITE}/3`, "acme/site", "codex"),
  pull("pr.opened", `${SITE}/3`, "2026-11-12T12:00:00.000Z", "acme/site", { vendor: "codex" }),
  pull("pr.closed", `${SITE}/3`, "2026-11-14T12:00:00.000Z", "acme/site", { vendor: "codex" }),
  spend("2026-11-10T11:00:00.000Z", 1.5, { session: "s4", vendor: "codex", repo: "acme/site" }),
  spend("2026-11-11T11:00:00.000Z", 1, { source: "gateway" }),
  spend("2026-11-12T11:00:00.000Z", 2.5, { session: "s7", vendor: "codex", repo: "acme/docs" }),
  spend("2026-11-12T11:00:00.000Z", 5, { session: "s6", vendor: "codex", repo: "acme/site" }),
  commit("s6", `${SITE}/4`, "acme/site", "codex"),
  pull("pr.opened", `${SITE}/4`, "2026-11-13T12:00:00.000Z", "acme/site", { vendor: "codex" }),
  spend("2026-11-13T11:00:00.000Z", 7, { source: "gateway", vendor: null }),
  pull("pr.merged", `${SITE}/5`, "2026-11-14T12:00:00.000Z", "acme/site"),
  // After the range.
  spend("2026-11-17T10:00:00.000Z", 100, { session: "s8", repo: "acme/site" }),
];

const DATA: LedgerEvent[] = [
  spend("2026-11-10T10:00:00.000Z", 8, { session: "d1", vendor: "codex", repo: "acme/etl" }),
  commit("d1", `${ETL}/1`, "acme/etl", "codex"),
  pull("pr.merged", `${ETL}/1`, "2026-11-11T12:00:00.000Z", "acme/etl", { vendor: "codex" }),
  spend("2026-11-10T12:00:00.000Z", 2, { session: "d2", vendor: "codex", repo: "acme/etl" }),
];

const WEB_REPORT = {
  schema: "selfhost.roi/v1",
  definition: ROI_DEFINITION,
  team: "web",
  from: FROM.toISOString(),
  to: TO.toISOString(),
  merged_prs: 2,
  cost_usd: 26.5,
  cost_per_merged_pr: 13.25,
  human_prs: 1,
  closed_prs: 1,
  attributed_usd: 20,
  shared_usd: 6.5,
  unattributed_usd: 5,
  closed_usd: 4,
  unallocated_usd: 2.5,
  by_agent: [
    {
      agent: "claude_code",
      model: SONNET,
      merged_prs: 1,
      cost_usd: 17.25,
      cost_per_merged_pr: 17.25,
    },
    { agent: "claude_code", model: OPUS, merged_prs: 1, cost_usd: 9.25, cost_per_merged_pr: 9.25 },
  ],
};

const validResponse = createValidator(RoiResponseSchema);

describe("cost per merged PR, in memory", () => {
  it("matches the hand-computed numbers from events alone", () => {
    const tagged = WEB.map((e) => ({ ...e, team: "web" }));
    const report = costPerMergedPr(roiInputFromEvents(tagged, { team: "web", from: FROM, to: TO }));
    expect(report).toEqual(WEB_REPORT);
  });

  it("shows no value for a week with no merged agent PR", () => {
    const report = costPerMergedPr({
      team: null,
      from: TO,
      to: new Date("2026-11-23T00:00:00.000Z"),
      costs: [{ session: "s8", agent: "claude_code", source: "otel", usd: 100, in_window: true }],
      pulls: [],
      links: [],
    });
    expect(report).toMatchObject({
      merged_prs: 0,
      cost_usd: 0,
      cost_per_merged_pr: null,
      unattributed_usd: 100,
      unallocated_usd: 100,
      by_agent: [],
    });
  });
});

for (const backend of BACKENDS) {
  describe.skipIf(backend.skip)(`cost per merged PR on ${backend.name}`, () => {
    let ledger: Ledger;
    let close: () => Promise<void>;
    const db = () => databaseOf(ledger);

    beforeAll(async () => {
      ({ ledger, close } = await backend.open());
      await ledger.teams.createTeam({ id: "web", name: "Web" });
      await ledger.teams.createTeam({ id: "data", name: "Data" });
      for (const [team, repo] of [
        ["web", "acme/site"],
        ["web", "acme/docs"],
        ["data", "acme/etl"],
      ] as const) {
        await ledger.orgs.addRepo(team, { repo, remote: `github.com/${repo}` });
      }
      await ledger.append(WEB, { team: "web" });
      await ledger.append(DATA, { team: "data" });
    });
    afterAll(() => close());

    it("reports a team's range with every number as computed by hand", async () => {
      const report = await roiReport(db(), { team: "web", from: FROM, to: TO, now: NOW });
      const { baseline, ...rest } = report;
      expect(rest).toEqual(WEB_REPORT);
      expect(validResponse.validate(report).ok).toBe(true);
      // The first week of Web's data: one agent PR at $4 own + $2 shared, and one human PR.
      expect(baseline).toEqual({
        from: "2026-11-02T00:00:00.000Z",
        to: "2026-11-09T00:00:00.000Z",
        merged_prs: 1,
        cost_usd: 6,
        cost_per_merged_pr: 6,
        human_prs: 1,
        period: "first_week",
        definition: ROI_DEFINITION,
        computed_at: NOW.toISOString(),
      });
    });

    it("keeps each team to its own pull requests and spend", async () => {
      const report = await roiReport(db(), { team: "data", from: FROM, to: TO, now: NOW });
      expect(report).toMatchObject({
        merged_prs: 1,
        attributed_usd: 8,
        unattributed_usd: 2,
        shared_usd: 2,
        cost_usd: 10,
        cost_per_merged_pr: 10,
        human_prs: 0,
        by_agent: [
          { agent: "codex", model: "unknown", merged_prs: 1, cost_usd: 10, cost_per_merged_pr: 10 },
        ],
      });
      // Data's first event is on 11-10: its first week has not ended.
      expect(report.baseline).toBeNull();
    });

    it("reads the whole ledger with no team, as a laptop does", async () => {
      // site/1 and site/2 as for Web, plus etl/1: $28 own. Shared: acme/site 5.5 over two,
      // acme/etl 2 to etl/1, the no-repo dollar over three. acme/docs 2.5 unallocated.
      const report = costPerMergedPr(await readRoiInput(db(), { team: null, from: FROM, to: TO }));
      expect(report).toMatchObject({
        team: null,
        merged_prs: 3,
        attributed_usd: 28,
        unattributed_usd: 7,
        closed_usd: 4,
        shared_usd: 8.5,
        unallocated_usd: 2.5,
        cost_usd: 36.5,
        cost_per_merged_pr: 12.166667,
        human_prs: 1,
      });
    });

    it("shows no value for an empty week", async () => {
      const week = { from: TO, to: new Date("2026-11-23T00:00:00.000Z") };
      const report = costPerMergedPr(await readRoiInput(db(), { team: "web", ...week }));
      expect(report).toMatchObject({
        merged_prs: 0,
        cost_usd: 0,
        cost_per_merged_pr: null,
        unattributed_usd: 100,
        unallocated_usd: 100,
      });
    });

    it("never changes a frozen baseline when older or late data arrives", async () => {
      const first = await roiBaseline(db(), { team: "web", now: NOW });
      await ledger.append(
        [
          // Imported late: more spend in the baseline week, and data before it.
          spend("2026-11-05T10:00:00.000Z", 50, { session: "late", repo: "acme/site" }),
          spend("2026-10-20T10:00:00.000Z", 1, { session: "older", repo: "acme/site" }),
        ],
        { team: "web" },
      );
      const live = costPerMergedPr(
        await readRoiInput(db(), {
          team: "web",
          from: new Date("2026-11-02T00:00:00.000Z"),
          to: new Date("2026-11-09T00:00:00.000Z"),
        }),
      );
      expect(live.cost_usd).toBe(56);
      const later = await roiBaseline(db(), { team: "web", now: new Date("2026-12-01") });
      expect(later).toEqual(first);
      expect(later?.cost_usd).toBe(6);
      await expect(
        db().query("UPDATE roi_baselines SET definition = 'other' WHERE team = 'web'"),
      ).rejects.toThrow(/frozen/);
    });

    it("freezes a configured period separately, once it has ended", async () => {
      const period = { from: FROM, to: TO };
      expect(
        await roiBaseline(db(), { team: "web", now: new Date("2026-11-15"), period }),
      ).toBeNull();
      const baseline = await roiBaseline(db(), { team: "web", now: NOW, period });
      expect(baseline).toMatchObject({
        from: FROM.toISOString(),
        to: TO.toISOString(),
        merged_prs: 2,
        cost_usd: 26.5,
        cost_per_merged_pr: 13.25,
        human_prs: 1,
        period: "configured",
      });
    });
  });
}

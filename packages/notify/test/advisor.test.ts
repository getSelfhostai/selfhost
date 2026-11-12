import { databaseOf, type Ledger, openLedger } from "@selfhost/ledger";
import { EVENT_SCHEMA, type LedgerEvent, validateConfig } from "@selfhost/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AdvisorData,
  advisorLines,
  advisorMessage,
  advisorReport,
  isQuietWeek,
  readAdvisorData,
} from "../src/advisor.js";
import { advisorWindow } from "../src/cadence.js";
import { type Directory, NOTIFY_DEFAULTS, runNotify } from "../src/job.js";
import { notifyStore } from "../src/store.js";
import { FORBIDDEN, fakeDeliver, SECRET } from "./fixtures.js";

/** A fixed clock: Monday 2026-11-09 09:30 UTC. Every time below is relative to the week before. */
const NOW = new Date("2026-11-09T09:30:00.000Z");
const TO = new Date("2026-11-09T09:00:00.000Z");
const FROM = new Date(TO.getTime() - 7 * 86_400_000);
const IN_WEEK = "2026-11-05T12:00:00.000Z";

let n = 0;
const uuid = () => `01930c4e-2f1a-7b2c-8d3e-${(++n).toString(16).padStart(12, "0")}`;

const event = (fields: Partial<LedgerEvent> & Pick<LedgerEvent, "kind">): LedgerEvent => ({
  id: uuid(),
  schema: EVENT_SCHEMA,
  ts: IN_WEEK,
  source: "hook",
  actor: { kind: "person", id: "ana@example.com" },
  agent: { vendor: "claude_code" },
  ...fields,
});

const cost = (usd: number, fields: Partial<LedgerEvent> = {}) =>
  event({
    kind: "cost.recorded",
    source: "otel",
    model: "claude-sonnet-4-5",
    cost: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 3000,
      cache_write_tokens: 0,
      usd,
      estimated: false,
    },
    ...fields,
  });

const block = (rule: string, fields: Partial<LedgerEvent> = {}, mode = "enforce") =>
  event({
    kind: "policy.evaluated",
    decision: { verdict: "block", rule_id: rule, mode: mode as "enforce" },
    tool: { name: "Read", input_summary: `cat .env ${SECRET}` },
    ...fields,
  });

const pr = (kind: "pr.opened" | "pr.merged", number: number, fields: Partial<LedgerEvent> = {}) =>
  event({
    kind,
    source: "github",
    actor: { kind: "system", id: "github" },
    repo: "acme/web",
    links: { pr_url: `https://github.com/acme/web/pull/${number}` },
    ...fields,
  });

const human = ({ agent: _agent, ...rest }: LedgerEvent): LedgerEvent => rest;

/** A week of a two-person team: Ana ships and burns money, Bo keeps hitting the secrets rule. */
function week(): AdvisorData {
  const events: LedgerEvent[] = [
    event({ kind: "session.started", session_id: "s-ana", repo: "acme/web" }),
    event({
      kind: "session.started",
      session_id: "s-bo",
      repo: "acme/api",
      actor: { kind: "person", id: "bo@example.com" },
    }),
    // Ana: $60 this week on Claude Code at API rates, about $257 a month.
    cost(60, { session_id: "s-ana" }),
    // A vendor-reported day for Bo nobody else recorded counts; one for Ana's covered day does not.
    cost(4, {
      source: "vendor_api",
      actor: { kind: "person", id: "bo@example.com" },
      ts: "2026-11-04T00:00:00.000Z",
      data: { rollup: "day" },
    }),
    cost(9, { source: "vendor_api", ts: "2026-11-05T00:00:00.000Z", data: { rollup: "day" } }),
    pr("pr.opened", 1, { session_id: "s-ana" }),
    pr("pr.merged", 1, { session_id: "s-ana" }),
    pr("pr.opened", 2, { session_id: "s-ana" }),
    // A human pull request is not an agent's.
    human(pr("pr.merged", 9)),
    // Bo's agents hit the secrets guardrail 3 times; a recording-only rule fired 4 times.
    ...[1, 2, 3].map(() =>
      block("secret-files", {
        session_id: "s-bo",
        actor: { kind: "person", id: "bo@example.com" },
      }),
    ),
    ...[1, 2, 3, 4].map(() => block("no-force-push", { session_id: "s-ana" }, "observe")),
    event({
      kind: "pr.reverted",
      source: "server",
      actor: { kind: "system", id: "github" },
      session_id: "s-ana",
      repo: "acme/web",
      links: { pr_url: "https://github.com/acme/web/pull/1" },
    }),
    event({
      kind: "alert.raised",
      source: "server",
      actor: { kind: "system", id: "selfhost" },
      repo: "acme/web",
      data: {
        alert: "edit_overlap",
        file: "src/app.ts",
        runs: ["s-ana", "s-bo"],
        owners: ["ana@example.com", "bo@example.com"],
      },
    }),
  ];
  // Outside the week: nothing of it counts.
  events.push(cost(500, { session_id: "s-old", ts: "2026-10-20T10:00:00.000Z" }));
  const item = uuid();
  const signal = event({
    kind: "risk.learned",
    source: "server",
    actor: { kind: "system", id: "github" },
    agent: { vendor: "codex" },
    model: "gpt-5-codex",
    repo: "acme/web",
    ts: "2026-10-28T10:00:00.000Z",
    links: { item_id: item },
    data: {
      state: "proposed",
      module: "billing",
      pulls: 6,
      reverted: 2,
      reworked: 1,
      rate: 0.5,
      suggestion: 'Add "billing/**" to [review] high_risk_paths in selfhost.toml.',
    },
  });
  return {
    events: events.filter((e) => Date.parse(e.ts) >= FROM.getTime()),
    signals: [signal],
    items: [
      {
        id: item,
        kind: "context_promotion",
        state: "open",
        verdict: null,
        session_id: null,
        created_at: "2026-10-28T10:00:00.000Z",
      },
      {
        id: uuid(),
        kind: "exception",
        state: "answered",
        verdict: "approve",
        session_id: "s-bo",
        created_at: IN_WEEK,
      },
    ],
    grantsUsed: ["bo@example.com"],
  };
}

describe("advisorReport", () => {
  const report = advisorReport(week(), { teams: ["web"], from: FROM, to: TO });

  it("counts what shipped: agent pull requests by person and agent, each once", () => {
    expect(report.shipped).toEqual({
      opened: 2,
      merged: 1,
      by: [{ person: "ana@example.com", agent: "claude_code", opened: 2, merged: 1 }],
    });
  });

  it("counts blocks, recorded hits and exceptions, and who a rule stopped most", () => {
    expect(report.blocked).toMatchObject({ blocked: 3, asked: 0, would_block: 4, would_ask: 0 });
    expect(report.blocked.rules.map((r) => [r.rule_id, r.top_person, r.top_person_hits])).toEqual([
      ["no-force-push", null, 0],
      ["secret-files", "bo@example.com", 3],
    ]);
    expect(report.blocked.rules[1]?.run).toBe("s-bo");
    expect(report.blocked.exceptions).toEqual({ requested: 1, approved: 1, denied: 0, used: 1 });
  });

  it("counts spend as usage does: a vendor day only where nothing else reported it", () => {
    expect(report.spend.usd).toBe(64);
    expect(report.spend.vendor_usd).toBe(4);
    expect(report.spend.by.map((r) => [r.person, r.usd, r.vendor_usd])).toEqual([
      ["ana@example.com", 60, 0],
      ["bo@example.com", 4, 4],
    ]);
    expect(report.spend.cache_hit_rate).toBe(0.75);
    // Ana's ~$257 a month is cheaper on a seat; Bo's ~$17 is cheaper on an API key.
    const ana = report.spend.billing.find((row) => row.person === "ana@example.com");
    expect(ana).toMatchObject({ agent: "claude_code", verdict: "seat" });
    expect(report.spend.sandbox).toBeNull();
  });

  it("reports reverts, learned signals still waiting, and who worked where", () => {
    expect(report.quality).toMatchObject({ merged: 1, reverted: 1, reworked: 0 });
    expect(report.quality.reverts[0]).toMatchObject({ kind: "revert", run: "s-ana" });
    expect(report.quality.signals).toEqual([
      expect.objectContaining({ repo: "acme/web", module: "billing", state: "open", rate: 0.5 }),
    ]);
    expect(report.presence.work).toEqual([
      { person: "ana@example.com", repos: [{ repo: "acme/web", sessions: 1 }] },
      { person: "bo@example.com", repos: [{ repo: "acme/api", sessions: 1 }] },
    ]);
    expect(report.presence.overlaps).toEqual([
      {
        repo: "acme/web",
        file: "src/app.ts",
        owners: ["ana@example.com", "bo@example.com"],
        times: 1,
        run: "s-ana",
      },
    ]);
  });

  it("recommends at most 3 changes, risky ones first, by fixed rules", () => {
    expect(report.recommendations.map((r) => r.action)).toEqual([
      "review_learned_signal",
      "check_repeated_blocks",
      "enforce_rule",
    ]);
    expect(report.recommendations[0]?.item_id).toBe(report.quality.signals[0]?.item_id);
    expect(report.recommendations[1]?.title).toContain("bo@example.com");
    expect(report.recommendations[2]?.title).toBe("Start enforcing rule no-force-push");
  });

  it("makes savings recommendations with a stated amount when nothing riskier is due", () => {
    const data = week();
    data.signals = [];
    data.events = data.events.filter((e) => e.kind !== "policy.evaluated");
    const quiet = advisorReport(data, { teams: ["web"], from: FROM, to: TO });
    expect(quiet.recommendations).toHaveLength(1);
    const [rec] = quiet.recommendations;
    expect(rec).toMatchObject({ action: "switch_billing", screen: "spend" });
    expect(rec?.saving_usd).toBeGreaterThan(20);
  });

  it("gives a member only their own work, with no signals or rule changes", () => {
    const bo = advisorReport(week(), {
      teams: ["web"],
      person: "bo@example.com",
      from: FROM,
      to: TO,
    });
    expect(bo.scope).toBe("self");
    expect(bo.shipped.opened).toBe(0);
    expect(bo.spend.by.map((r) => r.person)).toEqual(["bo@example.com"]);
    expect(bo.quality.signals).toEqual([]);
    expect(bo.presence.work.map((w) => w.person)).toEqual(["bo@example.com"]);
    expect(bo.blocked.exceptions.requested).toBe(1);
    expect(bo.recommendations.map((r) => r.action)).toEqual(["check_repeated_blocks"]);
    expect(bo.recommendations[0]?.title).not.toContain("bo@example.com");

    const ana = advisorReport(week(), {
      teams: ["web"],
      person: "ANA@example.com",
      from: FROM,
      to: TO,
    });
    expect(ana.blocked.exceptions.requested).toBe(0);
    expect(ana.blocked.rules.map((r) => r.rule_id)).toEqual(["no-force-push"]);
  });

  it("calls an empty week quiet", () => {
    const empty = advisorReport(
      { events: [], signals: [], items: [], grantsUsed: [] },
      { teams: null, from: FROM, to: TO },
    );
    expect(isQuietWeek(empty)).toBe(true);
    expect(isQuietWeek(report)).toBe(false);
  });
});

describe("advisor text", () => {
  const report = advisorReport(week(), { teams: ["web"], from: FROM, to: TO });

  it("names ids and amounts, links each change, and holds nothing an agent wrote", () => {
    const message = advisorMessage(report, "https://selfhost.example.com/");
    expect(message.title).toBe("selfhost: your week with agents, 3 changes to make");
    expect(message.body).toContain("What shipped: 2 agent pull requests opened, 1 merged.");
    expect(message.body).toContain(
      "Where money went: $64.00 on models ($4.00 from vendor reports)",
    );
    expect(message.body).toContain("https://selfhost.example.com/?screen=run&run=s-bo");
    for (const forbidden of [...FORBIDDEN, ".env"]) expect(message.body).not.toContain(forbidden);
    expect(message.body).not.toContain(String.fromCharCode(0x2014));
  });

  it("points to the CLI without a console address", () => {
    expect(advisorMessage(report, undefined).body).toContain("selfhost advisor");
    expect(advisorLines(report).join("\n")).not.toContain("http");
  });
});

describe("advisorWindow", () => {
  const monday9 = { day: "monday" as const, hour: 9, timeZone: "UTC" };

  it("opens on the configured day and hour, and holds until the next", () => {
    expect(advisorWindow(NOW, monday9)).toEqual({ start: TO, key: `advisor:${TO.toISOString()}` });
    // Just before Monday 09:00 the window is still last week's.
    const before = new Date("2026-11-09T08:59:00.000Z");
    expect(advisorWindow(before, monday9).start.toISOString()).toBe("2026-11-02T09:00:00.000Z");
    expect(advisorWindow(NOW, { ...monday9, day: "friday" }).start.toISOString()).toBe(
      "2026-11-06T09:00:00.000Z",
    );
  });

  it("reads the hour in the team's timezone, across daylight saving changes", () => {
    // Asia/Kolkata is UTC+5:30: Monday 09:00 there is 03:30 UTC.
    expect(advisorWindow(NOW, { ...monday9, timeZone: "Asia/Kolkata" }).start.toISOString()).toBe(
      "2026-11-09T03:30:00.000Z",
    );
    // New York left daylight saving on 2026-11-01: 09:00 is 14:00 UTC after, 13:00 UTC before.
    const ny = { ...monday9, timeZone: "America/New_York" };
    expect(advisorWindow(new Date("2026-11-09T15:00:00.000Z"), ny).start.toISOString()).toBe(
      "2026-11-09T14:00:00.000Z",
    );
    expect(advisorWindow(new Date("2026-10-27T00:00:00.000Z"), ny).start.toISOString()).toBe(
      "2026-10-26T13:00:00.000Z",
    );
    // Sunday evening in Los Angeles is already Monday in UTC: still last week's window there.
    expect(
      advisorWindow(new Date("2026-11-10T03:00:00.000Z"), {
        ...monday9,
        timeZone: "America/Los_Angeles",
      }).start.toISOString(),
    ).toBe("2026-11-09T17:00:00.000Z");
  });
});

describe("the [notify] advisor settings", () => {
  it("default to admins, Monday 09:00 UTC, and refuse an unknown timezone", () => {
    const ok = validateConfig({ version: 1 });
    expect(ok.ok && ok.config.notify).toMatchObject({
      advisor: "admins",
      advisor_day: "monday",
      advisor_hour: 9,
      advisor_timezone: "UTC",
    });
    const bad = validateConfig({ version: 1, notify: { advisor_timezone: "Mars/Olympus" } });
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).toContain("advisor_timezone");
  });
});

describe("the weekly note", () => {
  let ledger: Ledger;
  beforeEach(async () => {
    ledger = await openLedger({ dataDir: "memory://" });
  });
  afterEach(async () => {
    await ledger.close();
  });

  const directory = (overrides: Partial<Directory> = {}): Directory => ({
    settingsFor: async () => ({ ...NOTIFY_DEFAULTS, digest: "off", spend_digest: false }),
    unowned: async () => [],
    budgetOwners: async () => [],
    advisor: async () => ({ teams: null }),
    ...overrides,
  });

  it("reads the week from the ledger and sends it once per window to each target", async () => {
    const data = week();
    await ledger.append(data.events.filter((e) => e.kind !== "alert.raised"));
    const read = await readAdvisorData(ledger, { from: FROM, to: TO, teams: null });
    expect(read.events).toHaveLength(data.events.length - 1);
    const fromLedger = advisorReport(read, { teams: null, from: FROM, to: TO });
    expect(fromLedger.shipped.merged).toBe(1);
    expect(fromLedger.spend.usd).toBe(64);

    const store = notifyStore(databaseOf(ledger));
    await store.addTarget("lead@example.com", "slack", "slack://T000/B000/XXX", FROM);
    const { deliver, sent } = fakeDeliver();
    const pass = (at: Date) => runNotify(ledger, { deliver, directory: directory(), now: at });
    expect(await pass(NOW)).toEqual({ sent: 1, failed: 0 });
    expect(await pass(new Date(NOW.getTime() + 3_600_000))).toEqual({ sent: 0, failed: 0 });
    expect(sent[0]?.message.title).toContain("your week with agents");
    const [send] = await store.sends("lead@example.com");
    expect(send).toMatchObject({ kind: "digest", subject: `advisor:${TO.toISOString()}` });
  });

  it("sends nothing for a quiet week, or to whom the directory gives no note", async () => {
    const store = notifyStore(databaseOf(ledger));
    await store.addTarget("lead@example.com", "slack", "slack://T000/B000/XXX", FROM);
    const { deliver, sent } = fakeDeliver();
    expect(await runNotify(ledger, { deliver, directory: directory(), now: NOW })).toEqual({
      sent: 0,
      failed: 0,
    });
    await ledger.append(week().events.filter((e) => e.kind === "cost.recorded"));
    const none = directory({ advisor: async () => undefined });
    expect(await runNotify(ledger, { deliver, directory: none, now: NOW })).toEqual({
      sent: 0,
      failed: 0,
    });
    expect(sent).toEqual([]);
  });
});

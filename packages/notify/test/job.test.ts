import { databaseOf, type Ledger, openLedger } from "@selfhost/ledger";
import type { LedgerEvent } from "@selfhost/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Directory, NOTIFY_DEFAULTS, runNotify, sendTest } from "../src/job.js";
import { testMessage } from "../src/message.js";
import { notifyStore } from "../src/store.js";
import { FORBIDDEN, fakeDeliver, insertItem, item } from "./fixtures.js";

const NOW = new Date("2026-11-09T10:05:00.000Z");
/** When the targets were added, before anything the tests raise. */
const ADDED = new Date("2026-11-01T00:00:00.000Z");
const PHONE = "tgram://123456:BOTSECRET/987";
const MAIL = "mailtos://dev:MAILPASS@smtp.example.com";

let ledger: Ledger;
beforeEach(async () => {
  ledger = await openLedger({ dataDir: "memory://" });
});
afterEach(async () => {
  await ledger.close();
});

function directory(overrides: Partial<Directory> = {}): Directory {
  return {
    settingsFor: async () => ({ ...NOTIFY_DEFAULTS, digest: "off", spend_digest: false }),
    unowned: async () => ["lead@example.com"],
    budgetOwners: async () => ["lead@example.com"],
    ...overrides,
  };
}

const store = () => notifyStore(databaseOf(ledger));

describe("runNotify", () => {
  it("pushes an item an agent waits on to its owner's targets once, and records each send without the URL", async () => {
    await store().addTarget("dev@example.com", "phone", PHONE, ADDED);
    await store().addTarget("dev@example.com", "email", MAIL, ADDED);
    await insertItem(ledger, item());
    await insertItem(ledger, item({ blocking: false, kind: "pr" }));
    const { deliver, sent } = fakeDeliver();

    expect(await runNotify(ledger, { deliver, directory: directory(), now: NOW })).toEqual({
      sent: 2,
      failed: 0,
    });
    expect(sent.map((s) => s.url).sort()).toEqual([MAIL, PHONE]);
    for (const { message } of sent) {
      for (const forbidden of FORBIDDEN) expect(message.body).not.toContain(forbidden);
    }
    // Nothing twice.
    expect(await runNotify(ledger, { deliver, directory: directory(), now: NOW })).toEqual({
      sent: 0,
      failed: 0,
    });
    const sends = await store().sends("dev@example.com");
    expect(sends.map((s) => [s.target, s.kind, s.ok]).sort()).toEqual([
      ["email", "item", true],
      ["phone", "item", true],
    ]);
    const rows = await databaseOf(ledger).query("SELECT * FROM notify_sends");
    expect(JSON.stringify(rows)).not.toMatch(/BOTSECRET|MAILPASS/);
  });

  it("leaves items older than an hour to the digest, and skips people with no target", async () => {
    await store().addTarget("dev@example.com", "phone", PHONE, ADDED);
    await insertItem(ledger, item({ created_at: "2026-11-09T08:00:00.000Z" }));
    await insertItem(ledger, item({ owners: ["other@example.com"] }));
    const { deliver, sent } = fakeDeliver();
    await runNotify(ledger, { deliver, directory: directory(), now: NOW });
    expect(sent).toEqual([]);
  });

  it("pushes an item nobody owns to the people the directory names", async () => {
    await store().addTarget("Lead@Example.com", "phone", PHONE, ADDED);
    await insertItem(ledger, item({ owners: [] }), "web");
    const seen: (string | null)[] = [];
    const { deliver, sent } = fakeDeliver();
    await runNotify(ledger, {
      deliver,
      directory: directory({
        unowned: async (team) => {
          seen.push(team);
          return ["lead@example.com"];
        },
      }),
      now: NOW,
    });
    expect(seen).toEqual(["web"]);
    expect(sent).toHaveLength(1);
  });

  it("tries a failed send again on later passes, three times at most, with the error masked", async () => {
    await store().addTarget("dev@example.com", "phone", PHONE, ADDED);
    await insertItem(ledger, item());
    const { deliver, sent } = fakeDeliver(new Set([PHONE]));
    for (let pass = 0; pass < 5; pass++) {
      await runNotify(ledger, { deliver, directory: directory(), now: NOW });
    }
    expect(sent).toHaveLength(3);
    const sends = await store().sends("dev@example.com");
    expect(sends.every((s) => !s.ok && s.error === "could not reach tgram://****")).toBe(true);
  });

  it("sends the digest once per window, with the person's own cadence over the team's", async () => {
    await store().addTarget("dev@example.com", "phone", PHONE, ADDED);
    await insertItem(ledger, item({ blocking: false, created_at: "2026-11-08T10:00:00.000Z" }));
    const daily = directory({
      settingsFor: async () => ({ ...NOTIFY_DEFAULTS, spend_digest: false }),
    });
    const { deliver, sent } = fakeDeliver();
    await runNotify(ledger, { deliver, directory: daily, now: NOW });
    await runNotify(ledger, { deliver, directory: daily, now: new Date("2026-11-09T18:00:00Z") });
    expect(sent.map((s) => s.message.title)).toEqual(["selfhost: 1 item on your review list"]);
    await runNotify(ledger, { deliver, directory: daily, now: new Date("2026-11-10T09:01:00Z") });
    expect(sent).toHaveLength(2);

    await store().setDigest("dev@example.com", "off");
    await runNotify(ledger, { deliver, directory: daily, now: new Date("2026-11-11T09:01:00Z") });
    expect(sent).toHaveLength(2);
  });

  it("sends no digest when the person has nothing open", async () => {
    await store().addTarget("dev@example.com", "phone", PHONE, ADDED);
    const { deliver, sent } = fakeDeliver();
    await runNotify(ledger, {
      deliver,
      directory: directory({ settingsFor: async () => NOTIFY_DEFAULTS }),
      now: NOW,
    });
    expect(sent).toEqual([]);
  });

  it("pushes budget alerts to the budget owners, but leaves a run's cap to the spend digest", async () => {
    await store().addTarget("lead@example.com", "phone", PHONE, ADDED);
    const alert = (n: number, data: Record<string, unknown>): LedgerEvent => ({
      id: `01930c4e-2f1a-7b2c-8d3e-0000000a000${n}`,
      schema: "selfhost.event/v1",
      ts: "2026-11-09T10:00:00.000Z",
      source: "server",
      kind: "alert.raised",
      actor: { kind: "system", id: `selfhost:team:web:${n}` },
      team: "web",
      data: { limit_usd: 100, spent_usd: 81, message: "Team web spent 80%", ...data },
    });
    await ledger.append([
      alert(1, { alert: "budget", percent: 80, scope: "team" }),
      alert(2, { alert: "budget_exceeded", scope: "run" }),
      alert(3, { alert: "spend_spike" }),
    ]);
    const owners: (string | null)[] = [];
    const { deliver, sent } = fakeDeliver();
    await runNotify(ledger, {
      deliver,
      directory: directory({
        budgetOwners: async (team) => {
          owners.push(team);
          return ["lead@example.com"];
        },
      }),
      now: NOW,
    });
    expect(owners).toEqual(["web"]);
    expect(sent.map((s) => s.message.title)).toEqual(["selfhost: 80% of a budget spent"]);
  });

  it("sends the budget owner a daily spend digest when there is spend to report", async () => {
    await store().addTarget("lead@example.com", "phone", PHONE, ADDED);
    const { deliver, sent } = fakeDeliver();
    const spend = directory({
      settingsFor: async () => ({ ...NOTIFY_DEFAULTS, digest: "off" }),
      spendDigest: async (person) =>
        person === "lead@example.com"
          ? {
              budgets: [{ team: "web", period: "month", limit_usd: 100, spent_usd: 40 }],
              top_spenders: [{ person: "dev@example.com", team: "web", usd: 12 }],
              growing_teams: [],
              capped_runs: [],
            }
          : undefined,
    });
    await runNotify(ledger, { deliver, directory: spend, now: NOW });
    await runNotify(ledger, { deliver, directory: spend, now: NOW });
    expect(sent.map((s) => s.message.title)).toEqual(["selfhost: daily spend digest"]);
  });

  it("sends a new target nothing raised before it was added, and the rest oldest first", async () => {
    const alert = (n: number, ts: string, percent: number): LedgerEvent => ({
      id: `01930c4e-2f1a-7b2c-8d3e-0000000b000${n}`,
      schema: "selfhost.event/v1",
      ts,
      source: "server",
      kind: "alert.raised",
      actor: { kind: "system", id: `selfhost:team:web:${percent}` },
      team: "web",
      data: {
        alert: "budget",
        percent,
        scope: "team",
        limit_usd: 100,
        spent_usd: percent,
        message: `Team web spent ${percent}%`,
      },
    });
    await ledger.append([
      alert(3, "2026-11-09T09:30:00.000Z", 80),
      alert(1, "2026-11-09T08:00:00.000Z", 20),
      alert(2, "2026-11-09T09:00:00.000Z", 50),
    ]);
    await insertItem(
      ledger,
      item({ created_at: "2026-11-09T09:45:00.000Z", owners: ["lead@example.com"] }),
    );
    await store().addTarget("lead@example.com", "phone", PHONE, new Date("2026-11-09T08:30:00Z"));
    const { deliver, sent } = fakeDeliver();
    await runNotify(ledger, { deliver, directory: directory(), now: NOW });
    const titles = sent.map((s) => s.message.title);
    expect(titles.slice(0, 2)).toEqual([
      "selfhost: 50% of a budget spent",
      "selfhost: 80% of a budget spent",
    ]);
    expect(titles).toHaveLength(3);
    expect(titles[2]).not.toMatch(/budget/);
  });

  it("still sends an item raised a moment before the target was added, as clocks drift", async () => {
    await insertItem(ledger, item({ created_at: "2026-11-09T09:45:00.000Z" }));
    await store().addTarget(
      "dev@example.com",
      "phone",
      PHONE,
      new Date("2026-11-09T09:45:00.900Z"),
    );
    await store().addTarget("dev@example.com", "late", MAIL, new Date("2026-11-09T09:50:00Z"));
    const { deliver, sent } = fakeDeliver();
    await runNotify(ledger, { deliver, directory: directory(), now: NOW });
    expect(sent.map((s) => s.url)).toEqual([PHONE]);
  });

  it("sends a new target's first digest when the next window opens, not at once", async () => {
    await insertItem(ledger, item({ blocking: false, created_at: "2026-11-08T10:00:00.000Z" }));
    const weekly = directory({
      settingsFor: async () => ({ ...NOTIFY_DEFAULTS, digest: "weekly", spend_digest: false }),
    });
    // Added on a Tuesday at 15:00 UTC.
    await store().addTarget("dev@example.com", "phone", PHONE, new Date("2026-11-10T15:00:00Z"));
    const { deliver, sent } = fakeDeliver();
    for (const at of ["2026-11-10T15:01:00Z", "2026-11-11T09:30:00Z", "2026-11-15T23:00:00Z"]) {
      await runNotify(ledger, { deliver, directory: weekly, now: new Date(at) });
    }
    expect(sent).toEqual([]);
    await runNotify(ledger, { deliver, directory: weekly, now: new Date("2026-11-16T09:01:00Z") });
    expect(sent.map((s) => s.message.title)).toEqual(["selfhost: 1 item on your review list"]);
  });

  it("sends a test to each target and records it", async () => {
    await store().addTarget("dev@example.com", "phone", PHONE, ADDED);
    await store().addTarget("dev@example.com", "email", MAIL, ADDED);
    const { deliver } = fakeDeliver(new Set([MAIL]));
    const sends = await sendTest(ledger, "dev@example.com", deliver, testMessage("dev"), NOW);
    expect(sends.map((s) => [s.target, s.ok]).sort()).toEqual([
      ["email", false],
      ["phone", true],
    ]);
    expect(JSON.stringify(sends)).not.toContain("MAILPASS");
  });
});

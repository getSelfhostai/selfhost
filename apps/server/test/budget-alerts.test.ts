import { type Ledger, openLedger } from "@selfhost/ledger";
import { openReviewList, refreshReviewList } from "@selfhost/review";
import type { JoinResponse, LedgerEvent } from "@selfhost/schema";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { raiseBudgetAlerts } from "../src/budget-alerts.js";
import { caller, TOKEN } from "./helpers.js";

const NOW = new Date("2026-11-20T12:00:00.000Z");

let n = 0;
const cost = (usd: number): LedgerEvent => {
  n += 1;
  return {
    id: `01930c4e-2f1a-7b2c-9d3e-${n.toString(16).padStart(12, "0")}`,
    schema: "selfhost.event/v1",
    ts: "2026-11-19T10:00:00.000Z",
    source: "local_log",
    kind: "cost.recorded",
    actor: { kind: "person", id: "dev@example.com" },
    session_id: `s-${n}`,
    agent: { vendor: "claude_code" },
    model: "claude-opus-4",
    cost: {
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      usd,
      estimated: true,
    },
  };
};

const ledgers: Ledger[] = [];
afterEach(async () => {
  for (const ledger of ledgers.splice(0)) await ledger.close();
});

describe("budget alerts from ledger spend", () => {
  it("raises the highest share crossed once, as review items for the budget owners", async () => {
    const ledger = await openLedger({ dataDir: "memory://" });
    ledgers.push(ledger);
    const app = createApp({ version: "1.2.3", ledger, token: TOKEN, now: () => NOW });
    const admin = caller(app, TOKEN);
    const created = (await (await admin("/v1/teams", "POST", { name: "Web" })).json()) as {
      invite: string;
    };
    const joined = (await (
      await admin("/v1/join", "POST", { invite: created.invite, person: "dev@example.com" })
    ).json()) as JoinResponse;
    const dev = caller(app, joined.token);
    const text = "version = 1\n[budget]\nmonthly_usd = 1\n";
    expect((await dev("/v1/policy", "PUT", { text })).status).toBe(200);
    expect((await dev("/v1/events", "POST", { events: [cost(0.6)] })).status).toBe(200);

    expect(await raiseBudgetAlerts(ledger, NOW)).toBe(1);
    // Spend that jumps past 80% and 100% between two checks raises the 100% alert alone.
    expect((await dev("/v1/events", "POST", { events: [cost(0.49)] })).status).toBe(200);
    expect(await raiseBudgetAlerts(ledger, NOW)).toBe(1);
    // Each share of each window is raised once.
    expect(await raiseBudgetAlerts(ledger, NOW)).toBe(0);

    const alerts = (await ledger.query({ kind: "alert.raised" })).events.sort(
      (a, b) => Number(a.data?.percent) - Number(b.data?.percent),
    );
    expect(alerts.map((event) => [event.team, event.data?.alert, event.data?.percent])).toEqual([
      ["web", "budget", 50],
      ["web", "budget_exceeded", 100],
    ]);
    expect(alerts[1]?.data?.message).toBe(
      "Team web went over the month's budget of $1: $1.09 spent, $0.09 over",
    );

    const list = openReviewList(ledger, { now: () => NOW });
    await refreshReviewList(ledger, list);
    const { items } = await list.list({});
    expect(items.map((item) => [item.kind, item.title, item.owners]).sort()).toEqual([
      ["budget", "Team web spent 50% of the month's budget of $1", ["dev@example.com"]],
      [
        "budget",
        "Team web went over the month's budget of $1: $1.09 spent, $0.09 over",
        ["dev@example.com"],
      ],
    ]);
    expect(items[0]?.route?.from).toBe("the team's owners");
  });

  it("suggests what matches the [budget] mode in force", async () => {
    const suggestionFor = async (budget: string, gateway?: boolean) => {
      const ledger = await openLedger({ dataDir: "memory://" });
      ledgers.push(ledger);
      const app = createApp({ version: "1.2.3", ledger, token: TOKEN, now: () => NOW });
      const admin = caller(app, TOKEN);
      const created = (await (await admin("/v1/teams", "POST", { name: "Web" })).json()) as {
        invite: string;
      };
      const joined = (await (
        await admin("/v1/join", "POST", { invite: created.invite, person: "dev@example.com" })
      ).json()) as JoinResponse;
      const dev = caller(app, joined.token);
      const text = `version = 1\n[budget]\nmonthly_usd = 1\n${budget}`;
      expect((await dev("/v1/policy", "PUT", { text })).status).toBe(200);
      expect((await dev("/v1/events", "POST", { events: [cost(1.2)] })).status).toBe(200);
      expect(await raiseBudgetAlerts(ledger, NOW, gateway === undefined ? {} : { gateway })).toBe(
        1,
      );
      const [alert] = (await ledger.query({ kind: "alert.raised" })).events;
      return String(alert?.data?.suggestion);
    };
    expect(await suggestionFor("")).toContain('or set [budget] mode = "hard" with a gateway');
    const hard = await suggestionFor('mode = "hard"\n', true);
    expect(hard).not.toContain('set [budget] mode = "hard"');
    expect(hard).toContain("the gateway refuses requests sent with its keys");
    const noGateway = await suggestionFor('mode = "hard"\n', false);
    expect(noGateway).not.toContain('set [budget] mode = "hard"');
    expect(noGateway).toContain("no gateway runs on this server");
  });
});

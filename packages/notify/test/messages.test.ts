import type { LedgerEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { appriseApi, appriseCli } from "../src/apprise.js";
import { digestWindow, spendDigestWindow } from "../src/cadence.js";
import { freeName, maskUrl, nameProblem, scrub, serviceOf, urlProblem } from "../src/mask.js";
import {
  digestMessage,
  itemMessage,
  spendAlertMessage,
  spendDigestMessage,
  summaryOf,
} from "../src/message.js";
import { FORBIDDEN, item, itemsOfEveryKind, SECRET } from "./fixtures.js";

const CONSOLE = "https://selfhost.example.com";

const textOf = (message: { title: string; body: string }) => `${message.title}\n${message.body}`;

function expectClean(text: string) {
  for (const forbidden of FORBIDDEN) expect(text, forbidden).not.toContain(forbidden);
}

describe("messages hold a summary and a link only", () => {
  const items = itemsOfEveryKind();

  it.each(items.map((value) => [value.kind, value] as const))(
    "a %s push has no code, diff, prompt or secret",
    (_kind, value) => {
      const message = itemMessage(value, CONSOLE);
      expectClean(textOf(message));
      expect(message.body).toContain(`${CONSOLE}/?screen=review&item=${value.id}`);
    },
  );

  it("a digest of every kind has no code, diff, prompt or secret", () => {
    const message = digestMessage(items, "daily", CONSOLE);
    expectClean(textOf(message));
    expect(message.body.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(
      items.length,
    );
    expect(message.body).toContain(`${CONSOLE}/?screen=review`);
  });

  it("names the agent, repo, rule, risk and deadline of a push", () => {
    const message = itemMessage(item(), CONSOLE);
    expect(message.title).toBe("selfhost: Approval, an agent waits");
    expect(message.body).toContain(
      "Claude Code waits for an approval (acme/web, rule no-network, risk 90).",
    );
    expect(message.body).toContain("No answer by 10:15 UTC denies it.");
  });

  it("points to the CLI when the server has no public URL", () => {
    expect(itemMessage(item(), undefined).body).toContain("selfhost inbox");
  });

  it("keeps selfhost's own budget numbers and masks anything secret in them", () => {
    const budget = items.find((value) => value.kind === "budget");
    expect(budget && summaryOf(budget)).toBe(
      "Team web spent 80% of the month's budget of $100 [redacted]",
    );
  });

  it("says when a digest has more items than it lists", () => {
    const many = Array.from({ length: 20 }, () => item({ blocking: false }));
    const body = digestMessage(many, "weekly", undefined).body;
    expect(body).toContain("Your weekly digest: 20 items waiting for you.");
    expect(body).toContain("...and 5 more.");
  });

  it("writes budget alerts and the spend digest without secrets", () => {
    const event = {
      id: "01930c4e-2f1a-7b2c-8d3e-00000000ffff",
      schema: "selfhost.event/v1",
      ts: "2026-11-09T10:00:00.000Z",
      source: "server",
      kind: "alert.raised",
      actor: { kind: "system", id: "selfhost:team:web:80" },
      team: "web",
      data: {
        alert: "budget",
        percent: 80,
        message: `Team web spent 80% of the month's budget of $100 ${SECRET}`,
        suggestion: "Requests go on: raise [budget] in selfhost.toml.",
        limit_usd: 100,
        spent_usd: 81,
        scope: "team",
      },
    } as LedgerEvent;
    const alert = spendAlertMessage(event, CONSOLE);
    expect(alert.title).toBe("selfhost: 80% of a budget spent");
    expect(alert.type).toBe("warning");
    expectClean(textOf(alert));
    const digest = spendDigestMessage(
      {
        budgets: [{ team: "web", period: "month", limit_usd: 100, spent_usd: 81 }],
        top_spenders: [{ person: "dev@example.com", team: "web", usd: 12.5 }],
        growing_teams: [{ team: "web", last_day_usd: 12.5, daily_average_usd: 2 }],
        capped_runs: [{ team: "web", run_id: "run-7", limit_usd: 5 }],
      },
      CONSOLE,
    );
    expect(digest.body).toContain("- web: $81.00 of $100.00 this month (81%)");
    expect(digest.body).toContain("- dev@example.com (web): $12.50");
    expect(digest.body).toContain("- run-7 (web), cap $5.00");
  });
});

describe("target URLs", () => {
  it("accepts Apprise URLs and refuses anything else", () => {
    expect(urlProblem("tgram://123456:ABC-def/987654")).toBeUndefined();
    expect(urlProblem("mailtos://user:pass@smtp.example.com?to=me@example.com")).toBeUndefined();
    expect(urlProblem("ntfys://selfhost-alerts")).toBeUndefined();
    expect(urlProblem("not a url")).toBeDefined();
    expect(urlProblem("tgram://has space")).toBeDefined();
    expect(urlProblem(`tgram://${"a".repeat(3000)}`)).toBeDefined();
  });

  it("never shows more than the scheme", () => {
    const url = "slack://T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX/#alerts";
    expect(serviceOf(url)).toBe("slack");
    expect(maskUrl(url)).toBe("slack://****");
    expect(scrub(`failed to send to ${url} (timeout)`, [url])).toBe(
      "failed to send to slack://**** (timeout)",
    );
    expect(scrub("Apprise said mailto://a:b@c.example.com is bad")).toBe(
      "Apprise said mailto://**** is bad",
    );
  });

  it("names targets after their service", () => {
    expect(freeName("tgram", new Set())).toBe("tgram");
    expect(freeName("tgram", new Set(["tgram", "tgram-2"]))).toBe("tgram-3");
    expect(nameProblem("phone")).toBeUndefined();
    expect(nameProblem("my phone")).toBeDefined();
  });
});

describe("digest windows", () => {
  it("opens a daily window at the hour, UTC", () => {
    expect(digestWindow("daily", new Date("2026-11-09T10:00:00Z"), 9)?.key).toBe(
      "daily:2026-11-09T09:00:00.000Z",
    );
    expect(digestWindow("daily", new Date("2026-11-09T08:59:00Z"), 9)?.key).toBe(
      "daily:2026-11-08T09:00:00.000Z",
    );
  });

  it("opens a weekly window on Monday at the hour", () => {
    // 2026-11-09 is a Monday.
    expect(digestWindow("weekly", new Date("2026-11-12T15:00:00Z"), 9)?.key).toBe(
      "weekly:2026-11-09T09:00:00.000Z",
    );
    expect(digestWindow("weekly", new Date("2026-11-09T08:00:00Z"), 9)?.key).toBe(
      "weekly:2026-11-02T09:00:00.000Z",
    );
  });

  it("has no window when the digest is off", () => {
    expect(digestWindow("off", new Date(), 9)).toBeUndefined();
    expect(spendDigestWindow(new Date("2026-11-09T10:00:00Z"), 9).key).toBe(
      "spend:2026-11-09T09:00:00.000Z",
    );
  });
});

describe("delivery", () => {
  const message = { title: "t", body: "b", type: "info" as const };

  it("POSTs one stateless /notify per target to the Apprise API, with the URL in the body", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const deliver = appriseApi("http://apprise:8000/", async (url, init) => {
      calls.push({ url, init });
      return new Response("", { status: 200 });
    });
    expect(await deliver.send("tgram://bot/123", message)).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("http://apprise:8000/notify");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      urls: "tgram://bot/123",
      title: "t",
      body: "b",
      type: "info",
      format: "text",
    });
  });

  it("reports a refused send without the URL", async () => {
    const url = "tgram://123456:SECRETBOT/987";
    const deliver = appriseApi("http://apprise:8000", async () =>
      Response.json({ error: `Failed to send to ${url}` }, { status: 424 }),
    );
    const result = await deliver.send(url, message);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SECRETBOT");
    expect(JSON.stringify(result)).toContain("424");
  });

  it("runs the apprise command with the URL in APPRISE_URLS, never in its arguments", async () => {
    const runs: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const deliver = appriseCli(
      "/usr/local/bin/apprise",
      { PATH: "/usr/bin" },
      async (_f, args, env) => {
        runs.push({ args, env });
        return { code: 0, output: "" };
      },
    );
    expect(await deliver.send("ntfys://topic", message)).toEqual({ ok: true });
    expect(runs[0]?.args).toEqual(["-t", "t", "-b", "b"]);
    expect(runs[0]?.env.APPRISE_URLS).toBe("ntfys://topic");
    const failing = appriseCli("/bin/apprise", {}, async () => ({
      code: 1,
      output: "ERROR - Failed to send ntfys://topic",
    }));
    const failed = await failing.send("ntfys://topic", message);
    expect(failed).toEqual({
      ok: false,
      error: "apprise exited with 1: ERROR - Failed to send ntfys://****",
    });
  });
});

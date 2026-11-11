import { type Ledger, openLedger } from "@selfhost/ledger";
import { appriseApi, runNotify } from "@selfhost/notify";
import { openReviewList, refreshReviewList } from "@selfhost/review";
import type { JoinResponse, LedgerEvent, NotifySettings } from "@selfhost/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { raiseBudgetAlerts } from "../src/budget-alerts.js";
import { serverDirectory, startNotifyJob } from "../src/notify.js";
import { startReviewRefreshJob, WAITING_EVENT_KINDS } from "../src/review.js";
import { caller, TOKEN } from "./helpers.js";

const NOW = new Date("2026-11-20T12:00:00.000Z");
const PHONE = "tgram://123456:BOTSECRET/987";
const FAILING = "discord://fail.example.com/MAILPASS";

/**
 * Stands in for the Apprise API server: it keeps each stateless /notify body and answers 200,
 * or 424 (a target failed) for URLs on fail.example.com, quoting the URL as Apprise may.
 */
function fakeApprise() {
  const received: { endpoint: string; urls: string; title: string; body: string }[] = [];
  const fetch = async (endpoint: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { urls: string; title: string; body: string };
    received.push({ endpoint, ...body });
    if (body.urls.includes("fail.example.com")) {
      return Response.json({ error: `Could not send to ${body.urls}` }, { status: 424 });
    }
    return Response.json({});
  };
  return { deliver: appriseApi("http://apprise:8000", fetch), received };
}

let n = 0;
const id = () => {
  n += 1;
  return `01930c4e-2f1a-7b2c-9d3e-${n.toString(16).padStart(12, "0")}`;
};

const cost = (person: string, usd: number, ts = "2026-11-20T10:00:00.000Z"): LedgerEvent => ({
  id: id(),
  schema: "selfhost.event/v1",
  ts,
  source: "local_log",
  kind: "cost.recorded",
  actor: { kind: "person", id: person },
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
});

const waiting = (person: string): LedgerEvent => ({
  id: id(),
  schema: "selfhost.event/v1",
  ts: "2026-11-20T11:59:00.000Z",
  source: "hook",
  kind: "approval.requested",
  actor: { kind: "person", id: person },
  session_id: `wait-${n}`,
  agent: { vendor: "claude_code" },
  tool: {
    name: "Bash",
    input_summary: "curl -H 'Authorization: Bearer sk-proj-0123456789abcdefghijKLMN'",
  },
  data: { message: "Claude needs your permission to use Bash" },
});

/**
 * The server's clock: from before anything the tests raise, a second further on each read, so
 * targets are added in order and before the events and digest windows the job sends.
 */
const ADDED = new Date("2026-11-20T08:00:00.000Z");
let clock = ADDED;
const tick = () => {
  clock = new Date(clock.getTime() + 1000);
  return clock;
};

let ledger: Ledger;
beforeEach(async () => {
  ledger = await openLedger({ dataDir: "memory://" });
  clock = ADDED;
});
afterEach(async () => {
  await ledger.close();
});

async function team(apprise = fakeApprise(), eventsStored?: (kinds: readonly string[]) => void) {
  const app = createApp({
    version: "1.2.3",
    ledger,
    token: TOKEN,
    now: tick,
    notify: { deliver: apprise.deliver },
    ...(eventsStored ? { eventsStored } : {}),
  });
  const admin = caller(app, TOKEN);
  const created = (await (await admin("/v1/teams", "POST", { name: "Web" })).json()) as {
    invite: string;
  };
  const join = async (person: string) => {
    const joined = (await (
      await admin("/v1/join", "POST", { invite: created.invite, person })
    ).json()) as JoinResponse;
    return caller(app, joined.token);
  };
  // The first to join is the team's owner.
  const lead = await join("lead@example.com");
  const dev = await join("dev@example.com");
  return { app, admin, lead, dev, apprise };
}

describe("notification settings", () => {
  it("keeps a person's targets and never returns their URLs", async () => {
    const { dev } = await team();
    const empty = (await (await dev("/v1/notify")).json()) as NotifySettings;
    expect(empty).toEqual({
      person: "dev@example.com",
      targets: [],
      digest: "daily",
      digest_set: false,
      delivery: "apprise_api",
    });

    const added = await dev("/v1/notify/targets", "POST", { url: PHONE });
    expect(added.status).toBe(201);
    const text = await added.text();
    expect(text).not.toContain("BOTSECRET");
    expect((JSON.parse(text) as NotifySettings).targets).toEqual([
      expect.objectContaining({ name: "tgram", service: "tgram", masked: "tgram://****" }),
    ]);
    expect((await dev("/v1/notify/targets", "POST", { url: PHONE, name: "tgram" })).status).toBe(
      409,
    );
    expect((await dev("/v1/notify/targets", "POST", { url: "not a url" })).status).toBe(400);
    expect((await dev("/v1/notify/targets", "POST", { url: PHONE, name: "a b" })).status).toBe(400);
    const second = (await (
      await dev("/v1/notify/targets", "POST", { url: "discord://1234/WEBHOOKTOKEN" })
    ).json()) as NotifySettings;
    expect(second.targets.map((t) => t.name)).toEqual(["tgram", "discord"]);

    const weekly = (await (
      await dev("/v1/notify/digest", "PUT", { digest: "weekly" })
    ).json()) as NotifySettings;
    expect([weekly.digest, weekly.digest_set]).toEqual(["weekly", true]);
    expect((await dev("/v1/notify/digest", "PUT", { digest: "hourly" })).status).toBe(400);

    const removed = (await (
      await dev("/v1/notify/targets/discord", "DELETE")
    ).json()) as NotifySettings;
    expect(removed.targets.map((t) => t.name)).toEqual(["tgram"]);
    expect((await dev("/v1/notify/targets/discord", "DELETE")).status).toBe(404);
  });

  it("lets only owners and admins add targets that can reach any host", async () => {
    const { dev, lead } = await team();
    for (const url of [
      "json://10.0.0.5:8080/hook",
      "form://internal.local/x",
      "mailto://smtp.internal",
    ]) {
      const refused = await dev("/v1/notify/targets", "POST", { url });
      expect(refused.status, url).toBe(403);
      expect(await refused.text()).not.toContain("10.0.0.5");
    }
    expect(
      (await lead("/v1/notify/targets", "POST", { url: "json://10.0.0.5:8080/hook" })).status,
    ).toBe(201);
    // ntfy with a topic alone goes to ntfy.sh; with a host it is self-hosted.
    expect((await dev("/v1/notify/targets", "POST", { url: "ntfys://dev-alerts" })).status).toBe(
      201,
    );
    for (const url of ["ntfys://ntfy.internal/dev", "ntfy://10.0.0.5:80/dev", "ntfys://a@b/c"]) {
      expect((await dev("/v1/notify/targets", "POST", { url })).status, url).toBe(403);
    }
  });

  it("keeps each person's targets to themselves", async () => {
    const { dev, lead, admin } = await team();
    await dev("/v1/notify/targets", "POST", { url: PHONE });
    const theirs = (await (await lead("/v1/notify")).json()) as NotifySettings;
    expect(theirs.targets).toEqual([]);
    expect((await lead("/v1/notify/targets/tgram", "DELETE")).status).toBe(404);
    // The admin token is not a person and has no notification settings.
    expect((await admin("/v1/notify")).status).toBe(404);
  });

  it("sends a test through Apprise and records each send by target name", async () => {
    const { dev, apprise } = await team();
    expect((await dev("/v1/notify/test", "POST", {})).status).toBe(404);
    await dev("/v1/notify/targets", "POST", { url: PHONE, name: "phone" });
    await dev("/v1/notify/targets", "POST", { url: FAILING, name: "email" });

    const response = await dev("/v1/notify/test", "POST", {});
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toMatch(/BOTSECRET|MAILPASS/);
    const { sends } = JSON.parse(text) as { sends: { target: string; ok: boolean }[] };
    expect(sends.map((s) => [s.target, s.ok])).toEqual([
      ["phone", true],
      ["email", false],
    ]);
    expect(apprise.received.map((r) => [r.endpoint, r.title])).toEqual([
      ["http://apprise:8000/notify", "selfhost: test notification"],
      ["http://apprise:8000/notify", "selfhost: test notification"],
    ]);
    const log = await (await dev("/v1/notify/sends")).text();
    expect(log).toContain('"kind":"test"');
    expect(log).not.toMatch(/BOTSECRET|MAILPASS|fail\.example\.com/);
  });

  it("answers 503 to a test when the server has no Apprise", async () => {
    const app = createApp({ version: "1.2.3", ledger, token: TOKEN });
    const admin = caller(app, TOKEN);
    const created = (await (await admin("/v1/teams", "POST", { name: "Web" })).json()) as {
      invite: string;
    };
    const joined = (await (
      await admin("/v1/join", "POST", { invite: created.invite, person: "dev@example.com" })
    ).json()) as JoinResponse;
    const dev = caller(app, joined.token);
    await dev("/v1/notify/targets", "POST", { url: PHONE });
    expect(((await (await dev("/v1/notify")).json()) as NotifySettings).delivery).toBe("none");
    expect((await dev("/v1/notify/test", "POST", {})).status).toBe(503);
  });
});

describe("the notification job on a team server", () => {
  it("pushes a waiting agent within seconds, without waiting for the periodic passes", async () => {
    const HOUR = 60 * 60 * 1000;
    const wakeups: { refresh?: () => void; notify?: () => void } = {};
    const apprise = fakeApprise();
    const { dev } = await team(apprise, (kinds) => {
      if (kinds.some((kind) => WAITING_EVENT_KINDS.has(kind))) wakeups.refresh?.();
    });
    await dev("/v1/notify/targets", "POST", { url: PHONE, name: "phone" });
    const log = () => {};
    const reviews = startReviewRefreshJob(ledger, {
      intervalMs: HOUR,
      now: () => NOW,
      log,
      changed: () => wakeups.notify?.(),
    });
    const notify = startNotifyJob(ledger, {
      deliver: apprise.deliver,
      intervalMs: HOUR,
      wakeMs: 50,
      now: () => NOW,
      log,
    });
    wakeups.refresh = reviews.wake;
    wakeups.notify = notify.wake;
    try {
      // Both jobs' first passes, with nothing waiting yet.
      await reviews.run();
      await notify.run();
      expect(apprise.received).toEqual([]);
      const posted = Date.now();
      expect(
        (await dev("/v1/events", "POST", { events: [waiting("dev@example.com")] })).status,
      ).toBe(200);
      await vi.waitFor(
        () =>
          expect(apprise.received.map((r) => r.title)).toContain(
            "selfhost: Approval, an agent waits",
          ),
        { timeout: 5000, interval: 25 },
      );
      expect(Date.now() - posted).toBeLessThan(5000);
    } finally {
      reviews.stop();
      notify.stop();
    }
  });

  it("pushes a waiting agent to its owner and budget alerts to the team owner, with summaries only", async () => {
    const { dev, lead, apprise } = await team();
    await dev("/v1/notify/targets", "POST", { url: PHONE, name: "phone" });
    await lead("/v1/notify/targets", "POST", { url: "ntfys://lead-alerts", name: "phone" });
    const text = "version = 1\n[budget]\nmonthly_usd = 10\n";
    expect((await lead("/v1/policy", "PUT", { text })).status).toBe(200);
    expect(
      (
        await dev("/v1/events", "POST", {
          events: [cost("dev@example.com", 8), waiting("dev@example.com")],
        })
      ).status,
    ).toBe(200);
    await raiseBudgetAlerts(ledger, NOW);
    await refreshReviewList(ledger, openReviewList(ledger, { now: () => NOW }));

    const directory = serverDirectory(ledger, undefined);
    const options = {
      deliver: apprise.deliver,
      directory,
      now: NOW,
      consoleUrl: "https://selfhost.example.com",
    };
    const first = await runNotify(ledger, options);
    const byUrl = (url: string) =>
      apprise.received.filter((r) => r.urls === url).map((r) => r.title);
    expect(byUrl(PHONE)).toContain("selfhost: Approval, an agent waits");
    // Spend went straight to 80%: only that share is raised.
    expect(byUrl("ntfys://lead-alerts")).toContain("selfhost: 80% of a budget spent");
    expect(byUrl("ntfys://lead-alerts")).not.toContain("selfhost: 50% of a budget spent");
    for (const message of apprise.received) {
      expect(message.body).not.toMatch(/curl|sk-proj|Authorization/);
    }
    expect(apprise.received.find((r) => r.urls === PHONE)?.body).toContain(
      "https://selfhost.example.com/?screen=review&item=",
    );
    // A second pass sends nothing new.
    const before = apprise.received.length;
    await runNotify(ledger, options);
    expect(apprise.received.length).toBe(before);
    expect(first.failed).toBe(0);
  });

  it("sends the budget owner a daily spend digest of top spenders", async () => {
    const { dev, lead, apprise } = await team();
    await lead("/v1/notify/targets", "POST", { url: "ntfys://lead-alerts", name: "phone" });
    const text = 'version = 1\n[budget]\nmonthly_usd = 100\n[notify]\ndigest = "off"\n';
    expect((await lead("/v1/policy", "PUT", { text })).status).toBe(200);
    await dev("/v1/events", "POST", {
      events: [cost("dev@example.com", 4), cost("dev@example.com", 3)],
    });
    await lead("/v1/events", "POST", { events: [cost("lead@example.com", 1)] });

    await runNotify(ledger, {
      deliver: apprise.deliver,
      directory: serverDirectory(ledger, undefined),
      now: NOW,
    });
    const digest = apprise.received.find((r) => r.title === "selfhost: daily spend digest");
    expect(digest?.body).toContain("- web: $8.00 of $100.00 this month (8%)");
    expect(digest?.body).toContain("- dev@example.com (web): $7.00");
    expect(digest?.body).toContain("- web: $8.00 in the last 24 hours");
  });

  it("sends nothing more to a person whose access was revoked", async () => {
    const { dev, admin, apprise } = await team();
    await dev("/v1/notify/targets", "POST", { url: PHONE, name: "phone" });
    await dev("/v1/events", "POST", { events: [waiting("dev@example.com")] });
    await refreshReviewList(ledger, openReviewList(ledger, { now: () => NOW }));
    expect((await admin("/v1/teams/web/people/dev@example.com/tokens", "DELETE")).status).toBe(200);
    await runNotify(ledger, {
      deliver: apprise.deliver,
      directory: serverDirectory(ledger, undefined),
      now: NOW,
    });
    expect(apprise.received).toEqual([]);
  });

  it("sends nothing of a team to someone revoked from it who is still in another team", async () => {
    const { app, dev, lead, admin, apprise } = await team();
    const data = (await (await admin("/v1/teams", "POST", { name: "Data" })).json()) as {
      invite: string;
    };
    await admin("/v1/join", "POST", { invite: data.invite, person: "dora@example.com" });
    const invite = (await (
      await admin("/v1/teams/data/invites", "POST", { email: "dev@example.com" })
    ).json()) as { invite: string };
    const joined = (await (
      await admin("/v1/join", "POST", { invite: invite.invite, person: "dev@example.com" })
    ).json()) as JoinResponse;
    const devData = caller(app, joined.token);
    await dev("/v1/notify/targets", "POST", { url: PHONE, name: "phone" });
    // Her waiting agent in web, and an item lead's route names her for.
    await dev("/v1/events", "POST", { events: [waiting("dev@example.com")] });
    const text = 'version = 1\n[[review.routes]]\nid = "all"\nto = ["dev@example.com"]\n';
    expect((await lead("/v1/policy", "PUT", { text })).status).toBe(200);
    await lead("/v1/events", "POST", { events: [waiting("lead@example.com")] });
    await refreshReviewList(ledger, openReviewList(ledger, { now: () => NOW }));
    expect((await lead("/v1/teams/web/people/dev@example.com/tokens", "DELETE")).status).toBe(200);
    expect(
      ((await (await devData("/v1/me")).json()) as { memberships: unknown[] }).memberships,
    ).toEqual([{ team: "data", role: "member" }]);

    const directory = serverDirectory(ledger, undefined);
    expect(await directory.settingsFor("dev@example.com", "default")).toBeDefined();
    expect(await directory.teamsOf?.("dev@example.com", "default")).toEqual(["data"]);
    await runNotify(ledger, { deliver: apprise.deliver, directory, now: NOW });
    expect(apprise.received).toEqual([]);
  });
});

import { databaseOf, type Ledger, openLedger } from "@selfhost/ledger";
import type { JoinResponse, LedgerEvent, ReviewItem, ReviewItemsPage } from "@selfhost/schema";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { type ReviewRefreshJob, refreshOnStored, startReviewRefreshJob } from "../src/review.js";
import { TOKEN } from "./helpers.js";

/**
 * The server checks every allow a laptop reports under a one-time exception against the grants
 * it signed (grant-audit.ts), and a member's sync waits for the review refresh, so an owner sees
 * a block the moment the sync returns.
 */

// Relative to the run, so the items and grants are inside their deadlines whenever it runs.
const START = Date.now() - 60_000;
const at = (seconds: number) => new Date(START + seconds * 1000).toISOString();
const FINGERPRINT = "ab".repeat(32);

const ledgers: Ledger[] = [];
const jobs: ReviewRefreshJob[] = [];
afterEach(async () => {
  for (const job of jobs.splice(0)) job.stop();
  for (const ledger of ledgers.splice(0)) await ledger.close();
});

let n = 0;
const nextId = (variant: string) => {
  n += 1;
  return `019a7000-0000-7000-${variant}-${String(n).padStart(12, "0")}`;
};

/** A force push the hook blocked, with the exception it asked for, as the sync sends it. */
const blockedEvent = (exception: string): LedgerEvent => ({
  id: nextId("9000"),
  schema: "selfhost.event/v1",
  ts: at(0),
  source: "hook",
  kind: "policy.evaluated",
  actor: { kind: "system", id: "selfhost-policy" },
  agent: { vendor: "claude_code" },
  session_id: "sess-1",
  repo: "acme/web",
  tool: { name: "Bash", input_summary: "git push -f" },
  decision: {
    verdict: "block",
    by: "selfhost-policy",
    rule_id: "guard.force_push",
    mode: "enforce",
  },
  data: {
    answer: "deny",
    exception: { id: exception, fingerprint: FINGERPRINT, rules: ["guard.force_push"] },
  },
});

/**
 * The allow a laptop's hook records when a grant lets the call through, as tools/forge.mjs's
 * grant on a laptop would make it: the same fields, whoever signed the grant.
 */
const allowEvent = (
  exception: string,
  extra: { decision_event_id?: string; ts?: string; data?: Record<string, unknown> } = {},
): LedgerEvent => ({
  id: nextId("a000"),
  schema: "selfhost.event/v1",
  ts: extra.ts ?? at(120),
  source: "hook",
  kind: "policy.evaluated",
  actor: { kind: "system", id: "selfhost-policy" },
  agent: { vendor: "claude_code" },
  session_id: "sess-1",
  repo: "acme/web",
  tool: { name: "Bash", input_summary: "git push -f" },
  decision: {
    verdict: "allow",
    by: "selfhost-policy",
    rule_id: "guard.force_push",
    mode: "enforce",
  },
  data: {
    answer: "allow",
    exception: {
      id: exception,
      rules: ["guard.force_push"],
      used: true,
      approved_by: "lead@example.com",
      decision_event_id: extra.decision_event_id ?? "019a7000-0000-7000-8000-000000000999",
    },
    ...extra.data,
  },
});

async function setup() {
  const ledger = await openLedger({ dataDir: "memory://" });
  ledgers.push(ledger);
  const now = () => new Date(START + 60_000);
  const wakeups: { reviews?: ReviewRefreshJob } = {};
  const app = createApp({
    version: "1.2.3",
    ledger,
    token: TOKEN,
    now,
    eventsStored: refreshOnStored(() => wakeups.reviews),
  });
  // An hour between periodic refreshes: only the sync itself can put the item on the list.
  const reviews = startReviewRefreshJob(ledger, { intervalMs: 3_600_000, log: () => {}, now });
  jobs.push(reviews);
  await reviews.run();
  wakeups.reviews = reviews;
  const send = (path: string, init: RequestInit = {}, token = TOKEN) =>
    Promise.resolve(
      app.request(path, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(init.headers as Record<string, string>),
        },
      }),
    );
  const post = (path: string, body: unknown, token = TOKEN) =>
    send(path, { method: "POST", body: JSON.stringify(body) }, token);
  const created = (await (await post("/v1/teams", { name: "Red" })).json()) as { invite: string };
  const join = async (person: string) =>
    ((await (await post("/v1/join", { invite: created.invite, person })).json()) as JoinResponse)
      .token;
  // The first to join owns the team.
  const lead = await join("lead@example.com");
  const dev = await join("dev@example.com");
  const sync = async (events: LedgerEvent[], token = dev) => {
    const res = await post("/v1/events", { events }, token);
    expect(res.status).toBe(200);
    return res.json();
  };
  const inbox = async (token: string, owner?: string) => {
    const res = await send(
      `/v1/review-items?state=open${owner ? `&owner=${encodeURIComponent(owner)}` : ""}`,
      {},
      token,
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as ReviewItemsPage).items;
  };
  const stored = async (id: string) =>
    (
      await databaseOf(ledger).query<{ body: LedgerEvent }>(
        "SELECT body FROM events WHERE id = $1",
        [id],
      )
    )[0]?.body;
  const alerts = async () =>
    (
      await databaseOf(ledger).query<{ body: LedgerEvent }>(
        "SELECT body FROM events WHERE kind = 'alert.raised' ORDER BY ts, id",
      )
    ).map((row) => row.body);
  return { ledger, send, post, lead, dev, sync, inbox, stored, alerts };
}

describe("a member's sync with a block", () => {
  it("puts the exception item on the owner's list, with owners, before the sync returns", async () => {
    const { lead, sync, inbox } = await setup();
    const exception = nextId("8000");
    expect(await inbox(lead)).toEqual([]);
    await sync([blockedEvent(exception)]);
    const items = await inbox(lead);
    expect(items.map((item) => [item.id, item.kind])).toEqual([[exception, "exception"]]);
    expect(items[0]?.owners).toEqual(["lead@example.com"]);
  });

  it("does not wait on a refresh for a batch that opens no item", async () => {
    const { lead, sync, inbox } = await setup();
    const exception = nextId("8000");
    // An allow under an exception opens nothing: it is checked, flagged, and alerts instead.
    const plain: LedgerEvent = {
      ...allowEvent(exception),
      data: { answer: "allow" },
      decision: { verdict: "allow", by: "selfhost-policy", rule_id: "r", mode: "enforce" },
    };
    await sync([plain]);
    expect(await inbox(lead)).toEqual([]);
  });
});

describe("an allow that cites a one-time exception", () => {
  async function approvedAndUsed() {
    const s = await setup();
    const exception = nextId("8000");
    await s.sync([blockedEvent(exception)]);
    const decided = await s.post(
      `/v1/review-items/${exception}/decision`,
      { verdict: "approve" },
      s.lead,
    );
    expect(decided.status).toBe(200);
    const fetched = (await (
      await s.send(`/v1/exception-grants/${exception}`, {}, s.dev)
    ).json()) as {
      state: string;
      grant: { decision_event_id: string; nonce: string };
    };
    expect(fetched.state).toBe("granted");
    return { ...s, exception, grant: fetched.grant };
  }

  it("is stored as it came when the server signed the grant, once", async () => {
    const { exception, grant, sync, stored, alerts, post, dev } = await approvedAndUsed();
    const allow = allowEvent(exception, { decision_event_id: grant.decision_event_id });
    // The laptop reports the use on the same sync, before or after the events.
    await post(`/v1/exception-grants/${exception}/use`, { nonce: grant.nonce }, dev);
    await sync([allow]);
    expect((await stored(allow.id))?.data?.grant_unverified).toBeUndefined();
    expect(await alerts()).toEqual([]);
    // Sending the same event again is a duplicate, not a second use.
    await sync([allow]);
    expect(await alerts()).toEqual([]);

    // A second allow under the same grant: one grant lets one call through.
    const again = allowEvent(exception, { decision_event_id: grant.decision_event_id });
    await sync([again]);
    expect((await stored(again.id))?.data).toMatchObject({
      grant_unverified: true,
      grant_unverified_reason: `the grant for exception ${exception} was already used, by event ${allow.id}`,
    });
  });

  it("is kept, flagged, with an alert to the owners when the server never signed the grant", async () => {
    const { lead, dev, sync, stored, alerts, inbox, send } = await setup();
    // forge.mjs: a grant written on the laptop for an exception nobody approved.
    const exception = nextId("8000");
    await sync([blockedEvent(exception)]);
    const forged = allowEvent(exception);
    await sync([forged]);

    const kept = await stored(forged.id);
    expect(kept?.data).toMatchObject({
      answer: "allow",
      grant_unverified: true,
      grant_unverified_reason: `this server never signed a grant for exception ${exception}`,
    });
    const [alert] = await alerts();
    expect(alert).toMatchObject({
      kind: "alert.raised",
      source: "server",
      team: "red",
      data: {
        alert: "grant_unverified",
        person: "dev@example.com",
        exception_id: exception,
        event_id: forged.id,
        message:
          "An allow cited an exception the server never signed: possible forged grant on dev@example.com's laptop",
      },
    });

    // On the owners' list as soon as the sync returns, never on the person's own.
    const security = (await inbox(lead)).filter((item) => item.kind === "security");
    expect(security).toHaveLength(1);
    expect(security[0]).toMatchObject({
      title:
        "An allow cited an exception the server never signed: possible forged grant on dev@example.com's laptop",
      owners: ["lead@example.com"],
      delivery: "instant",
    } satisfies Partial<ReviewItem>);
    const theirs = await inbox(dev, "dev@example.com");
    expect(theirs.filter((item) => item.kind === "security")).toEqual([]);

    // Shown apart in the run's events, which the console's run view and tail read.
    const events = (await (await send("/v1/events?session=sess-1", {}, lead)).json()) as {
      events: LedgerEvent[];
    };
    expect(events.events.find((e) => e.id === forged.id)?.data?.grant_unverified).toBe(true);
  });

  it("is flagged when it names another approval, or comes from someone else", async () => {
    const { exception, grant, sync, stored, post } = await approvedAndUsed();
    const other = allowEvent(exception, { decision_event_id: nextId("8000") });
    await sync([other]);
    expect((await stored(other.id))?.data?.grant_unverified_reason).toMatch(
      /names a different approval/,
    );
    const created = (await (await post("/v1/teams", { name: "Blue" })).json()) as {
      invite: string;
    };
    const mallory = (
      (await (
        await post("/v1/join", { invite: created.invite, person: "mallory@example.com" })
      ).json()) as JoinResponse
    ).token;
    const copied = allowEvent(exception, { decision_event_id: grant.decision_event_id });
    await sync([copied], mallory);
    expect((await stored(copied.id))?.data?.grant_unverified_reason).toBe(
      `this server signed exception ${exception} for another person, not for mallory@example.com`,
    );
  });

  it("never takes a laptop's own grant_unverified, either way", async () => {
    const { exception, grant, sync, stored, alerts } = await approvedAndUsed();
    const claimed = allowEvent(exception, {
      decision_event_id: grant.decision_event_id,
      data: { grant_unverified: true, grant_unverified_reason: "made up" },
    });
    await sync([claimed]);
    expect((await stored(claimed.id))?.data?.grant_unverified).toBeUndefined();
    expect((await stored(claimed.id))?.data?.grant_unverified_reason).toBeUndefined();
    expect(await alerts()).toEqual([]);

    // A laptop cannot clear the flag on a forged one either.
    const forged = allowEvent(nextId("8000"), { data: { grant_unverified: false } });
    await sync([forged]);
    expect((await stored(forged.id))?.data?.grant_unverified).toBe(true);
  });
});

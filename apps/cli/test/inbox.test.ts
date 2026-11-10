import { existsSync, readFileSync, statSync } from "node:fs";
import { type Ledger, openLedger } from "@selfhost/ledger";
import {
  EVENT_SCHEMA,
  type LedgerEvent,
  REVIEW_ITEM_SCHEMA,
  type ReviewItem,
  validateReviewItem,
} from "@selfhost/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderStatusline, type StatuslineCache, writeCache } from "../src/alerts/cache.js";
import { type InboxIo, runInboxDecide, runInboxOpen, snoozeUntil } from "../src/inbox/commands.js";
import type { ReviewList } from "../src/inbox/review-list.js";
import { inboxPaths, readInboxCache, readQueue, writeInboxCache } from "../src/inbox/store.js";
import { startInboxRefresh } from "../src/inbox/sync.js";
import { shortIds } from "../src/inbox/text.js";
import { createProgram } from "../src/program.js";
import type { Fetch } from "../src/team/client.js";
import { saveMembership } from "../src/team/config.js";
import { blockNetwork } from "./network.js";
import { run, tempDir } from "./run.js";

const SERVER = "http://team.test";
const TOKEN = "selfhost_person_token";
const PERSON = "dev@example.com";
const BOB = "bob@example.com";
const NOW = new Date("2026-11-08T12:00:00.000Z");

const id = (n: number, prefix = "019a5b00") =>
  `${prefix}-2f1a-7b2c-8d3e-${String(n).padStart(12, "0")}`;

function item(n: number, overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: id(n, `019a5b${String(n).padStart(2, "0")}`),
    schema: REVIEW_ITEM_SCHEMA,
    kind: "approval",
    title: `Item ${n}`,
    created_at: new Date(NOW.getTime() - n * 3_600_000).toISOString(),
    updated_at: new Date(NOW.getTime() - n * 3_600_000).toISOString(),
    state: "open",
    blocking: false,
    risk: { score: 10 * n, reasons: [`reason ${n}`] },
    owners: [PERSON],
    source_event_ids: [],
    ...overrides,
  };
}

class NotOpen extends Error {
  constructor(readonly item: ReviewItem) {
    super(`${item.id} is not open`);
  }
}

class NotFound extends Error {}

/** The review list, in memory: what the engine does, small enough to read. */
class FakeList implements ReviewList {
  readonly items = new Map<string, ReviewItem>();
  readonly decisions: LedgerEvent[] = [];
  readonly snoozes: { id: string; by: string; until: string }[] = [];
  private counter = 0;

  constructor(items: ReviewItem[]) {
    for (const entry of items) this.items.set(entry.id, entry);
  }

  async list(query: { state?: string; owner?: string; limit?: number; cursor?: string }) {
    const ranked = [...this.items.values()]
      .filter((entry) => entry.state === (query.state ?? "open"))
      .filter((entry) => query.owner === undefined || entry.owners.includes(query.owner))
      .sort(
        (a, b) =>
          Number(b.blocking) - Number(a.blocking) ||
          b.risk.score - a.risk.score ||
          a.created_at.localeCompare(b.created_at),
      );
    const start = Number(query.cursor ?? 0);
    const end = start + (query.limit ?? 100);
    return {
      items: ranked.slice(start, end),
      next_cursor: end < ranked.length ? String(end) : null,
    };
  }

  async get(itemId: string) {
    return this.items.get(itemId);
  }

  async decide(
    itemId: string,
    input: { verdict: "approve" | "deny" | "answer" | "override"; by: string; reason?: string },
  ) {
    const current = this.items.get(itemId);
    if (!current) throw new NotFound(itemId);
    if (current.state !== "open") throw new NotOpen(current);
    const eventId = `019a6000-0000-7000-8000-${String(++this.counter).padStart(12, "0")}`;
    const at = NOW.toISOString();
    const reason = input.reason === undefined ? {} : { reason: input.reason };
    const event: LedgerEvent = {
      id: eventId,
      schema: EVENT_SCHEMA,
      ts: at,
      source: "cli",
      kind: "decision.recorded",
      actor: { kind: "person", id: input.by },
      decision: { verdict: input.verdict, by: input.by, item_id: itemId, ...reason },
    };
    const answered: ReviewItem = {
      ...current,
      state: "answered",
      answer: { by: input.by, verdict: input.verdict, at, decision_event_id: eventId, ...reason },
    };
    this.items.set(itemId, answered);
    this.decisions.push(event);
    return { item: answered, decision_event: event };
  }

  async snooze(itemId: string, input: { by: string; until: string }) {
    const current = this.items.get(itemId);
    if (!current) throw new NotFound(itemId);
    if (current.state !== "open") throw new NotOpen(current);
    this.snoozes.push({ id: itemId, ...input });
    return current;
  }
}

/**
 * The team server's review list API as the contract in openapi.yaml shapes it, in process: the
 * token's person decides, and an item that is not open answers 409 with the item.
 */
function teamServer(list: FakeList) {
  const calls: string[] = [];
  const state = { online: true };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetch: Fetch = async (url, init) => {
    const method = init.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (!state.online) throw new TypeError("fetch failed");
    const headers = init.headers as Record<string, string>;
    if (headers.authorization !== `Bearer ${TOKEN}`) {
      return json(401, { error: { code: "unauthorized", message: "bad token" } });
    }
    const { pathname, searchParams } = new URL(url);
    if (method === "GET" && pathname === "/v1/review-items") {
      const limit = searchParams.get("limit");
      return json(
        200,
        await list.list({
          state: searchParams.get("state") ?? undefined,
          owner: searchParams.get("owner") ?? undefined,
          limit: limit === null ? undefined : Number(limit),
          cursor: searchParams.get("cursor") ?? undefined,
        }),
      );
    }
    const route = /^\/v1\/review-items\/([^/]+)\/(decision|snooze)$/.exec(pathname);
    if (method === "POST" && route) {
      const itemId = decodeURIComponent(route[1] ?? "");
      const body = JSON.parse(String(init.body));
      try {
        if (route[2] === "decision") {
          expect(Object.keys(body).every((key) => key === "verdict" || key === "reason")).toBe(
            true,
          );
          return json(200, await list.decide(itemId, { ...body, by: PERSON }));
        }
        return json(200, { item: await list.snooze(itemId, { by: PERSON, until: body.until }) });
      } catch (error) {
        if (error instanceof NotOpen) {
          return json(409, {
            error: { code: "not_open", message: error.message },
            item: error.item,
          });
        }
        if (error instanceof NotFound) {
          return json(404, { error: { code: "not_found", message: "no such review item" } });
        }
        throw error;
      }
    }
    return json(404, { error: { code: "not_found", message: `${method} ${pathname}` } });
  };
  return { calls, state, fetch };
}

function laptop() {
  const home = tempDir("inbox-home");
  return { home, configPath: home.path(".selfhost", "config.json") };
}

function joined() {
  const machine = laptop();
  saveMembership(machine.configPath, { server: SERVER, token: TOKEN, person: PERSON, team: "t1" });
  return machine;
}

const parse = (out: string) => JSON.parse(out);

/** A fresh statusline cache, so the statusline never opens a ledger in these tests. */
const SPEND: StatuslineCache = {
  schema: "selfhost.statusline/v1",
  written_at: "2026-11-08T11:59:00.000Z",
  pid: null,
  person: PERSON,
  today: { day: "2026-11-08", usd: 12.345 },
  warnings: [],
  alarms: [],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("commands", () => {
  it("adds inbox with approve, deny, snooze, open and sync", () => {
    const inbox = createProgram().commands.find((command) => command.name() === "inbox");
    expect(inbox?.commands.map((command) => command.name())).toEqual([
      "approve",
      "deny",
      "snooze",
      "open",
      "sync",
    ]);
    for (const command of [inbox, ...(inbox?.commands ?? [])]) {
      expect(command?.options.map((option) => option.long)).toContain("--json");
    }
  });
});

describe("selfhost inbox in team mode", () => {
  it("lists the caller's open items, ranked, with ids short enough to type", async () => {
    blockNetwork();
    const list = new FakeList([
      item(1),
      item(2, { blocking: true, repo: "acme/api" }),
      item(3, { owners: [BOB] }),
      item(4, { state: "dismissed" }),
    ]);
    for (const entry of list.items.values()) expect(validateReviewItem(entry).ok).toBe(true);
    const server = teamServer(list);
    const { configPath } = joined();
    const deps = { configPath, fetch: server.fetch, now: NOW };

    const json = await run(["inbox", "--json"], deps);
    expect(json.code).toBe(0);
    const report = parse(json.out);
    expect(report).toMatchObject({
      schema: "selfhost.inbox/v1",
      mode: "team",
      person: PERSON,
      offline: false,
      as_of: NOW.toISOString(),
      queued: [],
    });
    expect(report.items.map((entry: ReviewItem) => entry.title)).toEqual(["Item 2", "Item 1"]);
    expect(server.calls).toEqual([
      `GET ${SERVER}/v1/review-items?state=open&owner=dev%40example.com&limit=1000`,
    ]);

    const text = await run(["inbox"], deps);
    expect(text.out).toContain("2 items to review, 1 blocking:");
    expect(text.out).toMatch(/\n00000002 +approval, blocking +20 +2h00m +Item 2 \(acme\/api\)/);

    const all = parse((await run(["inbox", "--all", "--json"], deps)).out);
    expect(all.items.map((entry: ReviewItem) => entry.title)).toEqual([
      "Item 2",
      "Item 3",
      "Item 1",
    ]);
  });

  it("review list reads the team server's list, the one inbox reads", async () => {
    blockNetwork();
    const list = new FakeList([
      item(1),
      item(2, { owners: [BOB] }),
      item(3, { state: "dismissed" }),
    ]);
    const server = teamServer(list);
    const { configPath } = joined();
    const result = await run(["review", "list", "--json"], {
      configPath,
      fetch: server.fetch,
      now: NOW,
    });
    expect(result.err).toBe("");
    const report = parse(result.out);
    expect(report).toMatchObject({ schema: "selfhost.review_list/v1", source: "server" });
    expect(report.items.map((entry: ReviewItem) => entry.title).sort()).toEqual([
      "Item 1",
      "Item 2",
    ]);
    expect(server.calls).toEqual([`GET ${SERVER}/v1/review-items?state=open`]);
  });

  it("approves and denies by id prefix; the server records each decision once", async () => {
    blockNetwork();
    const list = new FakeList([item(1), item(2)]);
    const server = teamServer(list);
    const { configPath } = joined();
    const deps = { configPath, fetch: server.fetch, now: NOW };
    await run(["inbox", "--json"], deps);

    const approve = await run(["inbox", "approve", "019a5b01", "--reason", "fine", "--json"], deps);
    expect(approve.code).toBe(0);
    expect(parse(approve.out)).toMatchObject({
      schema: "selfhost.inbox_action/v1",
      action: "approve",
      item_id: item(1).id,
      outcome: "applied",
      item: { state: "answered", answer: { by: PERSON, verdict: "approve", reason: "fine" } },
      decision_event: { kind: "decision.recorded", decision: { verdict: "approve" } },
      queued: null,
    });

    const deny = await run(["inbox", "deny", item(2).id], deps);
    expect(deny.code).toBe(0);
    expect(deny.out).toContain(`Denied ${item(2).id}: Item 2.`);
    expect(list.decisions.map((event) => event.decision?.verdict)).toEqual(["approve", "deny"]);
    expect(list.decisions[1]?.decision).not.toHaveProperty("reason");

    // The saved copy follows, so the statusline count drops without another list.
    const cache = readInboxCache(inboxPaths(configPath).cache, { server: SERVER, team: "t1" });
    expect(cache?.items.every((entry) => entry.state === "answered")).toBe(true);
  });

  it("reports an item someone else answered and changes nothing", async () => {
    blockNetwork();
    const list = new FakeList([item(1)]);
    await list.decide(item(1).id, { verdict: "deny", by: BOB });
    const server = teamServer(list);
    const { configPath } = joined();

    const result = await run(["inbox", "approve", item(1).id, "--json"], {
      configPath,
      fetch: server.fetch,
      now: NOW,
    });
    expect(result.code).toBe(1);
    expect(parse(result.out)).toEqual({
      schema: "selfhost.error/v1",
      error: `${item(1).id} was already answered by ${BOB}: deny. Nothing changed.`,
    });
    expect(list.decisions).toHaveLength(1);
  });

  it("refuses a prefix that matches more than one item, or none", async () => {
    blockNetwork();
    const twins = [item(1), { ...item(2), id: id(2, "019a5b01") }];
    const server = teamServer(new FakeList(twins));
    const deps = { configPath: joined().configPath, fetch: server.fetch, now: NOW };

    const ambiguous = await run(["inbox", "approve", "019a5b01", "--json"], deps);
    expect(parse(ambiguous.out).error).toMatch(/matches 2 of your items, type more of the id/);
    expect((await run(["inbox", "deny", "ffff"], deps)).err).toBe(
      "No open item on the list starts or ends with ffff",
    );
    expect(shortIds(twins.map((entry) => entry.id))).toEqual(
      new Map([
        [twins[0]?.id, "00000001"],
        [twins[1]?.id, "00000002"],
      ]),
    );
  });

  it("shows the random tail of each id, takes a start or an end, and never picks another person's item", async () => {
    blockNetwork();
    // UUIDv7 ids made the same minute share their first 8 characters.
    const uuid = (tail: string) => `01a1c46c-2f1a-7b2c-8d3e-${tail}`;
    const mine = item(1, { id: uuid("4938aa3a90f5") });
    const bobs = item(2, { id: uuid("77aa00c1b2d3"), owners: [BOB] });
    const bobs2 = item(3, { id: uuid("1100ffee0042"), owners: [BOB] });
    const list = new FakeList([mine, bobs, bobs2]);
    const server = teamServer(list);
    const deps = { configPath: joined().configPath, fetch: server.fetch, now: NOW };

    const text = await run(["inbox"], deps);
    expect(text.out).toMatch(/\naa3a90f5 +approval/);
    expect(text.out).not.toContain("01a1c46c");

    // The shown tail works, and so does the shared start, which only one of the caller's has.
    const bySuffix = parse((await run(["inbox", "open", "aa3a90f5", "--json"], deps)).out);
    expect(bySuffix.item.id).toBe(mine.id);
    const approve = await run(["inbox", "approve", "01a1c46c", "--json"], deps);
    expect(parse(approve.out)).toMatchObject({ item_id: mine.id, outcome: "applied" });

    // Now only Bob's two match: neither id is printed to someone who cannot answer them.
    const theirs = await run(["inbox", "approve", "01a1c46c"], deps);
    expect(theirs.code).toBe(1);
    expect(theirs.err).toContain("matches 2 items, none of them yours to answer");
    expect(theirs.err).not.toContain(bobs.id);
    expect(theirs.err).not.toContain(bobs2.id);
    expect(list.decisions).toHaveLength(1);
  });

  it("snoozes an item off the list until later", async () => {
    blockNetwork();
    const list = new FakeList([item(1), item(2)]);
    const server = teamServer(list);
    const { configPath } = joined();
    const deps = { configPath, fetch: server.fetch, now: NOW };

    const snooze = await run(["inbox", "snooze", "019a5b01", "--for", "2h", "--json"], deps);
    expect(parse(snooze.out)).toMatchObject({ action: "snooze", outcome: "applied" });
    expect(list.snoozes).toEqual([
      { id: item(1).id, by: PERSON, until: "2026-11-08T14:00:00.000Z" },
    ]);

    // The server still lists it as open; this machine hides it until the snooze ends.
    const listed = parse((await run(["inbox", "--json"], deps)).out);
    expect(listed.items.map((entry: ReviewItem) => entry.id)).toEqual([item(2).id]);
    const all = parse((await run(["inbox", "--all", "--json"], deps)).out);
    expect(all.items).toHaveLength(2);
    const later = parse(
      (await run(["inbox", "--json"], { ...deps, now: new Date("2026-11-08T14:00:01Z") })).out,
    );
    expect(later.items).toHaveLength(2);
  });

  it("opens an item with its brief", async () => {
    blockNetwork();
    const brief = "## What changed\n\nThe agent wants to push to main.";
    const list = new FakeList([item(1, { brief, url: "https://github.com/acme/api/pull/7" })]);
    const server = teamServer(list);
    const deps = { configPath: joined().configPath, fetch: server.fetch, now: NOW };

    const json = parse((await run(["inbox", "open", "019a5b01", "--json"], deps)).out);
    expect(json).toMatchObject({
      schema: "selfhost.inbox_item/v1",
      item: { id: item(1).id, brief },
      offline: false,
      opened: false,
    });
    const text = await run(["inbox", "open", "019a5b01", "--no-open"], deps);
    expect(text.out).toContain("Item 1");
    expect(text.out).toContain("Link: https://github.com/acme/api/pull/7");
    expect(text.out).toContain("The agent wants to push to main.");
  });
});

describe("selfhost inbox open in a terminal", () => {
  const io = (configPath: string, fetch: Fetch, isTTY: boolean) => {
    const lines: string[] = [];
    const openUrl = vi.fn();
    const inboxIo: InboxIo = {
      env: {},
      platform: "linux",
      write: (line) => lines.push(line),
      setExitCode: () => {},
      now: NOW,
      configPath,
      fetch,
      isTTY,
      openUrl,
    };
    return { inboxIo, openUrl, lines };
  };

  it("opens a web link only on a terminal, without --no-open or --json", async () => {
    const url = "https://github.com/acme/api/pull/7";
    const server = teamServer(new FakeList([item(1, { url }), item(2, { url: "file:///etc" })]));
    const { configPath } = joined();

    const tty = io(configPath, server.fetch, true);
    expect((await runInboxOpen("019a5b01", {}, tty.inboxIo)).opened).toBe(true);
    expect(tty.openUrl).toHaveBeenCalledWith(url);
    await runInboxOpen("019a5b01", { open: false }, tty.inboxIo);
    await runInboxOpen("019a5b01", { json: true }, tty.inboxIo);
    await runInboxOpen("019a5b02", {}, tty.inboxIo);
    expect(tty.openUrl).toHaveBeenCalledTimes(1);

    const piped = io(configPath, server.fetch, false);
    await runInboxOpen("019a5b01", {}, piped.inboxIo);
    expect(piped.openUrl).not.toHaveBeenCalled();
  });
});

describe("offline", () => {
  it("reads the saved copy, queues actions and replays them on reconnect", async () => {
    blockNetwork();
    const list = new FakeList([item(1), item(2), item(3, { blocking: true })]);
    const server = teamServer(list);
    const { home, configPath } = joined();
    const paths = inboxPaths(configPath);
    const statusline = home.path(".selfhost", "statusline.json");
    writeCache(statusline, SPEND);
    const deps = { configPath, fetch: server.fetch, now: NOW };
    await run(["inbox", "--json"], { ...deps, now: new Date("2026-11-08T11:00:00Z") });

    server.state.online = false;
    const offline = parse((await run(["inbox", "--json"], deps)).out);
    expect(offline).toMatchObject({
      offline: true,
      as_of: "2026-11-08T11:00:00.000Z",
      queued: [],
    });
    expect(offline.items).toHaveLength(3);
    const text = await run(["inbox"], deps);
    expect(text.out).toContain(
      `Offline: Could not reach ${SERVER}: fetch failed. Showing the copy saved 11:00 UTC (1h00m ago).`,
    );

    const approve = await run(["inbox", "approve", "019a5b01", "--reason", "ok", "--json"], deps);
    expect(approve.code).toBe(0);
    expect(parse(approve.out)).toMatchObject({
      outcome: "queued",
      item_id: item(1).id,
      queued: { action: "approve", reason: "ok", by: PERSON, server: SERVER, team: "t1" },
    });
    const deny = await run(["inbox", "deny", "019a5b02"], deps);
    expect(deny.out).toContain("Queued deny 00000002, sent when http://team.test answers");
    expect(readQueue(paths.queue).map((entry) => entry.action)).toEqual(["approve", "deny"]);

    // Queued answers leave the list and the statusline count right away.
    const queued = parse((await run(["inbox", "--json"], deps)).out);
    expect(queued.items.map((entry: ReviewItem) => entry.id)).toEqual([item(3).id]);
    expect(queued.queued).toHaveLength(2);
    expect((await run(["statusline", "--cache", statusline], deps)).out).toBe(
      "1 to review, 1 blocking · $12.35 today",
    );

    // While offline, Bob answers item 2 on the server.
    await list.decide(item(2).id, { verdict: "approve", by: BOB });

    server.state.online = true;
    const sync = await run(["inbox", "sync", "--json"], deps);
    expect(sync.code).toBe(0);
    const report = parse(sync.out);
    expect(report).toMatchObject({
      schema: "selfhost.inbox_sync/v1",
      offline: false,
      remaining: 0,
    });
    expect(
      report.results.map((entry: { outcome: string; message: string }) => [
        entry.outcome,
        entry.message,
      ]),
    ).toEqual([
      ["applied", "approve"],
      ["conflict", `already answered by ${BOB}: approve`],
    ]);
    // Bob's answer stands; the queued deny was not applied.
    expect(list.items.get(item(2).id)?.answer).toMatchObject({ by: BOB, verdict: "approve" });
    expect(list.decisions.map((event) => event.actor.id)).toEqual([BOB, PERSON]);
    expect(existsSync(paths.queue)).toBe(false);
  });

  it("replays on the next inbox command and reports a conflict in text", async () => {
    blockNetwork();
    const list = new FakeList([item(1)]);
    const server = teamServer(list);
    const { configPath } = joined();
    const deps = { configPath, fetch: server.fetch, now: NOW };
    await run(["inbox"], deps);
    server.state.online = false;
    await run(["inbox", "approve", "019a5b01"], deps);
    await list.decide(item(1).id, { verdict: "deny", by: BOB });
    server.state.online = true;

    const listed = await run(["inbox"], deps);
    expect(listed.out).toContain(
      `Not applied: approve 00000001, already answered by ${BOB}: deny.`,
    );
    expect(listed.out).toContain("Nothing to review.");
  });

  it("keeps the queue in order while the server stays down", async () => {
    blockNetwork();
    const server = teamServer(new FakeList([item(1)]));
    const { configPath } = joined();
    const deps = { configPath, fetch: server.fetch, now: NOW };
    await run(["inbox"], deps);
    server.state.online = false;
    await run(["inbox", "snooze", "019a5b01", "--until", "2026-11-09T09:00:00Z"], deps);

    const sync = await run(["inbox", "sync", "--json"], deps);
    expect(sync.code).toBe(1);
    expect(parse(sync.out)).toMatchObject({
      offline: true,
      remaining: 1,
      error: `Could not reach ${SERVER}: fetch failed`,
    });
    expect(readQueue(inboxPaths(configPath).queue)).toHaveLength(1);
  });

  it("says so when there is no saved copy yet", async () => {
    blockNetwork();
    const server = teamServer(new FakeList([item(1)]));
    server.state.online = false;
    const result = await run(["inbox", "--json"], {
      configPath: joined().configPath,
      fetch: server.fetch,
      now: NOW,
    });
    expect(result.code).toBe(1);
    expect(parse(result.out).error).toMatch(/no saved copy of the review list yet/);
  });
});

describe("selfhost inbox in solo mode", () => {
  let ledger: Ledger | undefined;

  afterEach(async () => {
    await ledger?.close();
    ledger = undefined;
  });

  it("acts on the local list, which writes the decision; the CLI writes nothing itself", async () => {
    const attempts = blockNetwork();
    ledger = await openLedger({ dataDir: "memory://" });
    const list = new FakeList([item(1)]);
    const { configPath } = laptop();
    const lines: string[] = [];
    const io: InboxIo = {
      env: { SELFHOST_PERSON: PERSON },
      platform: "linux",
      write: (line) => lines.push(line),
      setExitCode: () => {},
      now: NOW,
      configPath,
      fetch: vi.fn(),
      localReviewList: (opened) => {
        expect(opened).toBe(ledger);
        return list;
      },
    };

    const report = await runInboxDecide("deny", "019a5b01", { reason: "no" }, io, ledger);
    expect(report.outcome).toBe("applied");
    expect(list.decisions).toHaveLength(1);
    expect(list.decisions[0]?.actor.id).toBe(PERSON);
    expect((await ledger.query({ kind: "decision.recorded" })).events).toEqual([]);
    expect(io.fetch).not.toHaveBeenCalled();
    expect(attempts).toEqual([]);
  });

  it("works through the command line with --json", async () => {
    const attempts = blockNetwork();
    const list = new FakeList([item(1), item(2)]);
    const deps = {
      configPath: laptop().configPath,
      env: { SELFHOST_PERSON: PERSON },
      now: NOW,
      localReviewList: () => list,
    };
    const listed = parse((await run(["inbox", "--json", "--data-dir", "memory://"], deps)).out);
    expect(listed).toMatchObject({ mode: "solo", person: PERSON, offline: false });
    expect(listed.items).toHaveLength(2);
    expect(attempts).toEqual([]);
  });

  it("reads the local review list from the ledger by default", async () => {
    const attempts = blockNetwork();
    const result = await run(["inbox", "--json", "--data-dir", "memory://"], {
      configPath: laptop().configPath,
      env: { SELFHOST_PERSON: PERSON },
      now: NOW,
    });
    expect(parse(result.out)).toMatchObject({ mode: "solo", person: PERSON, items: [] });
    expect(attempts).toEqual([]);
  });

  it("queues while import --watch holds the ledger, and the watcher applies the queue", async () => {
    const attempts = blockNetwork();
    const list = new FakeList([item(1), item(2)]);
    const { configPath } = laptop();
    const paths = inboxPaths(configPath);
    const scope = { server: null, team: null, person: PERSON };
    // What a running watcher saved; this process stands in for it.
    writeInboxCache(paths.cache, {
      schema: "selfhost.inbox_cache/v1",
      written_at: NOW.toISOString(),
      pid: process.pid,
      ...scope,
      all: false,
      items: [item(1), item(2)],
      snoozed: {},
    });
    const localReviewList = vi.fn(() => list);
    const deps = { configPath, env: { SELFHOST_PERSON: PERSON }, now: NOW, localReviewList };

    const queued = await run(["inbox", "approve", "019a5b02", "--json"], deps);
    expect(parse(queued.out)).toMatchObject({ outcome: "queued", queued: { server: null } });
    expect(localReviewList).not.toHaveBeenCalled();
    const text = await run(["inbox", "deny", "019a5b01"], deps);
    expect(text.out).toContain("sent by selfhost import --watch within a minute");

    const lines: string[] = [];
    const refresh = await startInboxRefresh({
      list,
      scope,
      configPath,
      write: (line) => lines.push(line),
      now: () => NOW,
    });
    await refresh.close();
    expect(lines).toEqual(["Synced queued approve 00000002.", "Synced queued deny 00000001."]);
    expect(list.decisions.map((event) => event.decision?.verdict)).toEqual(["approve", "deny"]);
    expect(readQueue(paths.queue)).toEqual([]);
    expect(readInboxCache(paths.cache, scope)).toMatchObject({ pid: process.pid, items: [] });
    expect(attempts).toEqual([]);
  });
});

describe("selfhost statusline with the review count", () => {
  const spend = SPEND;

  it("leads with the pending count, after a stolen key alarm", () => {
    expect(renderStatusline(spend, NOW, "3 to review")).toBe("3 to review · $12.35 today");
    const warning = {
      plan: "claude" as const,
      window: "session" as const,
      status: "warn" as const,
      run_out: "2026-11-08T13:40:00.000Z",
      window_end: "2026-11-08T16:00:00.000Z",
      fix: "overflow to team-overflow",
    };
    expect(renderStatusline({ ...spend, warnings: [warning] }, NOW, "3 to review")).toBe(
      "3 to review · Claude 5h limit in ~1h40m · overflow to team-overflow",
    );
    const alarm = {
      slot_start: "2026-11-08T11:30:00.000Z",
      slot_end: "2026-11-08T11:45:00.000Z",
      usd: 40,
      on: "key team-key",
    };
    expect(renderStatusline({ ...spend, alarms: [alarm] }, NOW, "3 to review")).toBe(
      "selfhost: possible stolen key, $40.00 in 15 min on key team-key · 3 to review",
    );
  });

  it("counts from the saved copy with no network call on render", async () => {
    const attempts = blockNetwork();
    const fetch = vi.fn();
    const { home, configPath } = joined();
    const cache = home.path(".selfhost", "statusline.json");
    writeCache(cache, spend);
    const saved = (writtenAt: string) =>
      writeInboxCache(inboxPaths(configPath).cache, {
        schema: "selfhost.inbox_cache/v1",
        written_at: writtenAt,
        pid: null,
        server: SERVER,
        team: "t1",
        person: PERSON,
        all: false,
        items: [item(1), item(2, { blocking: true })],
        snoozed: {},
      });
    const deps = { configPath, fetch, now: NOW };

    saved("2026-11-08T11:00:00.000Z");
    const line = await run(["statusline", "--cache", cache], deps);
    expect(line.out).toBe("2 to review, 1 blocking · $12.35 today");

    // A copy from days ago with no watcher keeping it is left off.
    saved("2026-11-06T11:00:00.000Z");
    expect((await run(["statusline", "--cache", cache], deps)).out).toBe("selfhost: $12.35 today");

    expect(fetch).not.toHaveBeenCalled();
    expect(attempts).toEqual([]);
  });
});

describe("snooze times", () => {
  it("takes --for or --until, in the future", () => {
    expect(snoozeUntil({}, NOW)).toBe("2026-11-08T13:00:00.000Z");
    expect(snoozeUntil({ for: "1w" }, NOW)).toBe("2026-11-15T12:00:00.000Z");
    expect(snoozeUntil({ until: "2026-11-09T09:00:00Z" }, NOW)).toBe("2026-11-09T09:00:00.000Z");
    expect(() => snoozeUntil({ for: "2 hours" }, NOW)).toThrow(/--for: expected a duration/);
    expect(() => snoozeUntil({ for: "0h" }, NOW)).toThrow(/--for/);
    expect(() => snoozeUntil({ until: "2026-11-01T00:00:00Z" }, NOW)).toThrow(/not in the future/);
    expect(() => snoozeUntil({ for: "1h", until: "2026-11-09" }, NOW)).toThrow(/not both/);
  });
});

it("keeps the queue file private", async () => {
  blockNetwork();
  const server = teamServer(new FakeList([item(1)]));
  const { configPath } = joined();
  const deps = { configPath, fetch: server.fetch, now: NOW };
  await run(["inbox"], deps);
  server.state.online = false;
  await run(["inbox", "approve", item(1).id], deps);
  const queue = inboxPaths(configPath).queue;
  expect(readFileSync(queue, "utf8")).not.toContain(TOKEN);
  expect(statSync(queue).mode & 0o777).toBe(0o600);
});

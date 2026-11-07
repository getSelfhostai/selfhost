import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Ledger, mapClaudeCodeHook, openLedger } from "@selfhost/ledger";
import { openReviewList, refreshReviewList } from "@selfhost/review";
import {
  type ApiError,
  createValidator,
  type DecisionResponse,
  DecisionResponseSchema,
  type JoinResponse,
  type LedgerEvent,
  type ReviewItem,
  type ReviewItemConflict,
  ReviewItemConflictSchema,
  ReviewItemSchema,
  type ReviewItemsPage,
  ReviewItemsPageSchema,
} from "@selfhost/schema";
import type { Hono } from "hono";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { startReviewRefreshJob } from "../src/review.js";
import { TOKEN } from "./helpers.js";

const NOW = "2026-11-10T10:00:00.000Z";
const notification = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "fixtures",
      "hooks",
      "claude-code",
      "Notification.json",
    ),
    "utf8",
  ),
) as Record<string, unknown>;

const minutes = (n: number) => new Date(Date.parse(NOW) + n * 60_000).toISOString();

/** A Claude Code permission prompt in its own session: one blocking approval. */
const approval = (session: string, person: string, ts = NOW): LedgerEvent[] =>
  mapClaudeCodeHook({ ...notification, session_id: session }, { ts, person });

const DATABASE_URL = process.env.DATABASE_URL;

/** PGlite in memory always; real Postgres when DATABASE_URL is set, in a schema of its own. */
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

const matches = (schema: Parameters<typeof createValidator>[0], body: unknown) => {
  const result = createValidator(schema).validate(body);
  expect(result.ok ? [] : result.errors).toEqual([]);
};

describe.each(BACKENDS)("review items API on $name", (backend) => {
  const opened: { close(): Promise<void> }[] = [];

  afterEach(async () => {
    for (const store of opened.splice(0)) await store.close();
  });

  async function setup() {
    const store = await backend.open();
    opened.push(store);
    let clock = new Date(NOW);
    const now = () => clock;
    const app: Hono = createApp({ version: "1.2.3", ledger: store.ledger, token: TOKEN, now });
    const cli = openReviewList(store.ledger, { now });
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
    return {
      ledger: store.ledger,
      cli,
      send,
      post: (path: string, body: unknown, token = TOKEN) =>
        send(path, { method: "POST", body: JSON.stringify(body) }, token),
      refresh: () => refreshReviewList(store.ledger, cli),
      setNow(time: string) {
        clock = new Date(time);
      },
    };
  }

  const page = async (res: Response) => {
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReviewItemsPage;
    matches(ReviewItemsPageSchema, body);
    return body.items;
  };

  const decisions = async (ledger: Ledger) =>
    (await ledger.query({ kind: "decision.recorded", limit: 1000 })).events;

  describe.skipIf(backend.skip)("with the admin token", () => {
    it("lists, opens, answers and snoozes, and refuses an item that is not open with 409", async () => {
      const { ledger, send, post, refresh } = await setup();
      await ledger.append([
        ...approval("s-1", "ada@example.com"),
        ...approval("s-2", "bob@example.com", minutes(1)),
      ]);
      await refresh();
      const [first, second] = await page(await send("/v1/review-items"));
      expect([first?.session_id, second?.session_id]).toEqual(["s-1", "s-2"]);

      const opened = await send(`/v1/review-items/${first?.id}`);
      expect(opened.status).toBe(200);
      matches(ReviewItemSchema, await opened.json());
      expect((await send("/v1/review-items/01930c4e-2f1a-7b2c-8d3e-4f5a6b7c8d40")).status).toBe(
        404,
      );

      const noBy = await post(`/v1/review-items/${first?.id}/decision`, { verdict: "approve" });
      expect(noBy.status).toBe(400);
      expect(((await noBy.json()) as ApiError).error.message).toBe(
        "by: Required with the admin token",
      );

      const decided = await post(`/v1/review-items/${first?.id}/decision`, {
        verdict: "approve",
        by: "ada@example.com",
        reason: "Read-only command",
      });
      expect(decided.status).toBe(200);
      const body = (await decided.json()) as DecisionResponse;
      matches(DecisionResponseSchema, body);
      expect(body.item).toMatchObject({
        state: "answered",
        answer: { by: "ada@example.com", verdict: "approve" },
      });
      expect(body.decision_event).toMatchObject({
        kind: "decision.recorded",
        source: "server",
        decision: { item_id: first?.id, reason: "Read-only command" },
        data: { surface: "api" },
      });

      const again = await post(`/v1/review-items/${first?.id}/decision`, {
        verdict: "deny",
        by: "bob@example.com",
      });
      expect(again.status).toBe(409);
      const conflict = (await again.json()) as ReviewItemConflict;
      matches(ReviewItemConflictSchema, conflict);
      expect(conflict).toEqual({
        error: { code: "not_open", message: "This item is answered, not open" },
        item: body.item,
      });
      expect(await decisions(ledger)).toHaveLength(1);
      expect(
        (await post(`/v1/review-items/${first?.id}/snooze`, { until: minutes(30), by: "x" }))
          .status,
      ).toBe(409);

      const snoozed = await post(`/v1/review-items/${second?.id}/snooze`, {
        until: minutes(30),
        by: "bob@example.com",
      });
      expect(snoozed.status).toBe(200);
      expect(((await snoozed.json()) as ReviewItem).snoozed_until).toBe(minutes(30));

      expect(
        (await page(await send("/v1/review-items?state=answered"))).map((item) => item.id),
      ).toEqual([first?.id]);
      expect((await send("/v1/review-items?state=closed")).status).toBe(400);
      expect((await send("/v1/review-items?sort=risk")).status).toBe(400);
      expect((await send("/v1/review-items?cursor=nope")).status).toBe(400);
      expect(
        (await post(`/v1/review-items/${second?.id}/decision`, { verdict: "maybe", by: "x" }))
          .status,
      ).toBe(400);
      expect(
        (await post(`/v1/review-items/${second?.id}/snooze`, { until: "soon", by: "x" })).status,
      ).toBe(400);
    });

    it("shows an action taken on one surface on the next read of every other", async () => {
      const { ledger, cli, send, post, refresh } = await setup();
      await ledger.append([
        ...approval("s-1", "ada@example.com"),
        ...approval("s-2", "bob@example.com"),
      ]);
      await refresh();
      const [one, two] = (await cli.list({})).items;

      await cli.decide(one?.id ?? "", { verdict: "deny", by: "ada@example.com", surface: "cli" });
      const read = (await (await send(`/v1/review-items/${one?.id}`)).json()) as ReviewItem;
      expect(read).toMatchObject({ state: "answered", answer: { verdict: "deny" } });

      await post(`/v1/review-items/${two?.id}/decision`, {
        verdict: "approve",
        by: "bob@example.com",
      });
      expect(await cli.get(two?.id ?? "")).toMatchObject({
        state: "answered",
        answer: { verdict: "approve" },
      });
      expect((await cli.list({})).items).toEqual([]);
    });

    it("times out an unanswered approval from the background refresh, once", async () => {
      const { ledger, send, setNow } = await setup();
      const lines: string[] = [];
      const job = startReviewRefreshJob(ledger, {
        now: () => new Date(minutes(31)),
        intervalMs: 60_000,
        log: (line) => lines.push(line),
      });
      try {
        await job.run();
        await ledger.append(approval("s-1", "ada@example.com"));
        await job.run();
        await job.run();
      } finally {
        job.stop();
      }
      setNow(minutes(31));
      const [expired] = await page(await send("/v1/review-items?state=expired"));
      expect(expired?.answer).toMatchObject({ by: "selfhost", verdict: "deny", at: minutes(30) });
      expect(await decisions(ledger)).toHaveLength(1);
      expect(lines).toEqual(["review list: 1 new, 1 changed"]);
    });
  });

  describe.skipIf(backend.skip)("with person tokens", () => {
    it("reads and answers its own team's items only, as its own person", async () => {
      const { send, post, refresh } = await setup();
      const join = async (team: string, person: string) => {
        const created = (await (await post("/v1/teams", { name: team })).json()) as {
          invite: string;
        };
        const joined = (await (
          await post("/v1/join", { invite: created.invite, person })
        ).json()) as JoinResponse;
        return joined.token;
      };
      const rita = await join("Red", "rita@example.com");
      const bob = await join("Blue", "bob@example.com");
      expect(
        (await post("/v1/events", { events: approval("red-1", "rita@example.com") }, rita)).status,
      ).toBe(200);
      expect(
        (await post("/v1/events", { events: approval("blue-1", "bob@example.com") }, bob)).status,
      ).toBe(200);
      await refresh();

      const red = await page(await send("/v1/review-items", {}, rita));
      expect(red.map((item) => [item.session_id, item.owners])).toEqual([
        ["red-1", ["rita@example.com"]],
      ]);
      const blue = await page(await send("/v1/review-items", {}, bob));
      expect(blue.map((item) => item.session_id)).toEqual(["blue-1"]);
      expect((await send("/v1/review-items?team=blue", {}, rita)).status).toBe(403);
      expect((await send(`/v1/review-items/${blue[0]?.id}`, {}, rita)).status).toBe(404);
      expect(
        (await post(`/v1/review-items/${blue[0]?.id}/decision`, { verdict: "deny" }, rita)).status,
      ).toBe(404);
      expect(
        (
          await post(
            `/v1/review-items/${red[0]?.id}/decision`,
            { verdict: "deny", by: "bob@example.com" },
            rita,
          )
        ).status,
      ).toBe(403);

      const answered = await post(
        `/v1/review-items/${red[0]?.id}/decision`,
        { verdict: "approve" },
        rita,
      );
      expect(answered.status).toBe(200);
      expect(((await answered.json()) as DecisionResponse).item.answer?.by).toBe(
        "rita@example.com",
      );

      expect(
        (await page(await send("/v1/review-items?state=answered"))).map((item) => item.session_id),
      ).toEqual(["red-1"]);
      expect(
        (await page(await send("/v1/review-items?team=blue"))).map((item) => item.session_id),
      ).toEqual(["blue-1"]);
    });
  });
});

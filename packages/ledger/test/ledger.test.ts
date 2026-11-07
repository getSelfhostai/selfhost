import type { LedgerEvent } from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LedgerQueryError, LedgerValidationError } from "../src/errors.js";
import type { Ledger } from "../src/ledger.js";
import { BACKENDS, makeEvent, type Store } from "./helpers.js";

async function expectValidationError(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LedgerValidationError);
  return (error as LedgerValidationError).errors;
}

async function all(ledger: Ledger, filter: Parameters<Ledger["query"]>[0] = {}) {
  const events: LedgerEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await ledger.query({ ...filter, cursor });
    events.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor);
  return events;
}

describe.each(BACKENDS)("ledger on $name", (backend) => {
  let store: Store;
  let ledger: Ledger;
  let next = 1;
  const fresh = (overrides: Partial<LedgerEvent> = {}) => makeEvent(next++, overrides);

  beforeAll(async () => {
    if (backend.skip) return;
    store = await backend.open();
    ledger = store.ledger;
  });

  afterAll(async () => {
    await store?.close();
  });

  describe.skipIf(backend.skip)("append", () => {
    it("stores a valid batch and returns the accepted ids in order", async () => {
      const batch = [fresh(), fresh({ kind: "session.ended" })];
      const result = await ledger.append(batch);
      expect(result).toEqual({ accepted: [batch[0]?.id, batch[1]?.id], duplicates: [] });
      const { events } = await ledger.query({ person: "alice@example.com", limit: 1000 });
      expect(events).toEqual(expect.arrayContaining(batch));
    });

    it("treats ids as idempotency keys and never changes a stored event", async () => {
      const original = fresh({ actor: { kind: "person", id: "idem@example.com" } });
      await ledger.append([original]);
      const retry = { ...original, kind: "session.ended" as const };
      const other = fresh({ actor: { kind: "person", id: "idem@example.com" } });
      const result = await ledger.append([retry, other]);
      expect(result).toEqual({ accepted: [other.id], duplicates: [original.id] });
      const { events } = await ledger.query({ person: "idem@example.com" });
      expect(events.find((e) => e.id === original.id)).toEqual(original);
    });

    it("treats ids that differ only in case as the same id", async () => {
      const original = fresh({ actor: { kind: "person", id: "case@example.com" } });
      await ledger.append([original]);
      const upper = { ...original, id: original.id.toUpperCase() };
      expect(await ledger.append([upper])).toEqual({ accepted: [], duplicates: [upper.id] });
    });

    it("rejects the whole batch, naming every bad field, and writes nothing", async () => {
      const good = fresh({ actor: { kind: "person", id: "atomic@example.com" } });
      const badKind = { ...fresh(), actor: { kind: "robot", id: "x" } };
      const badCost = { ...fresh(), kind: "cost.recorded" };
      const errors = await expectValidationError(ledger.append([good, badKind, badCost]));
      expect(errors).toEqual([
        { index: 1, path: "actor.kind", message: "Expected one of: person, agent, system" },
        { index: 2, path: "cost", message: 'Required when kind is "cost.recorded"' },
      ]);
      const { events } = await ledger.query({ person: "atomic@example.com" });
      expect(events).toEqual([]);
    });

    it("rejects duplicate ids inside one batch", async () => {
      const event = fresh();
      const errors = await expectValidationError(ledger.append([event, { ...event }]));
      expect(errors).toEqual([
        { index: 1, path: "id", message: "Duplicate id, also used by the event at index 0" },
      ]);
    });

    it("rejects text Postgres cannot store, naming the field", async () => {
      const event = fresh({
        tool: { name: "Bash", input_summary: "echo a\u0000b" },
        kind: "tool.called",
      });
      const errors = await expectValidationError(ledger.append([event]));
      expect(errors).toEqual([
        {
          index: 0,
          path: "tool.input_summary",
          message: "Contains a NUL character or invalid UTF-16",
        },
      ]);
    });

    it("rejects a batch that is not an array", async () => {
      const errors = await expectValidationError(ledger.append({} as unknown as unknown[]));
      expect(errors).toEqual([{ index: -1, path: "events", message: "Expected an array" }]);
    });

    it("accepts an empty batch as a no-op", async () => {
      expect(await ledger.append([])).toEqual({ accepted: [], duplicates: [] });
    });

    it("writes batches larger than one API request in a single call", async () => {
      const batch = Array.from({ length: 1205 }, () =>
        fresh({ actor: { kind: "person", id: "bulk@example.com" } }),
      );
      const result = await ledger.append(batch);
      expect(result.accepted).toHaveLength(1205);
      expect(await all(ledger, { person: "bulk@example.com", limit: 1000 })).toHaveLength(1205);
    });

    it("has no update or delete", () => {
      // teams holds team mode rows (people, tokens, policy), never events.
      expect(Object.keys(ledger).sort()).toEqual([
        "append",
        "close",
        "decisions",
        "deliveries",
        "query",
        "teams",
      ]);
      expect(Object.keys(ledger.teams).filter((key) => /event/i.test(key))).toEqual([]);
      // deliveries holds GitHub webhook delivery ids, never events.
      expect(Object.keys(ledger.deliveries).sort()).toEqual(["claim", "release"]);
      // decisions only reads: a decision is recorded with append and corrected by a new one.
      expect(Object.keys(ledger.decisions).sort()).toEqual(["get", "search"]);
    });
  });

  describe.skipIf(backend.skip)("query", () => {
    const person = "query@example.com";
    const seeded: LedgerEvent[] = [];

    beforeAll(async () => {
      const at = (minute: number) => `2026-10-05T10:${String(minute).padStart(2, "0")}:00.000Z`;
      const actor = { kind: "person" as const, id: person };
      seeded.push(
        fresh({
          ts: at(1),
          actor,
          agent: { vendor: "claude_code" },
          model: "claude-opus-5-5",
          session_id: "s1",
        }),
        fresh({ ts: at(2), actor, agent: { vendor: "codex" }, model: "gpt-5.5", session_id: "s2" }),
        fresh({
          ts: at(3),
          actor,
          kind: "tool.called",
          tool: { name: "Bash" },
          agent: { vendor: "claude_code" },
          model: "claude-opus-5-5",
          session_id: "s1",
        }),
        // Same instant as the previous event, written with an offset: ties break on id.
        fresh({
          ts: "2026-10-05T15:33:00.000+05:30",
          actor,
          agent: { vendor: "codex" },
          session_id: "s2",
        }),
        fresh({ ts: at(4), actor: { kind: "person", id: "other@example.com" }, session_id: "s1" }),
      );
      await ledger.append(seeded);
    });

    const ids = (events: LedgerEvent[]) => events.map((e) => e.id);
    const id = (n: number) => seeded[n - 1]?.id;

    it("filters by person, newest first with ties broken by id", async () => {
      const { events } = await ledger.query({ person });
      expect(ids(events)).toEqual([id(4), id(3), id(2), id(1)]);
      expect(events[0]?.ts).toBe("2026-10-05T15:33:00.000+05:30");
    });

    it("filters by agent, model, session and kind", async () => {
      expect(ids((await ledger.query({ person, agent: "codex" })).events)).toEqual([id(4), id(2)]);
      expect(ids((await ledger.query({ person, model: "claude-opus-5-5" })).events)).toEqual([
        id(3),
        id(1),
      ]);
      expect(ids((await ledger.query({ session: "s1", person })).events)).toEqual([id(3), id(1)]);
      expect(ids((await ledger.query({ session: "s1" })).events)).toHaveLength(3);
      expect(ids((await ledger.query({ person, kind: "tool.called" })).events)).toEqual([id(3)]);
    });

    it("filters by time range, from inclusive and to exclusive", async () => {
      const page = await ledger.query({
        person,
        from: "2026-10-05T10:02:00Z",
        to: "2026-10-05T10:03:00Z",
      });
      expect(ids(page.events)).toEqual([id(2)]);
      const offset = await ledger.query({ person, from: "2026-10-05T15:33:00+05:30" });
      expect(ids(offset.events)).toEqual([id(4), id(3)]);
    });

    it("pages with a keyset cursor and returns every event once", async () => {
      const first = await ledger.query({ person, limit: 3 });
      expect(ids(first.events)).toEqual([id(4), id(3), id(2)]);
      expect(first.nextCursor).toBeTypeOf("string");
      const second = await ledger.query({ person, limit: 3, cursor: first.nextCursor });
      expect(ids(second.events)).toEqual([id(1)]);
      expect(second.nextCursor).toBeUndefined();
      // A page that ends exactly at the last event has no next cursor.
      expect((await ledger.query({ person, limit: 4 })).nextCursor).toBeUndefined();
    });

    it("pages through ties on ts", async () => {
      const actor = { kind: "person" as const, id: "ties@example.com" };
      const batch = Array.from({ length: 7 }, () =>
        fresh({ actor, ts: "2026-10-05T11:00:00.123456Z" }),
      );
      await ledger.append(batch);
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await ledger.query({ person: actor.id, limit: 2, cursor });
        seen.push(...ids(page.events));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(ids(batch).reverse());
    });

    it("defaults to 100 events per page and allows up to 1000", async () => {
      const bulk = await ledger.query({ person: "bulk@example.com" });
      expect(bulk.events).toHaveLength(100);
      expect(bulk.nextCursor).toBeTypeOf("string");
      expect((await ledger.query({ person: "bulk@example.com", limit: 1000 })).events).toHaveLength(
        1000,
      );
    });

    it.each([
      [{ limit: 0 }, "limit"],
      [{ limit: 1001 }, "limit"],
      [{ limit: 2.5 }, "limit"],
      [{ agent: "robot" }, "agent"],
      [{ kind: "session.paused" }, "kind"],
      [{ from: "yesterday" }, "from"],
      [{ to: "2026-10-05" }, "to"],
      [{ cursor: "not-a-cursor" }, "cursor"],
      [{ cursor: Buffer.from("2026-10-05T10:00:00Z|x").toString("base64url") }, "cursor"],
    ])("rejects %j naming %s", async (filter, field) => {
      const error = await ledger.query(filter).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(LedgerQueryError);
      expect((error as LedgerQueryError).field).toBe(field);
    });
  });
});

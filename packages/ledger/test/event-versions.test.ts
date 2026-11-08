import {
  EVENT_SCHEMA,
  type EventSchemaVersion,
  eventSchemaSupport,
  type LedgerEvent,
} from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type Database, migrate } from "../src/db.js";
import { LedgerValidationError } from "../src/errors.js";
import { createLedger, type Ledger } from "../src/ledger.js";
import { SOURCE_EVENT_SCHEMAS } from "../src/sources/index.js";
import { makeEvent } from "./helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);

// example.event/v1 called the actor `who` and was replaced more than 12 months ago;
// example.event/v2 called the kind `type`, was released 13 months ago and replaced 30 days ago.
const VERSIONS: EventSchemaVersion[] = [
  {
    tag: "example.event/v1",
    released: daysAgo(900),
    upgrade: ({ who, ...rest }) => ({ ...rest, actor: who }),
  },
  {
    tag: "example.event/v2",
    released: daysAgo(400),
    upgrade: ({ type, ...rest }) => ({ ...rest, kind: type }),
  },
  { tag: EVENT_SCHEMA, released: daysAgo(30) },
];

function asV2(event: LedgerEvent) {
  const { kind, ...rest } = event;
  return { ...rest, schema: "example.event/v2", type: kind };
}

describe("append with older event schema versions", () => {
  let db: Database;
  let ledger: Ledger;

  beforeAll(async () => {
    db = await connect({ dataDir: "memory://" });
    await migrate(db);
    ledger = createLedger(db, { eventSchemas: VERSIONS });
  });

  afterAll(async () => {
    await db.close();
  });

  it("stores a supported older event upgraded to the current version", async () => {
    const event = makeEvent(1, { kind: "session.ended" });
    expect(await ledger.append([asV2(event)])).toEqual({ accepted: [event.id], duplicates: [] });
    const { events } = await ledger.query({ kind: "session.ended" });
    expect(events).toEqual([event]);
  });

  it("rejects the batch when an event is in a version past its support window", async () => {
    const { actor, ...rest } = makeEvent(2);
    const expired = { ...rest, schema: "example.event/v1", who: actor };
    const error = await ledger.append([makeEvent(3), expired]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LedgerValidationError);
    expect((error as LedgerValidationError).errors).toEqual([
      {
        index: 1,
        path: "schema",
        message: expect.stringMatching(
          /^example\.event\/v1 is no longer accepted: support ended on \d{4}-\d{2}-\d{2}, 12 months after example\.event\/v2 was released\./,
        ),
      },
    ]);
    const { events } = await ledger.query({ kind: "session.started" });
    expect(events).toEqual([]);
  });

  it("rejects an unknown version with the accepted ones", async () => {
    const error = await ledger
      .append([{ ...makeEvent(4), schema: "selfhost.event/v9" }])
      .catch((e: unknown) => e);
    expect((error as LedgerValidationError).errors).toEqual([
      {
        index: 0,
        path: "schema",
        message:
          'Unknown event schema "selfhost.event/v9". Accepted: selfhost.event/v1, example.event/v2',
      },
    ]);
  });
});

describe("SOURCE_EVENT_SCHEMAS", () => {
  it("names only versions the ledger accepts", () => {
    expect(SOURCE_EVENT_SCHEMAS).toContain(EVENT_SCHEMA);
    for (const tag of SOURCE_EVENT_SCHEMAS) {
      expect(["current", "supported"], tag).toContain(eventSchemaSupport(tag).status);
    }
  });
});

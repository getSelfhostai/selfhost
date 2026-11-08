import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acceptedEventSchemas,
  addMonths,
  EVENT_SCHEMA,
  EVENT_SCHEMA_VERSIONS,
  type EventSchemaVersion,
  eventSchemaSupport,
  eventVersionsFile,
  ingestEvent,
  upgradeEvent,
} from "../src/index.js";
import { FIXTURES, PACKAGE_ROOT, read } from "./contracts.js";

const event = JSON.parse(read(FIXTURES, "event", "valid", "session-started-minimal.json"));

// A made-up history: example.event/v1 called the actor `who`, example.event/v2 called the kind
// `type`, then the real current version.
const VERSIONS: EventSchemaVersion[] = [
  {
    tag: "example.event/v1",
    released: "2024-03-01",
    upgrade: ({ who, ...rest }) => ({ ...rest, actor: who }),
  },
  {
    tag: "example.event/v2",
    released: "2025-10-15",
    upgrade: ({ type, ...rest }) => ({ ...rest, kind: type }),
  },
  { tag: EVENT_SCHEMA, released: "2026-11-07" },
];

const at = (day: string) => ({ versions: VERSIONS, now: new Date(`${day}T12:00:00Z`) });

function asV1(e: Record<string, unknown>) {
  const { actor, kind, ...rest } = e;
  return { ...rest, schema: "example.event/v1", who: actor, type: kind };
}

describe("addMonths", () => {
  it.each([
    ["2026-11-07", 12, "2027-11-07"],
    ["2026-01-31", 1, "2026-02-28"],
    ["2028-02-29", 12, "2029-02-28"],
    ["2026-12-15", 1, "2027-01-15"],
  ])("%s plus %i months is %s", (day, months, want) => {
    expect(addMonths(day, months)).toBe(want);
  });
});

describe("eventSchemaSupport", () => {
  it("keeps the current version accepted however old it is", () => {
    expect(eventSchemaSupport(EVENT_SCHEMA, at("2040-01-01"))).toEqual({
      status: "current",
      released: "2026-11-07",
    });
  });

  it("accepts an older version until 12 months after the version that replaced it", () => {
    expect(eventSchemaSupport("example.event/v2", at("2027-11-06"))).toEqual({
      status: "supported",
      released: "2025-10-15",
      supersededBy: EVENT_SCHEMA,
      until: "2027-11-07",
    });
    expect(eventSchemaSupport("example.event/v2", at("2027-11-07")).status).toBe("expired");
  });

  it("accepts a version released more than 12 months ago while its successor is new", () => {
    // Released 13 months before this day, replaced 23 days before it.
    expect(eventSchemaSupport("example.event/v2", at("2026-11-30")).status).toBe("supported");
  });

  it("rejects a version whose successor shipped more than 12 months ago", () => {
    expect(eventSchemaSupport("example.event/v1", at("2026-11-08"))).toEqual({
      status: "expired",
      released: "2024-03-01",
      supersededBy: "example.event/v2",
      until: "2026-10-15",
    });
  });

  it("does not know a tag outside the list", () => {
    expect(eventSchemaSupport("selfhost.event/v9", at("2026-11-08"))).toEqual({
      status: "unknown",
    });
  });
});

describe("acceptedEventSchemas", () => {
  it("lists the accepted tags newest first", () => {
    expect(acceptedEventSchemas(at("2026-10-14"))).toEqual([
      EVENT_SCHEMA,
      "example.event/v2",
      "example.event/v1",
    ]);
    expect(acceptedEventSchemas(at("2026-11-08"))).toEqual([EVENT_SCHEMA, "example.event/v2"]);
    expect(acceptedEventSchemas(at("2027-11-07"))).toEqual([EVENT_SCHEMA]);
  });
});

describe("upgradeEvent", () => {
  it("returns a current event as it is", () => {
    expect(upgradeEvent(event, at("2026-11-08"))).toEqual({ ok: true, value: event });
  });

  it("chains upgrades from an older accepted version to the current one", () => {
    const old = asV1(event);
    const result = upgradeEvent(old, at("2026-10-01"));
    expect(result).toEqual({ ok: true, value: event, from: "example.event/v1" });
    expect(old.schema).toBe("example.event/v1");
  });

  it("names the end of support and the version to write for an expired version", () => {
    expect(upgradeEvent(asV1(event), at("2026-11-08"))).toEqual({
      ok: false,
      errors: [
        {
          field: "schema",
          message:
            "example.event/v1 is no longer accepted: support ended on 2026-10-15, 12 months after example.event/v2 was released. Update the importer or SDK that sent it to one that writes selfhost.event/v1",
        },
      ],
    });
  });

  it("lists the accepted versions for an unknown one", () => {
    expect(upgradeEvent({ ...event, schema: "selfhost.event/v9" }, at("2026-11-08"))).toEqual({
      ok: false,
      errors: [
        {
          field: "schema",
          message:
            'Unknown event schema "selfhost.event/v9". Accepted: selfhost.event/v1, example.event/v2',
        },
      ],
    });
  });

  it("passes values without a string schema to the validator", () => {
    expect(upgradeEvent(null)).toEqual({ ok: true, value: null });
    expect(upgradeEvent({ ...event, schema: 1 })).toEqual({
      ok: true,
      value: { ...event, schema: 1 },
    });
  });

  it("reports an upgrade that throws, or a version with no upgrade", () => {
    const broken: EventSchemaVersion[] = [
      {
        tag: "example.event/v1",
        released: "2026-01-01",
        upgrade: () => {
          throw new Error("no who");
        },
      },
      { tag: "example.event/v2", released: "2026-06-01" },
      { tag: EVENT_SCHEMA, released: "2026-11-07" },
    ];
    const options = { versions: broken, now: new Date("2026-11-08T00:00:00Z") };
    expect(upgradeEvent(asV1(event), options)).toMatchObject({
      ok: false,
      errors: [
        {
          field: "schema",
          message: "Could not upgrade from example.event/v1 to example.event/v2: no who",
        },
      ],
    });
    expect(upgradeEvent({ ...event, schema: "example.event/v2" }, options)).toMatchObject({
      ok: false,
      errors: [
        { field: "schema", message: "No upgrade from example.event/v2 to selfhost.event/v1" },
      ],
    });
  });
});

describe("ingestEvent", () => {
  it("validates the upgraded event against the current version", () => {
    expect(ingestEvent(asV1(event), at("2026-10-01"))).toEqual({ ok: true, value: event });
    const bad = asV1({ ...event, kind: "session.paused" });
    const result = ingestEvent(bad, at("2026-10-01"));
    expect(result.ok ? [] : result.errors.map((e) => e.field)).toEqual(["kind"]);
  });
});

describe("EVENT_SCHEMA_VERSIONS", () => {
  it("ends with the version every writer produces", () => {
    expect(EVENT_SCHEMA_VERSIONS.at(-1)?.tag).toBe(EVENT_SCHEMA);
  });

  it("has real, increasing release days and an upgrade on every older version", () => {
    let previous = "";
    for (const [i, version] of EVENT_SCHEMA_VERSIONS.entries()) {
      expect(version.released).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${version.released}T00:00:00Z`).toISOString().slice(0, 10)).toBe(
        version.released,
      );
      expect(version.released > previous).toBe(true);
      previous = version.released;
      const last = i === EVENT_SCHEMA_VERSIONS.length - 1;
      expect(version.upgrade === undefined, version.tag).toBe(last);
    }
  });

  it("keeps frozen event fixtures for every version", () => {
    for (const { tag } of EVENT_SCHEMA_VERSIONS) {
      const dir = join(PACKAGE_ROOT, "compat", tag.slice(tag.lastIndexOf("/") + 1), "event");
      expect(existsSync(dir), dir).toBe(true);
    }
  });

  it("is published as event-versions.json", () => {
    const file = JSON.parse(readFileSync(join(PACKAGE_ROOT, "event-versions.json"), "utf8"));
    expect(file).toEqual(eventVersionsFile());
    expect(eventVersionsFile(VERSIONS).versions).toEqual([
      {
        tag: "example.event/v1",
        released: "2024-03-01",
        superseded: "2025-10-15",
        supported_until: "2026-10-15",
      },
      {
        tag: "example.event/v2",
        released: "2025-10-15",
        superseded: "2026-11-07",
        supported_until: "2027-11-07",
      },
      { tag: EVENT_SCHEMA, released: "2026-11-07", superseded: null, supported_until: null },
    ]);
  });
});

import { EVENT_SCHEMA, eventSchemaSupport } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { EVENT_SCHEMAS, pickEventSchema } from "../src/index.js";

describe("EVENT_SCHEMAS", () => {
  it("names only versions the server still accepts, the current one first", () => {
    expect(EVENT_SCHEMAS[0]).toBe(EVENT_SCHEMA);
    for (const tag of EVENT_SCHEMAS) {
      expect(["current", "supported"], tag).toContain(eventSchemaSupport(tag).status);
    }
  });
});

describe("pickEventSchema", () => {
  it("picks the newest version the server lists", () => {
    expect(pickEventSchema(["selfhost.event/v2", EVENT_SCHEMA])).toBe(EVENT_SCHEMA);
  });

  it("reads a server with no event_schemas as one that accepts v1 only", () => {
    expect(pickEventSchema(undefined)).toBe("selfhost.event/v1");
  });

  it("returns undefined when the two share no version", () => {
    expect(pickEventSchema(["selfhost.event/v9"])).toBeUndefined();
  });
});

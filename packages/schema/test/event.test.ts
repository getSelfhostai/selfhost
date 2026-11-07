import { describe, expect, it } from "vitest";
import { MAX_EVENT_BATCH, validateEvent, validateEventBatch } from "../src/index.js";
import { FIXTURES, read } from "./contracts.js";

const event = JSON.parse(read(FIXTURES, "event", "valid", "session-started-minimal.json"));
const withId = (n: number) => ({
  ...event,
  id: `01930c4e-2f1a-7b2c-8d3e-${n.toString(16).padStart(12, "0")}`,
});

describe("validateEvent", () => {
  it("names the field required by the kind", () => {
    const result = validateEvent({ ...event, kind: "cost.recorded" });
    expect(result).toEqual({
      ok: false,
      errors: [{ field: "cost", message: 'Required when kind is "cost.recorded"' }],
    });
  });
});

describe("validateEventBatch", () => {
  it("accepts a valid batch", () => {
    const result = validateEventBatch([withId(1), withId(2)]);
    expect(result.ok).toBe(true);
  });

  it("rejects the whole batch and lists errors by index and field", () => {
    const bad = { ...withId(3), actor: { kind: "robot", id: "x" } };
    const result = validateEventBatch([withId(1), bad, { ...withId(4), ts: "yesterday" }]);
    expect(result).toEqual({
      ok: false,
      errors: [
        { index: 1, field: "actor.kind", message: "Expected one of: person, agent, system" },
        { index: 2, field: "ts", message: "Expected a date-time string" },
      ],
    });
  });

  it("rejects duplicate ids inside one batch", () => {
    const result = validateEventBatch([withId(1), withId(1)]);
    expect(result.ok ? [] : result.errors).toEqual([
      { index: 1, field: "id", message: "Duplicate id, also used by the event at index 0" },
    ]);
  });

  it("rejects empty and oversized batches", () => {
    expect(validateEventBatch([]).ok).toBe(false);
    const big = Array.from({ length: MAX_EVENT_BATCH + 1 }, (_, i) => withId(i + 1));
    const result = validateEventBatch(big);
    expect(result.ok ? [] : result.errors.map((e) => [e.index, e.field])).toEqual([[-1, "events"]]);
    expect(validateEventBatch(big.slice(0, MAX_EVENT_BATCH)).ok).toBe(true);
  });
});

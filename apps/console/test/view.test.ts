import { describe, expect, it } from "vitest";
import { parseView, rangeOf, usageQuery, viewSearch } from "../src/lib/view";

const NOW = new Date("2026-11-20T15:30:00.000Z");

describe("the view in the address bar", () => {
  it("reads and writes the range, filters, breakdown and metric", () => {
    const search =
      "?from=2026-11-01&to=2026-11-07&team=web&person=a%40b.c&view=model&metric=tokens";
    const view = parseView(search);
    expect(view).toEqual({
      range: "custom",
      from: "2026-11-01",
      to: "2026-11-07",
      filters: { team: "web", person: "a@b.c" },
      breakdown: "model",
      metric: "tokens",
    });
    expect(parseView(viewSearch(view))).toEqual(view);
  });

  it("falls back to the last 30 days, by cost, for anything it does not know", () => {
    expect(parseView("?range=1y&view=repo&metric=vibes&from=2026-11-09&to=2026-11-01")).toEqual({
      range: "30d",
      filters: {},
      metric: "usd",
    });
    expect(viewSearch(parseView(""))).toBe("");
  });
});

describe("ranges", () => {
  it("include today in a preset, ending at the next UTC midnight", () => {
    const range = rangeOf(parseView("?range=7d"), NOW);
    expect(range.from).toBe("2026-11-14T00:00:00.000Z");
    expect(range.to).toBe("2026-11-21T00:00:00.000Z");
    expect(range.days).toHaveLength(7);
    expect(range.days.at(-1)).toBe("2026-11-20");
  });

  it("start this month on the first", () => {
    expect(rangeOf(parseView("?range=month"), NOW).from).toBe("2026-11-01T00:00:00.000Z");
  });

  it("include the last day of a custom range", () => {
    const range = rangeOf(parseView("?from=2026-10-30&to=2026-11-02"), NOW);
    expect(range.days).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(range.to).toBe("2026-11-03T00:00:00.000Z");
  });
});

describe("usage queries", () => {
  it("carry the filters, or leave them out for the filter lists", () => {
    const view = parseView("?range=7d&agent=codex&org=acme");
    expect(Object.fromEntries(usageQuery(view, NOW, ["day", "person"]))).toEqual({
      from: "2026-11-14T00:00:00.000Z",
      to: "2026-11-21T00:00:00.000Z",
      group_by: "day,person",
      agent: "codex",
      org: "acme",
    });
    expect(usageQuery(view, NOW, ["agent"], false).has("agent")).toBe(false);
  });
});

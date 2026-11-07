import { beforeAll, describe, expect, it } from "vitest";
import { importAll } from "../src/index.js";
import {
  ALL_TIME,
  CLAUDE_DIR,
  CODEX_DIR,
  dailyByModel,
  MemoryWriter,
  type ModelTotals,
  readJson,
} from "./helpers.js";

interface ClaudeDaily {
  daily: {
    date: string;
    totalCost: number;
    modelBreakdowns: (Omit<ModelTotals, "cost"> & { modelName: string; cost: number })[];
  }[];
  totals: { totalCost: number };
}

interface CodexDaily {
  daily: {
    date: string;
    costUSD: number;
    models: Record<
      string,
      {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        reasoningOutputTokens: number;
      }
    >;
  }[];
  totals: { costUSD: number };
}

interface AllDaily {
  daily: {
    period: string;
    modelBreakdowns: (Omit<ModelTotals, "cost"> & { modelName: string; cost: number })[];
  }[];
}

// ccusage prints costs as f64 sums; ours sum the same per-request terms in a different order.
const COST_DIGITS = 10;

const writer = new MemoryWriter();

beforeAll(async () => {
  await importAll(writer, { claudeDir: CLAUDE_DIR, codexDir: CODEX_DIR, since: ALL_TIME });
});

function vendorCosts(vendor: "claude_code" | "codex") {
  return dailyByModel(writer.list("cost.recorded").filter((e) => e.agent?.vendor === vendor));
}

describe("parity with ccusage 20.0.48 on the fixture logs", () => {
  it("matches ccusage claude daily per day and model", () => {
    const expected = readJson<ClaudeDaily>("expected", "ccusage-claude-daily.json");
    const actual = vendorCosts("claude_code");
    expect([...actual.keys()].sort()).toEqual(expected.daily.map((day) => day.date));
    let total = 0;
    for (const day of expected.daily) {
      const models = actual.get(day.date);
      expect([...(models?.keys() ?? [])].sort()).toEqual(
        day.modelBreakdowns.map((model) => model.modelName).sort(),
      );
      let dayCost = 0;
      for (const want of day.modelBreakdowns) {
        const got = models?.get(want.modelName);
        expect(got, `${day.date} ${want.modelName}`).toBeDefined();
        expect({
          inputTokens: got?.inputTokens,
          outputTokens: got?.outputTokens,
          cacheReadTokens: got?.cacheReadTokens,
          cacheCreationTokens: got?.cacheCreationTokens,
        }).toEqual({
          inputTokens: want.inputTokens,
          outputTokens: want.outputTokens,
          cacheReadTokens: want.cacheReadTokens,
          cacheCreationTokens: want.cacheCreationTokens,
        });
        expect(got?.cost).toBeCloseTo(want.cost, COST_DIGITS);
        dayCost += got?.cost ?? 0;
      }
      expect(dayCost).toBeCloseTo(day.totalCost, COST_DIGITS);
      total += dayCost;
    }
    expect(total).toBeCloseTo(expected.totals.totalCost, COST_DIGITS);
  });

  it("matches ccusage codex daily per day and model", () => {
    const expected = readJson<CodexDaily>("expected", "ccusage-codex-daily.json");
    const actual = vendorCosts("codex");
    expect([...actual.keys()].sort()).toEqual(expected.daily.map((day) => day.date));
    const reasoning = new Map<string, number>();
    for (const event of writer.list("cost.recorded")) {
      if (event.agent?.vendor !== "codex" || !event.model) continue;
      const key = `${event.ts.slice(0, 10)} ${event.model}`;
      reasoning.set(key, (reasoning.get(key) ?? 0) + Number(event.data?.reasoning_output_tokens));
    }
    let total = 0;
    for (const day of expected.daily) {
      const models = actual.get(day.date);
      expect([...(models?.keys() ?? [])].sort()).toEqual(Object.keys(day.models).sort());
      let dayCost = 0;
      for (const [model, want] of Object.entries(day.models)) {
        const got = models?.get(model);
        expect({
          inputTokens: got?.inputTokens,
          outputTokens: got?.outputTokens,
          cacheReadTokens: got?.cacheReadTokens,
          cacheCreationTokens: got?.cacheCreationTokens,
          reasoningOutputTokens: reasoning.get(`${day.date} ${model}`),
        }).toEqual({
          inputTokens: want.inputTokens,
          outputTokens: want.outputTokens,
          cacheReadTokens: want.cacheReadTokens,
          cacheCreationTokens: want.cacheCreationTokens,
          reasoningOutputTokens: want.reasoningOutputTokens,
        });
        dayCost += got?.cost ?? 0;
      }
      expect(dayCost).toBeCloseTo(day.costUSD, COST_DIGITS);
      total += dayCost;
    }
    expect(total).toBeCloseTo(expected.totals.costUSD, COST_DIGITS);
  });

  it("matches the combined ccusage daily report, including Codex cost per model", () => {
    const expected = readJson<AllDaily>("expected", "ccusage-all-daily.json");
    const actual = dailyByModel(writer.list("cost.recorded"));
    expect([...actual.keys()].sort()).toEqual(expected.daily.map((day) => day.period));
    for (const day of expected.daily) {
      for (const want of day.modelBreakdowns) {
        const got = actual.get(day.period)?.get(want.modelName);
        expect(got?.inputTokens, `${day.period} ${want.modelName}`).toBe(want.inputTokens);
        expect(got?.outputTokens).toBe(want.outputTokens);
        expect(got?.cost).toBeCloseTo(want.cost, COST_DIGITS);
      }
    }
  });

  it("marks every cost as estimated", () => {
    const costs = writer.list("cost.recorded");
    expect(costs.length).toBeGreaterThan(0);
    expect(costs.every((event) => event.cost?.estimated === true)).toBe(true);
  });
});

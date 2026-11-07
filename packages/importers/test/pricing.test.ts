import { describe, expect, it } from "vitest";
import { claudeCostUsd, codexCostUsd, findPricing } from "../src/vendor/ccusage/pricing.js";

const claudeUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  fast: false,
};

describe("vendored ccusage pricing", () => {
  it("finds exact, dated, Bedrock-style and exact-only ids offline", () => {
    expect(findPricing("claude-opus-5-5")).toMatchObject({ input: 4e-6, output: 20e-6 });
    expect(findPricing("claude-opus-5-5-20261001")).toMatchObject({ input: 4e-6 });
    expect(findPricing("us.anthropic.claude-opus-5-5")?.input).toBeCloseTo(4.4e-6, 15);
    // An exact-only tier must not fall back to the base model's rate.
    expect(findPricing("claude-opus-5-5-fast")?.input).toBeCloseTo(8e-6, 15);
    expect(findPricing("gpt-5.4-mini")).toMatchObject({ input: 7.5e-7, output: 4.5e-6 });
    expect(findPricing("not-a-model")).toBeUndefined();
  });

  it("prices 1-hour cache writes at twice the input rate", () => {
    const fiveMinute = claudeCostUsd("claude-opus-5-5", {
      ...claudeUsage,
      cacheCreationTokens: 1000,
    });
    const oneHour = claudeCostUsd("claude-opus-5-5", {
      ...claudeUsage,
      cacheCreation: { ephemeral5m: 0, ephemeral1h: 1000 },
    });
    expect(fiveMinute).toBeCloseTo(1000 * 5e-6, 15);
    expect(oneHour).toBeCloseTo(1000 * 8e-6, 15);
  });

  it("bills a whole Codex request at long-context rates above 272K input tokens", () => {
    const usage = { cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 1000 };
    const short = codexCostUsd("gpt-5.5", { ...usage, inputTokens: 272_000 }, undefined);
    const long = codexCostUsd("gpt-5.5", { ...usage, inputTokens: 272_001 }, undefined);
    expect(short).toBeCloseTo(272_000 * 5e-6 + 1000 * 30e-6, 12);
    expect(long).toBeCloseTo(272_001 * 10e-6 + 1000 * 45e-6, 12);
  });

  it("applies the priority tier multiplier", () => {
    const usage = {
      inputTokens: 1000,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
    };
    const standard = codexCostUsd("gpt-5.5", usage, undefined) ?? 0;
    expect(codexCostUsd("gpt-5.5", usage, "fast")).toBeCloseTo(standard * 2.5, 15);
    expect(codexCostUsd("gpt-5.5", usage, "flex")).toBeCloseTo(standard * 0.5, 15);
  });
});

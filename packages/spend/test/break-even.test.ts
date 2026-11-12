import { describe, expect, it } from "vitest";
import { breakEven, SEAT_TIERS, type SeatTier } from "../src/index.js";

/** Round numbers so each verdict can be checked by hand. */
const TIERS: Record<string, SeatTier[]> = {
  claude_code: [
    { tier: "pro", usd: 20, limit_usd: 300 },
    { tier: "max_5x", usd: 100, limit_usd: 1500 },
    { tier: "max_20x", usd: 200, limit_usd: 6000 },
  ],
  codex: [
    { tier: "plus", usd: 20, limit_usd: 200 },
    { tier: "pro", usd: 200, limit_usd: 1700 },
  ],
};

describe("breakEven", () => {
  it("picks the cheaper of each seat tier and an API key, heaviest use first", () => {
    const rows = breakEven(
      [
        { person: "light@example.com", agent: "claude_code", usd: 12 },
        { person: "mid@example.com", agent: "claude_code", usd: 450 },
        { person: "heavy@example.com", agent: "claude_code", usd: 8000 },
        { person: "codex@example.com", agent: "codex", usd: 150 },
        { person: "cursor@example.com", agent: "cursor", usd: 900 },
        { person: "idle@example.com", agent: "claude_code", usd: 0 },
      ],
      30,
      TIERS,
    );
    expect(rows.map((row) => [row.person, row.verdict, row.tier])).toEqual([
      ["heavy@example.com", "seat", "max_20x"],
      ["mid@example.com", "seat", "max_5x"],
      ["codex@example.com", "seat", "plus"],
      ["light@example.com", "api", null],
    ]);
    const [heavy, mid, codex, light] = rows;
    // 8000 a month: max_20x is 200 plus 2000 past its 6000 limit.
    expect(heavy).toMatchObject({
      monthly_api_usd: 8000,
      seat_usd: 200,
      monthly_cost_usd: 2200,
      saving_usd: 5800,
      over_limit: true,
      break_even_usd: 20,
    });
    // 450 a month: pro would be 20 + 150 past its limit = 170; max_5x is 100 and wins.
    expect(mid).toMatchObject({ monthly_cost_usd: 100, saving_usd: 350, over_limit: false });
    expect(codex).toMatchObject({ seat_usd: 20, saving_usd: 130 });
    // 12 a month on API keys against a 20 seat.
    expect(light).toMatchObject({
      verdict: "api",
      seat_usd: null,
      monthly_cost_usd: 12,
      saving_usd: 8,
      over_limit: false,
    });
  });

  it("scales the range to 30 days and keeps the API key on a tie", () => {
    const [week] = breakEven([{ person: "a", agent: "claude_code", usd: 35 }], 7, TIERS);
    expect(week).toMatchObject({ api_usd: 35, monthly_api_usd: 150, verdict: "seat", tier: "pro" });
    const [tie] = breakEven([{ person: "a", agent: "claude_code", usd: 20 }], 30, TIERS);
    expect(tie).toMatchObject({ verdict: "api", saving_usd: 0 });
  });

  it("has dated tiers for Claude Code and Codex with limits from the forecast table", () => {
    expect(SEAT_TIERS.claude_code?.map((tier) => [tier.tier, tier.usd])).toEqual([
      ["pro", 20],
      ["max_5x", 100],
      ["max_20x", 200],
    ]);
    for (const tiers of Object.values(SEAT_TIERS)) {
      for (const tier of tiers ?? []) expect(tier.limit_usd).toBeGreaterThan(tier.usd);
    }
  });
});

import { describe, expect, it } from "vitest";
import { ranOutOfTime } from "../src/adapters/common.js";

describe("ranOutOfTime", () => {
  it("counts a timer that fired a moment early as a timeout, and a quick failure as not", () => {
    expect(ranOutOfTime(0, 2000, 1999)).toBe(true);
    expect(ranOutOfTime(0, 2000, 2400)).toBe(true);
    expect(ranOutOfTime(0, 2000, 300)).toBe(false);
  });
});

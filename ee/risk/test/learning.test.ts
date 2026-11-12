import { parseHunks } from "@selfhost/pr";
import { describe, expect, it } from "vitest";
import {
  addedLines,
  type ChangedFile,
  learnedChange,
  learnedRates,
  learnedSuggestion,
  looksLikeRevert,
  overlappingLines,
  removedLines,
  revertClaims,
  revertReason,
  scoreRisk,
} from "../src/index.js";
import { config } from "./helpers.js";

const file = (path: string, patch: string, previousPath?: string): ChangedFile => ({
  path,
  ...(previousPath ? { previousPath } : {}),
  additions: 0,
  deletions: 0,
  hunks: parseHunks(patch),
});

describe("lines", () => {
  it("keeps the added lines by their new numbers and the removed ones by their old", () => {
    const patch = "@@ -3,4 +3,5 @@\n a\n-b\n-c\n+B\n+C\n+D\n d\n@@ -20,0 +21,2 @@\n+x\n+y";
    expect(addedLines([file("src/a.ts", patch)])).toEqual({
      "src/a.ts": [
        [4, 6],
        [21, 22],
      ],
    });
    expect(removedLines([file("src/b.ts", patch, "src/a.ts")])).toEqual({ "src/a.ts": [[4, 5]] });
    expect(addedLines([file("bin.png", "")])).toEqual({});
  });

  it("finds a later change to the lines an earlier one wrote", () => {
    const written = {
      "src/a.ts": [[10, 20]] as [number, number][],
      "src/b.ts": [[1, 2]] as [number, number][],
    };
    expect(overlappingLines(written, { "src/a.ts": [[18, 25]], "src/c.ts": [[1, 1]] })).toEqual({
      files: ["src/a.ts"],
      lines: 3,
    });
    expect(overlappingLines(written, { "src/a.ts": [[21, 30]] })).toEqual({ files: [], lines: 0 });
  });
});

describe("revert claims", () => {
  it("reads GitHub's revert button, git revert and the title", () => {
    expect(
      revertClaims({
        title: 'Revert "Add per-key rate limiting"',
        body: "Reverts acme/api#142\n\nThis reverts commit 9F1C2E3D4B5A.",
      }),
    ).toEqual({
      pulls: [{ repo: "acme/api", number: 142 }],
      shas: ["9f1c2e3d4b5a"],
      title: "Add per-key rate limiting",
    });
    expect(revertClaims({ messages: ['Revert "x" (#9)\n\nReverts #7'] }).pulls).toEqual([
      { number: 7 },
    ]);
    const plain = revertClaims({ title: "Fix the revert button", body: "No claims here" });
    expect(looksLikeRevert(plain)).toBe(false);
  });

  it("keeps what the person wrote as the reason", () => {
    expect(revertReason("Reverts acme/api#142\n\n<!-- template -->\nBroke SSO.")).toBe(
      "Broke SSO.",
    );
    expect(revertReason("Reverts acme/api#142\n")).toBeUndefined();
    expect(revertReason("x".repeat(600))?.length).toBe(500);
  });
});

describe("learned rates", () => {
  const merged = ["a", "b", "c", "d", "e"].map((name) => ({
    url: `https://github.com/acme/api/pull/${name}`,
    vendor: "codex",
    model: "gpt-5",
    modules: name === "e" ? ["api", "web"] : ["api"],
  }));

  it("tracks reverts and reworks per agent, model and module", () => {
    const rates = learnedRates(
      merged,
      [
        { url: merged[0]?.url ?? "", kind: "revert", event: "r1" },
        { url: merged[0]?.url ?? "", kind: "rework", event: "w1" },
        { url: merged[1]?.url ?? "", kind: "rework", event: "w2" },
      ],
      { threshold: 0.25 },
    );
    expect(rates).toEqual([
      {
        vendor: "codex",
        model: "gpt-5",
        module: "api",
        pulls: 5,
        reverted: 1,
        reworked: 1,
        rate: 0.4,
        above: true,
        evidence: ["r1", "w1", "w2"],
      },
      expect.objectContaining({ module: "web", pulls: 1, rate: 0, above: false }),
    ]);
  });

  it("needs five merges and a rate above the threshold, and records each crossing once", () => {
    const [few] = learnedRates(
      merged.slice(0, 4),
      [{ url: merged[0]?.url ?? "", kind: "revert", event: "r" }],
      {
        threshold: 0.1,
      },
    );
    expect(few?.above).toBe(false);
    const [at] = learnedRates(merged, [{ url: merged[0]?.url ?? "", kind: "revert", event: "r" }], {
      threshold: 0.2,
    });
    expect(at?.above).toBe(false);
    const above = { ...(at as NonNullable<typeof at>), above: true };
    expect(learnedChange(above, undefined)).toBe("proposed");
    expect(learnedChange(above, "proposed")).toBeUndefined();
    expect(learnedChange(above, "cleared")).toBe("proposed");
    expect(learnedChange(at as NonNullable<typeof at>, "proposed")).toBe("cleared");
    expect(learnedChange(at as NonNullable<typeof at>, undefined)).toBeUndefined();
  });

  it("suggests a high_risk_paths change for a person to make", () => {
    expect(learnedSuggestion("apps/server", undefined)).toContain('"apps/server/**"');
    expect(learnedSuggestion("auth", ["src/auth/**", "lib/auth/**"])).toContain(
      '"src/auth/**", "lib/auth/**"',
    );
  });
});

describe("scoring approved revert signals", () => {
  const policy = config("version = 1\n");
  const files = [{ path: "src/a.ts", additions: 1, deletions: 0 }];

  it("adds nothing and lists nothing without an approved signal", () => {
    const result = scoreRisk({ files }, policy);
    expect(result.factors.map((f) => f.input)).not.toContain("learned_reverts");
    expect(result.missing.map((m) => m.input)).not.toContain("learned_reverts");
  });

  it("adds 15 for the first module and 5 for each more, at most 25", () => {
    const signal = (module: string) => ({
      module,
      pulls: 8,
      reverted: 2,
      reworked: 1,
      rate: 0.375,
      days: 14,
    });
    const one = scoreRisk(
      { files, agent: { vendor: "codex", model: "gpt-5" }, learned: [signal("src")] },
      policy,
    );
    expect(one.factors.find((f) => f.input === "learned_reverts")).toEqual({
      input: "learned_reverts",
      points: 15,
      forcesHigh: false,
      detail:
        "Approved revert signal for codex gpt-5: src 3 of 8 merged pull requests reverted or reworked within 14 days (38%)",
    });
    const many = scoreRisk({ files, learned: ["a", "b", "c", "d"].map(signal) }, policy);
    expect(many.factors.find((f) => f.input === "learned_reverts")?.points).toBe(25);
  });
});

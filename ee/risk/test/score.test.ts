import { describe, expect, it } from "vitest";
import {
  IRREVERSIBLE_FLOOR,
  type RiskInputs,
  riskCheck,
  riskLabel,
  scoreRisk,
} from "../src/index.js";
import { CASES, config, FIXTURE_TOML } from "./helpers.js";

const policy = config(FIXTURE_TOML);
const byName = new Map(CASES.cases.map((c) => [c.name, c] as const));
const scored = (name: string) => {
  const found = byName.get(name);
  if (!found) throw new Error(`no case ${name}`);
  return scoreRisk(found.inputs, policy);
};

describe("scoreRisk on the fixture cases", () => {
  it.each(CASES.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const result = scoreRisk(c.inputs, policy);
    expect(result.level).toBe(c.expect.level);
    expect(result.score).toBe(c.expect.score);
    expect(result.missing.map((m) => m.input)).toEqual(c.expect.missing);
  });

  it.each(CASES.ordering)("%s scores above %s", (higher, lower) => {
    expect(scored(higher).score).toBeGreaterThan(scored(lower).score);
  });

  it("covers every acceptance criterion with a fixture", () => {
    expect(new Set(CASES.cases.map((c) => c.criterion))).toEqual(new Set([1, 3, 4, 5]));
  });
});

describe("criterion 3: an irreversible change is high whatever else is true", () => {
  const small = byName.get("irreversible-change-small-tested");

  it("is small, tested and outside the protected paths", () => {
    const inputs = small?.inputs as RiskInputs;
    const result = scoreRisk(inputs, policy);
    const factor = (input: string) => result.factors.find((f) => f.input === input);
    expect(inputs.files.reduce((n, f) => n + f.additions + f.deletions, 0)).toBeLessThan(10);
    expect(inputs.tests).toBe("passed");
    expect(factor("protected_paths")?.points).toBe(0);
    expect(factor("irreversible_rules")).toMatchObject({ forcesHigh: true, points: 60 });
    expect(result.reasons[0]).toContain("customer-email-templates (emails/campaigns/welcome.html)");
    expect(result.level).toBe("high");
  });

  it("stays high when the threshold is raised out of reach", () => {
    const strict = config(
      `${FIXTURE_TOML.replace("high_risk_threshold = 70", "high_risk_threshold = 100")}`,
    );
    const result = scoreRisk(small?.inputs as RiskInputs, strict);
    expect(result.level).toBe("high");
    expect(result.score).toBeGreaterThanOrEqual(IRREVERSIBLE_FLOOR);
  });

  it("matches the old path of a renamed file", () => {
    const result = scoreRisk(
      {
        files: [
          {
            path: "emails/archive/old.html",
            previousPath: "emails/campaigns/old.html",
            additions: 0,
            deletions: 0,
          },
        ],
      },
      policy,
    );
    expect(result.level).toBe("high");
  });

  it("ignores a rule in mode off and a rule for another agent", () => {
    const off = config(
      FIXTURE_TOML.replace(
        'id = "customer-email-templates"',
        'id = "customer-email-templates"\nmode = "off"',
      ),
    );
    const codexOnly = config(
      FIXTURE_TOML.replace(
        'id = "customer-email-templates"',
        'id = "customer-email-templates"\nagents = ["codex"]',
      ),
    );
    const inputs: RiskInputs = {
      files: [{ path: "emails/campaigns/welcome.html", additions: 4, deletions: 2 }],
      agent: { vendor: "claude_code" },
    };
    expect(scoreRisk(inputs, off).level).toBe("low");
    expect(scoreRisk(inputs, codexOnly).level).toBe("low");
    expect(scoreRisk({ ...inputs, agent: { vendor: "codex" } }, codexOnly).level).toBe("high");
  });

  it("counts paths through the diff only, so reading a protected template is not irreversible", () => {
    const result = scoreRisk(
      {
        files: [{ path: "README.md", additions: 1, deletions: 0 }],
        run: {
          sessions: ["s"],
          toolCalls: [{ tool: "Read", path: "emails/campaigns/welcome.html" }],
          guardrails: [],
        },
      },
      policy,
    );
    expect(result.level).toBe("low");
  });

  it("counts an irreversible hit recorded during the run", () => {
    const result = scoreRisk(
      {
        files: [{ path: "README.md", additions: 1, deletions: 0 }],
        run: {
          sessions: ["s"],
          toolCalls: [],
          guardrails: [
            { rule_id: "old-rule", verdict: "ask", mode: "observe", irreversible: true },
          ],
        },
      },
      policy,
    );
    expect(result.level).toBe("high");
    expect(result.reasons[0]).toContain("old-rule");
  });
});

describe("criterion 4: what cannot be undone sorts above protected paths", () => {
  it("puts an outside effect above a protected path, and above every non-irreversible case", () => {
    const effect = scored("outside-effect-only");
    const nonIrreversible = CASES.cases
      .map((c) => scoreRisk(c.inputs, policy))
      .filter((r) => !r.factors.some((f) => f.forcesHigh && f.input !== "protected_paths"));
    for (const result of nonIrreversible) expect(effect.score).toBeGreaterThan(result.score);
    expect(effect.reasons[0]).toContain("email, Amazon SES send (aws ses send-email)");
  });
});

describe("criterion 5: missing inputs", () => {
  it("scores the rest and names each missing input with its reason", () => {
    const result = scored("missing-inputs");
    expect(result.missing).toEqual([
      { input: "outside_effects", reason: "no ledger" },
      { input: "tests", reason: "no sandbox run yet" },
      { input: "guardrails", reason: "no ledger" },
      {
        input: "reverts",
        reason: "only 2 commits by claude_code claude-sonnet-4-5 in the last 90 days (needs 5)",
      },
    ]);
    expect(result.factors.map((f) => f.input)).toEqual([
      "irreversible_rules",
      "protected_paths",
      "size",
      "dependencies",
    ]);
    const check = riskCheck(result, policy);
    expect(check.summary).toContain(
      "Missing: outside effects (no ledger); tests (no sandbox run yet)",
    );
    expect(check.text).toContain("- Revert rate: only 2 commits");
  });

  it("names protected paths as missing when selfhost.toml sets none", () => {
    const result = scoreRisk(
      { files: [{ path: "src/auth/session.ts", additions: 1, deletions: 1 }] },
      config("version = 1\n"),
    );
    expect(result.missing.map((m) => m.input)).toContain("protected_paths");
    expect(result.missing.find((m) => m.input === "protected_paths")?.reason).toBe(
      "no [review] high_risk_paths in selfhost.toml",
    );
    expect(result.missing.map((m) => m.input)).toEqual([
      "outside_effects",
      "protected_paths",
      "dependencies",
      "tests",
      "guardrails",
      "reverts",
    ]);
  });
});

describe("criterion 6: the same inputs give the same level", () => {
  it("gives the same result every time and for any input order", () => {
    for (const c of CASES.cases) {
      const first = scoreRisk(c.inputs, policy);
      const again = scoreRisk(structuredClone(c.inputs), policy);
      const reversed: RiskInputs = {
        ...c.inputs,
        files: [...c.inputs.files].reverse(),
        ...(c.inputs.dependencies ? { dependencies: [...c.inputs.dependencies].reverse() } : {}),
        ...(c.inputs.run
          ? {
              run: {
                ...c.inputs.run,
                toolCalls: [...c.inputs.run.toolCalls].reverse(),
                guardrails: [...c.inputs.run.guardrails].reverse(),
              },
            }
          : {}),
      };
      expect(again).toEqual(first);
      expect(scoreRisk(reversed, policy)).toEqual(first);
    }
  });
});

describe("scoreRisk weights", () => {
  const base: RiskInputs = {
    files: [{ path: "src/a.ts", additions: 10, deletions: 0 }],
    dependencies: [],
    tests: "passed",
    run: { sessions: ["s"], toolCalls: [], guardrails: [] },
  };

  it("scores size by changed lines without lockfiles", () => {
    const size = (additions: number) =>
      scoreRisk({ ...base, files: [{ path: "src/a.ts", additions, deletions: 0 }] }, policy).score;
    expect([50, 51, 200, 201, 500, 501, 1000, 1001].map(size)).toEqual([
      0, 5, 5, 10, 10, 15, 15, 20,
    ]);
    const lock = scoreRisk(
      {
        ...base,
        files: [...base.files, { path: "web/package-lock.json", additions: 5000, deletions: 0 }],
      },
      policy,
    );
    expect(lock.score).toBe(0);
    expect(lock.factors.find((f) => f.input === "size")?.detail).toBe(
      "10 changed lines in 1 file (lockfiles left out)",
    );
  });

  it("caps dependencies, guardrail blocks and revert rate", () => {
    const deps = (n: number) =>
      scoreRisk(
        {
          ...base,
          dependencies: Array.from({ length: n }, (_, i) => ({
            manifest: "package.json",
            name: `d${i}`,
          })),
        },
        policy,
      ).score;
    expect([0, 1, 2, 3, 9].map(deps)).toEqual([0, 10, 15, 20, 20]);
    const blocks = (n: number) =>
      scoreRisk(
        {
          ...base,
          run: {
            sessions: ["s"],
            toolCalls: [],
            guardrails: Array.from({ length: n }, () => ({
              rule_id: "no-force-push",
              verdict: "block" as const,
              mode: "observe" as const,
              irreversible: false,
            })),
          },
        },
        policy,
      ).score;
    expect([0, 1, 2, 5].map(blocks)).toEqual([0, 10, 20, 20]);
    const rate = (reverted: number) =>
      scoreRisk(
        { ...base, reverts: { agent: { vendor: "codex" }, commits: 20, reverted, days: 90 } },
        policy,
      ).score;
    expect([0, 1, 2, 4, 5, 20].map(rate)).toEqual([0, 0, 10, 10, 20, 20]);
  });

  it("does not count an ask verdict as a guardrail block", () => {
    const result = scoreRisk(
      {
        ...base,
        run: {
          sessions: ["s"],
          toolCalls: [],
          guardrails: [{ rule_id: "x", verdict: "ask", mode: "enforce", irreversible: false }],
        },
      },
      policy,
    );
    expect(result.score).toBe(0);
  });

  it("scores tests that did not run below tests that failed", () => {
    expect(scoreRisk({ ...base, tests: "not_run" }, policy).score).toBe(15);
    expect(scoreRisk({ ...base, tests: "failed" }, policy).score).toBe(30);
  });

  it("sets medium from half the threshold, rounded up", () => {
    const at = (threshold: number, tests: RiskInputs["tests"]) =>
      scoreRisk(
        { ...base, tests },
        config(`version = 1\n[review]\nhigh_risk_threshold = ${threshold}\n`),
      ).level;
    expect(at(70, "failed")).toBe("low");
    expect(at(60, "failed")).toBe("medium");
    expect(at(30, "failed")).toBe("high");
  });
});

describe("riskCheck", () => {
  it("builds the label, title, summary and a table of every input", () => {
    const result = scored("outside-effect-only");
    expect(riskLabel(result.level)).toBe("selfhost:risk-high");
    const check = riskCheck(result, policy);
    expect(check.name).toBe("selfhost/risk");
    expect(check.title).toBe("High risk (score 90)");
    expect(check.summary).toMatch(
      /^High risk, score 90 of 100\. Set by: Irreversible outside effect/,
    );
    expect(check.text.split("\n").slice(0, 10)).toEqual([
      "| Input | Points | Found |",
      "| --- | ---: | --- |",
      "| Irreversible rules | 0 | No irreversible rule matched the changes or the run |",
      "| Outside effects | 60, sets high | Irreversible outside effect during the run: email, Amazon SES send (aws ses send-email) |",
      "| Protected paths | 0 | No file under [review] high_risk_paths |",
      "| Size | 0 | 6 changed lines in 1 file |",
      "| New dependencies | 0 | No new dependencies |",
      "| Tests | 0 | Tests ran and passed |",
      "| Guardrail blocks | 0 | No guardrail blocks during the run |",
      "| Revert rate | 0 | claude_code claude-sonnet-4-5: 1 of 40 commits reverted in the last 90 days (3%) |",
    ]);
    expect(check.text).not.toContain("Missing inputs");
  });

  it("escapes table pipes in what was found", () => {
    const result = scoreRisk(
      {
        files: [{ path: "src/auth/a|b.ts", additions: 1, deletions: 0 }],
      },
      policy,
    );
    expect(riskCheck(result, policy).text).toContain("src/auth/a\\|b.ts");
  });
});

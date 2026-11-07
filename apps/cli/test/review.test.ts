import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProgram } from "../src/program.js";
import { run, tempDir } from "./run.js";

const RISK_TOML = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "fixtures", "risk", "selfhost.toml"),
  "utf8",
);

/** A repository with one commit on main and one on a topic branch, checked out. */
function repo(change: Record<string, string>, toml: string | null = RISK_TOML) {
  process.env.GIT_CONFIG_GLOBAL = devNull;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  const dir = tempDir("review");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Alice Example",
    GIT_AUTHOR_EMAIL: "alice@example.com",
    GIT_AUTHOR_DATE: "2026-10-01T10:00:00Z",
    GIT_COMMITTER_NAME: "Alice Example",
    GIT_COMMITTER_EMAIL: "alice@example.com",
    GIT_COMMITTER_DATE: "2026-10-01T10:00:00Z",
  };
  const git = (...args: string[]) => execFileSync("git", ["-C", dir.root, ...args], { env });
  git("init", "-q", "-b", "main");
  dir.write("README.md", "acme\n");
  if (toml !== null) dir.write("selfhost.toml", toml);
  git("add", ".");
  git("commit", "-q", "-m", "Initial");
  git("checkout", "-q", "-b", "topic");
  for (const [path, content] of Object.entries(change)) dir.write(path, content);
  git("add", ".");
  git("commit", "-q", "-m", "Change");
  return dir;
}

/** No ledger: a data folder that does not exist, never the real ~/.selfhost/data. */
const noLedger = () => ({ SELFHOST_DATA_DIR: tempDir("data").path("none") });

describe("selfhost review risk", () => {
  it("is registered on the program", () => {
    const review = createProgram().commands.find((command) => command.name() === "review");
    expect(review?.commands.map((command) => command.name())).toEqual(["risk", "brief", "trace"]);
  });

  it("prints the label and the check result with the inputs and what was missing", async () => {
    const dir = repo({ "src/auth/session.ts": "export const ttl = 60;\n" });
    const result = await run(["review", "risk", "--base", "main", "--tests", "passed"], {
      cwd: dir.root,
      env: noLedger(),
    });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain("1 commit since ");
    expect(result.out).toContain("Label: selfhost:risk-high");
    expect(result.out).toContain("Check: selfhost/risk: High risk (score 70)");
    expect(result.out).toContain(
      "| Protected paths | 40, sets high | 1 file under [review] high_risk_paths: src/auth/session.ts |",
    );
    expect(result.out).toContain(
      "Missing: outside effects (no ledger); guardrail blocks (no ledger); revert rate (no agent attributed to these commits).",
    );
  });

  it("prints JSON with the label, the check result and the score", async () => {
    const dir = repo({ "docs/guide.md": "hello\n" });
    const result = await run(["review", "risk", "--base", "main", "--json"], {
      cwd: dir.root,
      env: noLedger(),
    });
    const report = JSON.parse(result.out);
    expect(report).toMatchObject({
      schema: "selfhost.review_risk/v1",
      label: "selfhost:risk-low",
      check: { name: "selfhost/risk", title: "Low risk (score 0)" },
      risk: { level: "low", score: 0 },
      agent: null,
    });
    expect(report.config).toMatch(/selfhost\.toml$/);
    expect(report.risk.missing.map((m: { input: string }) => m.input)).toEqual([
      "outside_effects",
      "tests",
      "guardrails",
      "reverts",
    ]);
  });

  it("uses the defaults when the repository has no selfhost.toml", async () => {
    const dir = repo({ "src/auth/session.ts": "x\n" }, null);
    const result = await run(["review", "risk", "--base", "main", "--json"], {
      cwd: dir.root,
      env: noLedger(),
    });
    const report = JSON.parse(result.out);
    expect(report.config).toBeNull();
    expect(report.risk.missing).toContainEqual({
      input: "protected_paths",
      reason: "no [review] high_risk_paths in selfhost.toml",
    });
  });

  it.each([
    [[], "Pass a pull request number or --base <ref>"],
    [["12", "--base", "main"], "Pass a pull request number or --base <ref>"],
    [["twelve"], 'Expected a pull request number, got "twelve"'],
    [
      ["--base", "main", "--tests", "green"],
      '--tests: expected passed, failed or not-run, got "green"',
    ],
  ])("exits 1 on %j", async (args, message) => {
    const dir = repo({ "a.txt": "a\n" });
    const result = await run(["review", "risk", ...args, "--json"], {
      cwd: dir.root,
      env: noLedger(),
    });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({
      schema: "selfhost.error/v1",
      error: expect.stringContaining(message),
    });
  });
});

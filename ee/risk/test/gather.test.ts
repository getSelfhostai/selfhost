import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Ledger, MEMORY_DATA_DIR, openLedger } from "@selfhost/ledger";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { gatherRiskInputs, reviewRisk, scoreRisk } from "../src/index.js";
import {
  CLAUDE_SONNET,
  commitCreated,
  config,
  FIXTURE_TOML,
  GITHUB_FIXTURES,
  lines,
  policyEvaluated,
  sessionStarted,
  TempRepo,
  toolCalled,
} from "./helpers.js";

const NOW = new Date("2026-10-06T12:00:00Z");
const policy = config(FIXTURE_TOML);

let ledger: Ledger;
const repos: TempRepo[] = [];
const dirs: string[] = [];

beforeAll(async () => {
  ledger = await openLedger({ dataDir: MEMORY_DATA_DIR });
});

afterAll(async () => {
  await ledger.close();
});

afterEach(() => {
  for (const repo of repos.splice(0)) repo.remove();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newRepo(): TempRepo {
  const repo = new TempRepo();
  repos.push(repo);
  return repo;
}

/** Six commits by claude_code on claude-sonnet-4-5 in September, two of them reverted later. */
function agentHistory(repo: TempRepo): void {
  const shas: string[] = [];
  for (let day = 1; day <= 6; day++) {
    shas.push(
      repo.commit({
        message: `Tune helper ${day}\n\n${CLAUDE_SONNET}`,
        at: `2026-09-0${day}T10:00:00Z`,
        files: { [`src/lib/helper${day}.ts`]: lines(5, `helper ${day}`) },
      }),
    );
  }
  repo.revert(shas[1] as string, "2026-09-10T10:00:00Z");
  repo.revert(shas[4] as string, "2026-09-11T10:00:00Z");
}

describe("gatherRiskInputs from local commits", () => {
  it("reads the diff, new dependencies, the run, guardrail blocks and the revert rate", async () => {
    const repo = newRepo();
    repo.commit({
      message: "Initial",
      at: "2026-08-20T10:00:00Z",
      files: {
        "package.json": JSON.stringify({ dependencies: { hono: "^4.13.0" } }, null, 2),
        "src/app.ts": lines(20, "app"),
      },
    });
    agentHistory(repo);
    repo.git("checkout", "-q", "-b", "feature/limits");
    const c1 = repo.commit({
      message: `Add limiter\n\n${CLAUDE_SONNET}`,
      at: "2026-10-05T09:10:00Z",
      files: {
        "src/limiter.ts": lines(40, "limiter"),
        "package.json": JSON.stringify(
          { dependencies: { hono: "^4.14.0", ioredis: "^5.4.0" } },
          null,
          2,
        ),
      },
    });
    const c2 = repo.commit({
      message: "Wire limiter",
      at: "2026-10-05T09:40:00Z",
      files: { "src/app.ts": `${lines(20, "app")}limiter()\n` },
    });

    // sess-1 edited both commits' files in this repository; sess-3 made c1 and published.
    const kubectl = toolCalled("sess-1", "2026-10-05T09:38:00Z", "Bash", {
      type: "command",
      value: "kubectl -n prod apply -f k8s/limits.yaml",
    });
    await ledger.append([
      sessionStarted("sess-1", "2026-10-05T09:00:00Z", repo.dir),
      toolCalled("sess-1", "2026-10-05T09:05:00Z", "Write", {
        type: "file",
        value: join(repo.dir, "src/limiter.ts"),
      }),
      toolCalled("sess-1", "2026-10-05T09:35:00Z", "Edit", { type: "file", value: "src/app.ts" }),
      kubectl,
      policyEvaluated("sess-1", "2026-10-05T09:38:00Z", kubectl, {
        rule_id: "no-prod-kubectl",
        verdict: "block",
        mode: "observe",
      }),
      // The same hit recorded again after the policy file changed.
      policyEvaluated("sess-1", "2026-10-05T09:38:00Z", kubectl, {
        rule_id: "no-prod-kubectl",
        verdict: "block",
        mode: "observe",
      }),
      sessionStarted("sess-2", "2026-10-05T09:00:00Z", "/home/dev/other"),
      toolCalled("sess-2", "2026-10-05T09:36:00Z", "Edit", { type: "file", value: "src/app.ts" }),
      toolCalled("sess-2", "2026-10-05T09:37:00Z", "Bash", {
        type: "command",
        value: "terraform apply -auto-approve",
      }),
      sessionStarted("sess-3", "2026-10-05T08:00:00Z", "/home/dev/scratch"),
      commitCreated("sess-3", "2026-10-05T09:10:30Z", c1.slice(0, 7)),
      toolCalled("sess-3", "2026-10-05T09:20:00Z", "Bash", {
        type: "command",
        value: "npm publish --access public",
      }),
    ]);

    const { target, inputs } = await gatherRiskInputs({
      repoDir: repo.dir,
      target: { base: "main" },
      ledger,
      now: NOW,
    });

    expect(target.commits).toEqual([c1, c2]);
    expect(target.head).toBe(c2);
    expect(inputs.files.map((f) => f.path).sort()).toEqual([
      "package.json",
      "src/app.ts",
      "src/limiter.ts",
    ]);
    expect(inputs.dependencies).toEqual([{ manifest: "package.json", name: "ioredis" }]);
    expect(inputs.agent).toEqual({ vendor: "claude_code", model: "claude-sonnet-4-5" });
    expect(inputs.run?.sessions).toEqual(["sess-1", "sess-3"]);
    expect(inputs.run?.toolCalls.map((c) => c.command ?? c.path)).toEqual([
      "src/limiter.ts",
      "src/app.ts",
      "kubectl -n prod apply -f k8s/limits.yaml",
      "npm publish --access public",
    ]);
    expect(inputs.run?.guardrails).toEqual([
      { rule_id: "no-prod-kubectl", verdict: "block", mode: "observe", irreversible: false },
    ]);
    expect(inputs.reverts).toEqual({
      agent: { vendor: "claude_code", model: "claude-sonnet-4-5" },
      commits: 6,
      reverted: 2,
      days: 90,
    });
    expect(inputs.tests).toBeUndefined();
    expect(inputs.unavailable).toEqual({ tests: "no sandbox run yet" });

    const result = scoreRisk(inputs, policy);
    expect(result.level).toBe("high");
    expect(result.reasons[0]).toContain("infrastructure, kubectl write (kubectl -n prod apply)");
    expect(result.reasons[0]).toContain("publish, package publish (npm publish)");
    expect(result.missing).toEqual([{ input: "tests", reason: "no sandbox run yet" }]);
  });

  it("names the run inputs as missing without a ledger or a matching session", async () => {
    const repo = newRepo();
    repo.commit({ message: "Initial", at: "2026-09-20T10:00:00Z", files: { "a.txt": "a\n" } });
    repo.git("checkout", "-q", "-b", "topic");
    repo.commit({ message: "Docs", at: "2026-10-05T10:00:00Z", files: { "README.md": "hi\n" } });

    const none = await gatherRiskInputs({
      repoDir: repo.dir,
      target: { base: "main" },
      tests: "passed",
      now: NOW,
    });
    expect(none.inputs.run).toBeUndefined();
    expect(none.inputs.unavailable).toEqual({
      outside_effects: "no ledger",
      guardrails: "no ledger",
      reverts: "no agent attributed to these commits",
    });
    expect(none.inputs.tests).toBe("passed");
    expect(scoreRisk(none.inputs, policy).level).toBe("low");

    const unmatched = await gatherRiskInputs({
      repoDir: repo.dir,
      target: { base: "main" },
      ledger,
      now: NOW,
    });
    expect(unmatched.inputs.unavailable?.guardrails).toBe(
      "no session in the ledger made or edited these commits",
    );
  });

  it("refuses a base with no new commits", async () => {
    const repo = newRepo();
    repo.commit({ message: "Initial", at: "2026-09-20T10:00:00Z", files: { "a.txt": "a\n" } });
    await expect(
      gatherRiskInputs({ repoDir: repo.dir, target: { base: "main" }, now: NOW }),
    ).rejects.toThrow("No commits on HEAD since main");
  });
});

const REPO_FIXTURES = join(GITHUB_FIXTURES, "repos", "acme", "acme-api");

/** Recorded `gh api` responses; fails on anything else, and on any request that is not a GET. */
function recordedGh() {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (
      args[0] !== "api" ||
      args.some((arg) => /^(?:-X|--method|-f|-F|--field|--input)$/.test(arg))
    ) {
      throw new Error(`not a read: gh ${args.join(" ")}`);
    }
    const endpoint = args[args.length - 1] ?? "";
    const [path = "", query = ""] = endpoint.split("?");
    const params = new URLSearchParams(query);
    const contents = /^repos\/acme\/acme-api\/contents\/(.+)$/.exec(path);
    const file = contents
      ? join(
          REPO_FIXTURES,
          "contents",
          params.get("ref") ?? "",
          decodeURIComponent(contents[1] ?? ""),
        )
      : join(GITHUB_FIXTURES, `${path}.json`);
    try {
      return readFileSync(file, "utf8");
    } catch {
      throw new Error(`gh: HTTP 404 for ${endpoint}`);
    }
  };
  return { run, calls };
}

describe("gatherRiskInputs from a pull request", () => {
  it("reads the pull request through gh, attributes it, and joins the run by commit", async () => {
    const repo = newRepo();
    repo.git("remote", "add", "origin", "https://github.com/acme/acme-api.git");
    repo.commit({ message: "Initial", at: "2026-08-20T10:00:00Z", files: { "a.txt": "a\n" } });
    agentHistory(repo);
    const stripe = toolCalled("sess-pr", "2026-10-05T09:30:00Z", "Bash", {
      type: "command",
      value: "stripe refunds create --charge ch_123",
    });
    await ledger.append([
      sessionStarted("sess-pr", "2026-10-05T09:00:00Z", "/home/dev/acme-api"),
      commitCreated("sess-pr", "2026-10-05T09:10:00Z", "4aecb7e"),
      stripe,
    ]);
    const gh = recordedGh();
    const cacheDir = mkdtempSync(join(tmpdir(), "selfhost-risk-gh-"));
    dirs.push(cacheDir);

    const report = await reviewRisk({
      repoDir: repo.dir,
      pr: "101",
      config: policy,
      ledger,
      now: NOW,
      gh: gh.run,
      ghCacheDir: cacheDir,
    });

    expect(report.target).toMatchObject({
      pr: { repo: "acme/acme-api", number: 101, url: "https://github.com/acme/acme-api/pull/101" },
      base: "c3b8739bdcca2b4e2f5bdead2a8f238916813446",
      head: "5786c5c9d81ca4218b7e44bf0007f5580f66c489",
      commits: [
        "4aecb7e7824bd03b38804b1f8df5e841c7ab8ade",
        "5786c5c9d81ca4218b7e44bf0007f5580f66c489",
      ],
    });
    expect(report.agent).toEqual({ vendor: "claude_code", model: "claude-sonnet-4-5" });
    expect(report.label).toBe("selfhost:risk-high");
    expect(report.risk.factors.find((f) => f.input === "dependencies")?.detail).toBe(
      "2 new dependencies: ioredis (package.json), tsx (package.json)",
    );
    expect(report.risk.factors.find((f) => f.input === "reverts")?.detail).toBe(
      "claude_code claude-sonnet-4-5: 2 of 6 commits reverted in the last 90 days (33%)",
    );
    expect(report.risk.reasons[0]).toContain("payment, Stripe CLI write (stripe refunds create)");
    expect(report.check.summary).toContain("Missing: tests (no sandbox run yet).");
    expect(gh.calls.every((args) => args[0] === "api")).toBe(true);
    expect(gh.calls.map((args) => args[args.length - 1])).toContain(
      "repos/acme/acme-api/contents/package.json?ref=5786c5c9d81ca4218b7e44bf0007f5580f66c489",
    );
  });

  it("names a pull request it cannot place on GitHub", async () => {
    const repo = newRepo();
    repo.commit({ message: "Initial", at: "2026-09-20T10:00:00Z", files: { "a.txt": "a\n" } });
    await expect(
      reviewRisk({ repoDir: repo.dir, pr: "101", config: policy, now: NOW }),
    ).rejects.toThrow("Pass --base <ref> to use the local commits instead");
  });
});

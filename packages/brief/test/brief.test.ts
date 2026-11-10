import { createHash } from "node:crypto";
import { join } from "node:path";
import { EVENT_SCHEMA, type LedgerEvent } from "@selfhost/schema";
import { traceIdOf } from "@selfhost/traces";
import { describe, expect, it } from "vitest";
import {
  BRIEF_MARKER,
  BRIEF_SECTIONS,
  type Brief,
  buildBrief,
  GITHUB_COMMENT_LIMIT,
  isBriefComment,
  renderBrief,
  summarizeBrief,
} from "../src/index.js";
import { FIXTURE_NAMES, fixture } from "./helpers.js";

const SNAPSHOTS = join(import.meta.dirname, "__snapshots__");
const HEADINGS = [
  "### Task",
  "### Plan",
  "### Lines to look at",
  "### Files touched",
  "### Commands run",
  "### Tests run",
  "### Blocked actions",
  "### Cost",
  "### Trace",
];

const anchor = (path: string) => createHash("sha256").update(path).digest("hex");

describe("renderBrief on fixture runs", () => {
  it.each(FIXTURE_NAMES)("matches the snapshot for %s", async (name) => {
    const markdown = renderBrief(buildBrief(fixture(name)));
    await expect(markdown).toMatchFileSnapshot(join(SNAPSHOTS, `${name}.md`));
  });

  it.each(FIXTURE_NAMES)(
    "starts with the marker and has every section once, in order, for %s",
    (name) => {
      const markdown = renderBrief(buildBrief(fixture(name)));
      expect(markdown.split("\n")[0]).toBe(BRIEF_MARKER);
      expect(isBriefComment(markdown)).toBe(true);
      const headings = markdown.split("\n").filter((line) => line.startsWith("### "));
      expect(headings).toEqual(HEADINGS);
    },
  );

  it("gives the same text for the same run, whatever order the events come in", () => {
    const inputs = fixture("agent-pr");
    const events = inputs.run?.events ?? [];
    const shuffled = [...events].reverse();
    const rotated = [...events.slice(7), ...events.slice(0, 7)];
    const once = renderBrief(buildBrief(inputs));
    for (const order of [shuffled, rotated]) {
      const run = { sessions: inputs.run?.sessions ?? [], events: order };
      expect(renderBrief(buildBrief({ ...inputs, run }))).toBe(once);
    }
  });
});

describe("summarizeBrief", () => {
  it("gives one paragraph for the check run: size, lines to look at, tests and blocks", () => {
    expect(summarizeBrief(buildBrief(fixture("agent-pr")))).toBe(
      "Agent: `claude_code claude-sonnet-4-5`. 2 commits, 8 files, +37 -14, 2 agent sessions. 6 lines to look at. 3 test runs. The last run passed. 2 blocked actions.",
    );
    expect(summarizeBrief(buildBrief(fixture("local")))).toBe(
      "Agent: `codex gpt-5-codex`. 2 commits, 2 files, +6 -1, 1 agent session. 1 line to look at. No tests ran in this run.",
    );
  });

  it("says why there is no run instead of the tests", () => {
    expect(summarizeBrief(buildBrief(fixture("no-run")))).toBe(
      "No agent attributed. 1 commit, 2 files, +3 -2. Nothing flagged to look at. No trace found: no session in the ledger made or edited these commits.",
    );
  });
});

describe("buildBrief", () => {
  it("fills every section from a full run", () => {
    const brief = buildBrief(fixture("agent-pr"));
    expect(brief.task).toEqual({
      title: "Add per-key rate limiting to the public API",
      titleFrom: "pull_request",
      description: "Adds a token bucket per API key so one noisy client cannot starve the others.",
      prompt:
        "Add per-key rate limiting to the public API. Keep the counters in Redis and default to 100 requests a minute per key.",
    });
    expect(brief.plan.steps).toEqual([
      "Count requests per key in Redis",
      "Return 429 from the public API middleware when a key is over its limit",
      "Tune the limit per plan tier",
    ]);
    expect(brief.plan.updates.map((u) => u.tool)).toEqual(["TodoWrite", "TodoWrite"]);
    // One source per session: the local log's copy of `pnpm add ioredis` is not counted again.
    expect(brief.commands.map((c) => [c.command, c.result])).toEqual([
      ["pnpm add ioredis", "unknown"],
      ["pnpm vitest run src/middleware", "failed"],
      ["pnpm vitest run src/middleware", "passed"],
      ['psql -h db.prod.acme.example.com -c "select count(*) from api_keys"', "no_result"],
      ['git commit -m "Add per-key rate limiting"', "no_result"],
      ["git push --force origin agent/rate-limit", "no_result"],
      ["git push origin agent/rate-limit", "unknown"],
      ["pnpm test", "passed"],
      ["pnpm lint", "passed"],
    ]);
    expect(brief.tests.map((t) => [t.command, t.result, t.error])).toEqual([
      ["pnpm vitest run src/middleware", "failed", "AssertionError: expected 429 to be 200"],
      ["pnpm vitest run src/middleware", "passed", undefined],
      ["pnpm test", "passed", undefined],
    ]);
    expect(brief.blocked).toMatchObject([
      { rule_id: "prod-database", verdict: "block", mode: "observe", irreversible: true },
      { rule_id: "no-force-push", verdict: "block", mode: "enforce", irreversible: false },
    ]);
    // OpenTelemetry is preferred over the local logs for the first session's cost.
    expect(brief.cost).toEqual({
      usd: 0.9256,
      estimated: "some",
      requests: 4,
      tokens: 506_900,
      sessions: 2,
      models: ["claude-haiku-4-5", "claude-sonnet-4-5", "gpt-5-codex"],
    });
    // Sessions in the order they started.
    expect(brief.trace.map((s) => s.url)).toEqual([
      "https://selfhost.acme.example.com/?screen=run&run=5f0c2b1e-7d4a-4c8e-9a51-3e2d1c0b9a87",
      "https://selfhost.acme.example.com/?screen=run&run=0199f2a4-6c1d-7e3b-9f20-5b8c7d6e4a31",
    ]);
    expect(brief.notes).toEqual({});
  });

  it("also links each run to the team's tracer when [integrations.tracer] has a run_url", () => {
    const inputs = fixture("agent-pr");
    const brief = buildBrief({
      ...inputs,
      tracer: { tool: "langfuse", run_url: "https://langfuse.example.com/trace/{trace_id}" },
    });
    const [first] = brief.trace;
    expect(first?.tracerUrl).toBe(
      `https://langfuse.example.com/trace/${traceIdOf("5f0c2b1e-7d4a-4c8e-9a51-3e2d1c0b9a87")}`,
    );
    expect(renderBrief(brief)).toContain(
      `[run view](https://selfhost.acme.example.com/?screen=run&run=5f0c2b1e-7d4a-4c8e-9a51-3e2d1c0b9a87), [trace in Langfuse](${first?.tracerUrl})`,
    );
    expect(buildBrief({ ...inputs, tracer: { tool: "otlp" } }).trace[0]?.tracerUrl).toBeUndefined();
  });

  it("links each risky line to its line in the pull request's diff view", () => {
    const brief = buildBrief(fixture("agent-pr"));
    const pull = "https://github.com/acme/acme-api/pull/142/files";
    expect(brief.risky).toEqual([
      {
        kind: "protected_path",
        path: "db/migrations/0042_rate_limits.sql",
        line: 1,
        side: "new",
        detail: "db/migrations/**",
        url: `${pull}#diff-${anchor("db/migrations/0042_rate_limits.sql")}R1`,
      },
      {
        kind: "protected_path",
        path: "src/auth/keys.ts",
        line: 20,
        side: "new",
        detail: "src/auth/**",
        url: `${pull}#diff-${anchor("src/auth/keys.ts")}R20`,
      },
      {
        kind: "new_dependency",
        path: "package.json",
        line: 16,
        side: "new",
        detail: "ioredis",
        url: `${pull}#diff-${anchor("package.json")}R16`,
      },
      {
        kind: "deleted_test_file",
        path: "test/legacy-limits.test.ts",
        side: "old",
        detail: "2 tests",
        url: `${pull}#diff-${anchor("test/legacy-limits.test.ts")}`,
      },
      {
        kind: "deleted_test",
        path: "src/billing/invoice.test.ts",
        line: 44,
        side: "old",
        detail: 'it("applies the rate limit surcharge", () => {',
        url: `${pull}#diff-${anchor("src/billing/invoice.test.ts")}L44`,
      },
      {
        kind: "skipped_test",
        path: "src/middleware/rate-limit.test.ts",
        line: 9,
        side: "new",
        detail: "it.skip",
        url: `${pull}#diff-${anchor("src/middleware/rate-limit.test.ts")}R9`,
      },
    ]);
  });

  it("links local commits to the file at the head commit when the repository is on GitHub", () => {
    const inputs = fixture("local");
    const brief = buildBrief({ ...inputs, target: { ...inputs.target, repo: "acme/acme-api" } });
    expect(brief.risky[0]?.url).toBe(
      `https://github.com/acme/acme-api/blob/${inputs.target.head}/src/auth/session.ts#L31`,
    );
    expect(buildBrief(inputs).risky[0]).toEqual({
      kind: "protected_path",
      path: "src/auth/session.ts",
      line: 31,
      side: "new",
      detail: "src/auth/**",
    });
  });

  it("says why every empty section is empty instead of leaving it out", () => {
    const brief = buildBrief(fixture("no-run"));
    const noRun = "no agent run was found";
    expect(brief.notes).toEqual({
      plan: [`No plan recorded: the description has no Plan section, and ${noRun}.`],
      risky_lines: [
        "Nothing flagged: no changes under protected paths, no new dependencies, and no deleted or skipped tests.",
        "Protected paths not checked: selfhost.toml has no [review] high_risk_paths.",
        "New dependencies not checked: could not read package.json from GitHub.",
      ],
      commands: [`No commands known: ${noRun}.`],
      tests: [`No tests known: ${noRun}.`],
      blocked: [`No blocked actions known: ${noRun}.`],
      cost: [`No cost known: ${noRun}.`],
      trace: ["No trace found: no session in the ledger made or edited these commits."],
    });
    const markdown = renderBrief(brief);
    for (const section of BRIEF_SECTIONS) {
      for (const note of brief.notes[section] ?? []) {
        expect(markdown).toContain(note.replace(/[[\]]/g, "\\$&"));
      }
    }
  });

  it("says no tests ran when the run has no test command, and that prompts were not stored", () => {
    const brief = buildBrief(fixture("local"));
    expect(brief.tests).toEqual([]);
    expect(brief.notes).toEqual({
      task: ["The run's prompts were not stored."],
      tests: ["No tests ran in this run."],
      blocked: ["No actions were blocked."],
      cost: ["No cost recorded for this run."],
    });
    expect(brief.trace).toEqual([
      {
        id: "a3d5f7b9-1c2e-4a6b-8d0f-2e4c6a8b0d1f",
        agent: "codex",
        start: "2026-10-14T15:00:00.000Z",
        end: "2026-10-14T15:04:00.000Z",
        events: 6,
        command: "selfhost review trace a3d5f7b9-1c2e-4a6b-8d0f-2e4c6a8b0d1f",
      },
    ]);
  });
});

describe("package installs", () => {
  const session = "a3d5f7b9-1c2e-4a6b-8d0f-2e4c6a8b0d1f";
  let counter = 0;
  /** A policy.evaluated event from the package guard, as the pre-tool hook records it. */
  function packageHit(
    ruleId: string,
    verdict: "block" | "ask",
    mode: "observe" | "enforce",
    command: string,
    reason: string,
  ): LedgerEvent {
    counter += 1;
    const id = `0199e2b0-0000-7000-8000-${String(counter).padStart(12, "0")}`;
    return {
      id,
      schema: EVENT_SCHEMA,
      ts: `2026-10-14T15:0${counter}:30.000Z`,
      source: "hook",
      kind: "policy.evaluated",
      actor: { kind: "system", id: "selfhost-policy" },
      agent: { vendor: "codex" },
      session_id: session,
      tool: { name: "exec_command" },
      target: { type: "command", value: command },
      decision: { verdict, by: "selfhost-policy", reason, rule_id: ruleId, mode },
      data: { tool_event_id: `tool-${counter}` },
    };
  }

  function withHits(events: LedgerEvent[]) {
    const inputs = fixture("local");
    const run = {
      sessions: inputs.run?.sessions ?? [],
      events: [...(inputs.run?.events ?? []), ...events],
    };
    return buildBrief({ ...inputs, run });
  }

  it("lists package blocks and flags as installs, and notes installs that went unchecked", () => {
    const brief = withHits([
      packageHit(
        "packages.not_found",
        "block",
        "enforce",
        "npm i react-hooks-form-validator-pro",
        "npm has no package named react-hooks-form-validator-pro.",
      ),
      packageHit(
        "packages.too_new",
        "ask",
        "observe",
        "pip install fresh-lib",
        "fresh-lib 0.1.0 (PyPI) was published 2 days ago; [packages] min_age_days is 7.",
      ),
      packageHit(
        "packages.unchecked",
        "ask",
        "observe",
        "cargo add serde",
        "Could not fully check serde (crates.io): deps.dev did not answer within 3000 ms. It was not blocked.",
      ),
    ]);
    expect(brief.blocked.map((b) => [b.rule_id, b.verdict, b.mode, b.target])).toEqual([
      ["packages.not_found", "block", "enforce", "npm i react-hooks-form-validator-pro"],
      ["packages.too_new", "ask", "observe", "pip install fresh-lib"],
    ]);
    expect(brief.notes.blocked).toEqual([
      "1 package install could not be checked against its registry in time and went ahead unchecked (packages.unchecked in the trace).",
    ]);
    const markdown = renderBrief(brief);
    expect(markdown).toContain(
      "- `packages.not_found` blocked the install `npm i react-hooks-form-validator-pro`: npm has no package named react-hooks-form-validator-pro.",
    );
    expect(markdown).toContain(
      "- `packages.too_new` flagged the install (observe mode) `pip install fresh-lib`: fresh-lib 0.1.0 (PyPI) was published 2 days ago; \\[packages\\] min_age_days is 7.",
    );
    expect(summarizeBrief(brief)).toContain("2 blocked actions.");
  });

  it("says so when the only package note is an unchecked install", () => {
    const brief = withHits([
      packageHit(
        "packages.unchecked",
        "ask",
        "observe",
        "npm i a",
        "Could not fully check a (npm).",
      ),
      packageHit(
        "packages.unchecked",
        "ask",
        "observe",
        "npm i b",
        "Could not fully check b (npm).",
      ),
    ]);
    expect(brief.blocked).toEqual([]);
    expect(brief.notes.blocked).toEqual([
      "No actions were blocked.",
      "2 package installs could not be checked against their registries in time and went ahead unchecked (packages.unchecked in the trace).",
    ]);
  });
});

describe("the comment size limit", () => {
  function huge(): Brief {
    const brief = buildBrief(fixture("agent-pr"));
    const path = (i: number) => `src/modules/${"deep/".repeat(40)}module-${i}.ts`;
    const files = Array.from({ length: 3000 }, (_, i) => ({
      path: path(i),
      status: "added" as const,
      additions: 10,
      deletions: 0,
      protected: false,
    }));
    const command = (i: number) => ({
      command: `pnpm vitest run ${"x".repeat(100)} ${i}`,
      tool: "Bash",
      session: "s",
      ts: "2026-10-12T09:00:00.000Z",
      result: "failed" as const,
      error: "e".repeat(200),
      test: true,
    });
    const commands = Array.from({ length: 2000 }, (_, i) => command(i));
    return { ...brief, files, commands, tests: commands };
  }

  it("ends long lists with 'and N more' and stays under GitHub's limit", () => {
    const markdown = renderBrief(huge());
    expect(markdown.length).toBeLessThanOrEqual(GITHUB_COMMENT_LIMIT);
    expect(markdown).toContain("- and 2900 more");
    expect(markdown).toContain("- and 1970 more");
    expect(markdown.split("\n")[0]).toBe(BRIEF_MARKER);
  });

  it("shrinks the lists further for a smaller limit", () => {
    const markdown = renderBrief(huge(), { maxChars: 8000 });
    expect(markdown.length).toBeLessThanOrEqual(8000);
    expect(markdown.split("\n").filter((line) => line.startsWith("### "))).toEqual(HEADINGS);
  });
});

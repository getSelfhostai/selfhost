import { mkdirSync, readFileSync } from "node:fs";
import { REVIEWER_PINS } from "@selfhost/integrations";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { ReviewSetupReport } from "../src/review-setup.js";
import { run, tempDir } from "./run.js";

function repo(toml?: string) {
  const dir = tempDir("review-setup");
  mkdirSync(dir.path(".git"));
  if (toml) dir.write("selfhost.toml", toml);
  return dir;
}

describe("selfhost review setup", () => {
  it("writes a pinned PR-Agent workflow and names the secret, never a value", async () => {
    const dir = repo();
    const result = await run(["review", "setup", "pr-agent"], { cwd: dir.root });
    expect(result.code).toBe(0);
    expect(result.out).toContain("Wrote .github/workflows/selfhost-pr-agent.yml");
    expect(result.out).toContain("PR-Agent reviews agent pull requests only.");
    expect(result.out).toContain("Add the repository or org secret OPENAI_KEY");
    expect(result.out).toContain("Run selfhost integrations set reviewer pr-agent");
    const text = readFileSync(dir.path(".github/workflows/selfhost-pr-agent.yml"), "utf8");
    expect(text).toContain(`${REVIEWER_PINS.prAgent.tag}@${REVIEWER_PINS.prAgent.digest}`);
    const workflow = parseYaml(text);
    // The agent condition comes from the attribution signals, joined into one expression.
    expect(workflow.jobs.review.if).toContain(
      "startsWith(github.event.pull_request.head.ref, 'claude/')",
    );
    expect(workflow.jobs.review.if).not.toContain("\n");
  });

  it("takes the tool and settings from [integrations.reviewer], flags over them", async () => {
    const dir = repo(
      'version = 1\n[integrations.reviewer]\ntool = "claude-code-action"\napi_key_env = "ORG_ANTHROPIC_KEY"\nmodel = "claude-sonnet-4-5"\n',
    );
    const result = await run(["review", "setup", "--json", "--all-prs", "--style"], {
      cwd: dir.root,
    });
    const report = JSON.parse(result.out) as ReviewSetupReport;
    expect(report).toMatchObject({
      schema: "selfhost.review_setup/v1",
      tool: "claude-code-action",
      pull_requests: "all",
      files: [{ path: ".github/workflows/selfhost-claude-review.yml", status: "written" }],
      secrets: [{ name: "ORG_ANTHROPIC_KEY" }],
    });
    expect(report.next.join("\n")).not.toContain("integrations set reviewer");
    const step = parseYaml(
      readFileSync(dir.path(".github/workflows/selfhost-claude-review.yml"), "utf8"),
    ).jobs.review.steps[1];
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, kept as written.
    expect(step.with.anthropic_api_key).toBe("${{ secrets.ORG_ANTHROPIC_KEY }}");
    expect(step.with.claude_args).toContain("--model claude-sonnet-4-5");
    expect(step.with.prompt).toContain("Style, formatting and naming comments are welcome");
  });

  it("keeps a file that differs unless --force, and leaves an equal one alone", async () => {
    const dir = repo();
    dir.write(".coderabbit.yaml", "language: en-US\n");
    const kept = await run(["review", "setup", "coderabbit"], { cwd: dir.root });
    expect(kept.code).toBe(1);
    expect(kept.err).toContain(".coderabbit.yaml already exists and differs");
    expect(readFileSync(dir.path(".coderabbit.yaml"), "utf8")).toBe("language: en-US\n");

    expect(
      (await run(["review", "setup", "coderabbit", "--force"], { cwd: dir.root })).out,
    ).toContain("Replaced .coderabbit.yaml");
    const again = await run(["review", "setup", "coderabbit"], { cwd: dir.root });
    expect(again.out).toContain("Unchanged .coderabbit.yaml");
    expect(again.out).toContain("https://github.com/apps/coderabbitai");
  });

  it("prints without writing, and refuses a subscription login or an unknown reviewer", async () => {
    const dir = repo();
    const printed = await run(["review", "setup", "claude-code-action", "--print"], {
      cwd: dir.root,
    });
    expect(printed.out).toContain("# .github/workflows/selfhost-claude-review.yml");
    expect(printed.out).toContain("anthropics/claude-code-action@");

    const oauth = repo(
      'version = 1\n[integrations.reviewer]\ntool = "claude-code-action"\napi_key_env = "CLAUDE_CODE_OAUTH_TOKEN"\n',
    );
    const refused = await run(["review", "setup"], { cwd: oauth.root });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("personal subscription login");

    const unknown = await run(["review", "setup", "codex-action"], { cwd: dir.root });
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain(
      "Expected a reviewer of pr-agent, claude-code-action, coderabbit",
    );
    expect((await run(["review", "setup"], { cwd: dir.root })).err).toContain("Name the reviewer");
  });
});

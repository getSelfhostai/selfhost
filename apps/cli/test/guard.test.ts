import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GuardReport } from "../src/guard/commands.js";
import { run, tempDir } from "./run.js";

const SETTINGS = `${JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } }, null, 2)}\n`;
const CODEX = '# my settings\nmodel = "gpt-5.5"\n';

/** A home with Claude Code, Codex, Cursor, OpenCode and Goose configured, and a repository. */
function fixture() {
  const home = tempDir("guard-home");
  home.write(".claude/settings.json", SETTINGS);
  home.write(".codex/config.toml", CODEX);
  home.write(".cursor/cli-config.json", "{}\n");
  home.write(".config/opencode/opencode.json", "{}\n");
  home.write(".config/goose/config.yaml", "GOOSE_PROVIDER: openai\n");
  const repo = tempDir("guard-repo");
  mkdirSync(repo.path(".git"));
  return { home, repo };
}

const onPath = {
  which: (name: string) => (name === "selfhost" ? "/usr/local/bin/selfhost" : undefined),
};

async function guard(args: string[], home: string, cwd: string) {
  const result = await run(["guard", ...args, "--json", "--home", home], {
    cwd,
    probes: onPath,
  });
  return { ...result, report: JSON.parse(result.out) as GuardReport };
}

const hooksOf = (report: GuardReport) =>
  Object.fromEntries(report.agents.map((agent) => [agent.id, agent.hooks]));

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("selfhost guard install", () => {
  it("adds the pre-tool hook to each agent found and reports Goose as not covered", async () => {
    const { home, repo } = fixture();
    const { code, report } = await guard(["install"], home.root, repo.root);
    expect(code).toBe(0);
    expect(report.schema).toBe("selfhost.guard/v1");
    expect(report.hook_command).toBe("selfhost hook {agent}");
    expect(hooksOf(report)).toEqual({
      claude_code: "create",
      codex: "create",
      opencode: "create",
      goose: "unsupported",
      cursor: "create",
    });
    expect(report.agents.find((agent) => agent.id === "goose")).toMatchObject({
      covered: false,
      coverage: "not covered: Goose has no hooks",
    });

    // Claude Code: PreToolUse only, next to the user's own settings.
    const settings = readJson(home.path(".claude/settings.json"));
    expect(settings.permissions).toEqual({ allow: ["Bash(npm test)"] });
    expect(settings.hooks).toEqual({
      PreToolUse: [{ hooks: [{ type: "command", command: "selfhost hook claude_code" }] }],
    });

    // Codex: its own marked block, so it comes out apart from selfhost init's.
    const codex = readFileSync(home.path(".codex/config.toml"), "utf8");
    expect(codex.startsWith(CODEX)).toBe(true);
    expect(codex).toContain("# >>> selfhost guard >>>");
    expect(codex).toContain("# Written by `selfhost guard install`.");
    expect(codex.match(/^\[\[hooks\.\w+\]\]$/gm)).toEqual(["[[hooks.PreToolUse]]"]);
    expect(codex).toContain('command = "selfhost hook codex"');

    // Cursor: the four events that can stop a tool call.
    expect(readJson(home.path(".cursor/hooks.json"))).toEqual({
      version: 1,
      hooks: {
        preToolUse: [{ command: "selfhost hook cursor" }],
        beforeShellExecution: [{ command: "selfhost hook cursor" }],
        beforeReadFile: [{ command: "selfhost hook cursor" }],
        beforeMCPExecution: [{ command: "selfhost hook cursor" }],
      },
    });

    // OpenCode: a plugin that runs the hook command without a shell.
    const plugin = readFileSync(home.path(".config/opencode/plugins/selfhost.js"), "utf8");
    expect(plugin).toContain('const COMMAND = ["selfhost","hook","opencode"];');
    expect(plugin).toContain('ctx.tool.hook("execute.before"');
    expect(plugin).toContain('"tool.execute.before"');

    expect(report.policy).toMatchObject({ path: null, mode: "enforce" });
    expect(report.policy.checks.map((check) => check.mode)).toEqual(Array(6).fill("enforce"));
    expect(report.warnings).toContain(
      "Codex asks you to review new hooks with /hooks before they run.",
    );

    const again = await guard(["install"], home.root, repo.root);
    expect(Object.values(hooksOf(again.report)).filter((state) => state !== "unsupported")).toEqual(
      Array(4).fill("unchanged"),
    );
  });

  it("writes nothing on a dry run and installs only the agents named", async () => {
    const { home, repo } = fixture();
    const dry = await guard(["install", "--dry-run"], home.root, repo.root);
    expect(dry.report.dry_run).toBe(true);
    expect(readFileSync(home.path(".claude/settings.json"), "utf8")).toBe(SETTINGS);
    expect(existsSync(home.path(".cursor/hooks.json"))).toBe(false);

    const only = await guard(["install", "--agent", "claude"], home.root, repo.root);
    expect(hooksOf(only.report)).toMatchObject({ claude_code: "create", codex: "not found" });
    expect(readFileSync(home.path(".codex/config.toml"), "utf8")).toBe(CODEX);
  });

  it("reads the guardrails settings from the repository's selfhost.toml", async () => {
    const { home, repo } = fixture();
    repo.write(
      "selfhost.toml",
      'version = 1\n[guardrails]\nmode = "observe"\ndisable = ["guard.reset_hard"]\n',
    );
    const { report } = await guard(["status"], home.root, repo.root);
    expect(report.policy.path).toBe(repo.path("selfhost.toml"));
    expect(report.policy.mode).toBe("observe");
    expect(report.policy.checks.find((check) => check.rule_id === "guard.reset_hard")?.mode).toBe(
      "off",
    );
  });
});

describe("selfhost guard status and uninstall", () => {
  it("shows which agents are covered, then takes out only what install added", async () => {
    const { home, repo } = fixture();
    const before = await guard(["status"], home.root, repo.root);
    expect(hooksOf(before.report)).toEqual({
      claude_code: "missing",
      codex: "missing",
      opencode: "missing",
      goose: "unsupported",
      cursor: "missing",
    });
    await guard(["install"], home.root, repo.root);
    const after = await guard(["status"], home.root, repo.root);
    expect(hooksOf(after.report)).toEqual({
      claude_code: "installed",
      codex: "installed",
      opencode: "installed",
      goose: "unsupported",
      cursor: "installed",
    });

    const removed = await guard(["uninstall"], home.root, repo.root);
    expect(hooksOf(removed.report)).toMatchObject({
      claude_code: "remove",
      codex: "remove",
      opencode: "remove",
      cursor: "remove",
    });
    expect(readFileSync(home.path(".claude/settings.json"), "utf8")).toBe(SETTINGS);
    expect(readFileSync(home.path(".codex/config.toml"), "utf8")).toBe(CODEX);
    expect(existsSync(home.path(".cursor/hooks.json"))).toBe(false);
    expect(existsSync(home.path(".config/opencode/plugins/selfhost.js"))).toBe(false);
  });

  it("counts a hook selfhost init added as installed and leaves it on uninstall", async () => {
    const { home, repo } = fixture();
    const configured = await run(
      [
        "agents",
        "configure",
        "--agent",
        "claude",
        "--hook-command",
        "selfhost hook {agent}",
        "--home",
        home.root,
      ],
      { cwd: repo.root, probes: onPath },
    );
    expect(configured.code).toBe(0);
    const install = await guard(["install", "--agent", "claude"], home.root, repo.root);
    expect(hooksOf(install.report).claude_code).toBe("unchanged");
    const removed = await guard(["uninstall", "--agent", "claude"], home.root, repo.root);
    expect(hooksOf(removed.report).claude_code).toBe("missing");
    const status = await guard(["status"], home.root, repo.root);
    expect(hooksOf(status.report).claude_code).toBe("installed");
  });

  it("prints a readable table", async () => {
    const { home, repo } = fixture();
    const result = await run(["guard", "install", "--home", home.root], {
      cwd: repo.root,
      probes: onPath,
    });
    expect(result.out).toContain("Pre-tool hook: selfhost hook <agent>");
    expect(result.out).toMatch(/Claude Code\s+added\s+blocks and asks/);
    expect(result.out).toMatch(/Goose\s+unsupported\s+not covered: Goose has no hooks/);
    expect(result.out).toContain("guard.secret_read");
    expect(result.out).toContain("No account or server");
  });
});

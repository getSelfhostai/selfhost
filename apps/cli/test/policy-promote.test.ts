import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerPolicyEditing } from "../src/policy/editing.js";
import { promoteRule } from "../src/policy/promote.js";
import { createProgram } from "../src/program.js";
import { run, tempDir } from "./run.js";

const compat = join(import.meta.dirname, "..", "..", "..", "packages", "schema", "compat", "v1");
const config = (name: string) => readFileSync(join(compat, "config", name), "utf8");
const full = config("full.toml");

/** `old` replaced once in `text`, failing the test when it is not there exactly once. */
function edit(text: string, old: string, replacement: string): string {
  expect(text.split(old)).toHaveLength(2);
  return text.replace(old, replacement);
}

/** The embedded ledger in memory, so promotions never write to ~/.selfhost/data. */
const MEMORY = ["--data-dir", "memory://"];

const commented = `# Team policy. Every rule starts in observe.
version = 1

[[rules]]
  # Keep history linear.
  id = 'no-force-push'   # stable id
  mode = 'observe'       # promote after a week
  match = { tool = "Bash", command = "git\\\\s+push\\\\s+.*--force" }
  action = "block"
  message = "No force pushes."

[[rules]]
id = "ask-deploy"  # deploys
# Rest of the rule.
match.command = "^pnpm run deploy"
action = "ask"
message = "Deploys need a person."

[teams.web]
members = ["dana"]
`;

describe("promoteRule", () => {
  it("inserts a missing mode right after the id line", () => {
    const result = promoteRule(full, "no-force-push");
    expect(result).toMatchObject({ changed: true, from: "observe", to: "enforce", line: 20 });
    expect(result.text).toBe(
      edit(full, 'id = "no-force-push"\n', 'id = "no-force-push"\nmode = "enforce"\n'),
    );

    const rulesOnly = config("rules-only.toml");
    expect(promoteRule(rulesOnly, "ask-before-deploy").text).toBe(
      edit(rulesOnly, 'id = "ask-before-deploy"\n', 'id = "ask-before-deploy"\nmode = "enforce"\n'),
    );
  });

  it("replaces an existing mode and leaves the rest of the file alone", () => {
    const result = promoteRule(full, "no-prod-urls");
    expect(result).toMatchObject({ changed: true, from: "off", line: 38 });
    expect(result.text).toBe(edit(full, 'mode = "off"\n', 'mode = "enforce"\n'));

    // A rule with a [rules.match] sub-table below its mode line.
    const back = promoteRule(full, "protect-migrations", { to: "observe" });
    expect(back.text).toBe(
      edit(
        full,
        'id = "protect-migrations"\nmode = "enforce"\n',
        'id = "protect-migrations"\nmode = "observe"\n',
      ),
    );
    expect(promoteRule(full, "no-force-push", { to: "off" }).text).toBe(
      edit(full, 'id = "no-force-push"\n', 'id = "no-force-push"\nmode = "off"\n'),
    );
  });

  it("changes nothing when the rule is already in the target mode", () => {
    expect(promoteRule(full, "protect-migrations")).toEqual({
      text: full,
      changed: false,
      from: "enforce",
      to: "enforce",
      line: null,
    });
    // No mode line means observe, so observe adds nothing.
    expect(promoteRule(full, "no-force-push", { to: "observe" }).changed).toBe(false);
    expect(promoteRule(full, "no-force-push", { team: "platform" }).changed).toBe(false);
  });

  it("keeps comments, quote style, indentation and CRLF line endings", () => {
    const replaced = promoteRule(commented, "no-force-push");
    expect(replaced.text).toBe(
      edit(
        commented,
        "  mode = 'observe'       # promote after a week\n",
        "  mode = 'enforce'       # promote after a week\n",
      ),
    );
    expect(promoteRule(commented, "ask-deploy").text).toBe(
      edit(
        commented,
        'id = "ask-deploy"  # deploys\n',
        'id = "ask-deploy"  # deploys\nmode = "enforce"\n',
      ),
    );

    const noMode = edit(commented, "  mode = 'observe'       # promote after a week\n", "");
    expect(promoteRule(noMode, "no-force-push").text).toBe(
      edit(
        noMode,
        "  id = 'no-force-push'   # stable id\n",
        "  id = 'no-force-push'   # stable id\n  mode = 'enforce'\n",
      ),
    );

    const crlf = (text: string) => text.replaceAll("\n", "\r\n");
    expect(promoteRule(crlf(commented), "ask-deploy").text).toBe(
      crlf(promoteRule(commented, "ask-deploy").text),
    );
    expect(promoteRule(crlf(commented), "no-force-push").text).toBe(crlf(replaced.text));
    expect(promoteRule(crlf(full), "no-force-push", { team: "growth" }).text).toBe(
      crlf(promoteRule(full, "no-force-push", { team: "growth" }).text),
    );
  });

  it("changes an existing team override", () => {
    const result = promoteRule(full, "no-force-push", { team: "platform", to: "observe" });
    expect(result).toMatchObject({ changed: true, from: "enforce", to: "observe", line: 65 });
    expect(result.text).toBe(
      edit(
        full,
        '[teams.platform.rules.no-force-push]\nmode = "enforce"\n',
        '[teams.platform.rules.no-force-push]\nmode = "observe"\n',
      ),
    );

    const dotted = `${config("rules-only.toml")}\n[teams.web]\nrules.ask-before-deploy.mode = "observe" # for now\n`;
    expect(promoteRule(dotted, "ask-before-deploy", { team: "web" }).text).toBe(
      edit(dotted, 'deploy.mode = "observe" # for now', 'deploy.mode = "enforce" # for now'),
    );

    const noMode = `${config("rules-only.toml")}\n[teams.web.rules.ask-before-deploy]\nagents = ["codex"]\n`;
    expect(promoteRule(noMode, "ask-before-deploy", { team: "web" }).text).toBe(
      edit(noMode, "deploy]\n", 'deploy]\nmode = "enforce"\n'),
    );
  });

  it("adds a team override table at the end of the file", () => {
    const result = promoteRule(full, "no-force-push", { team: "growth" });
    expect(result).toMatchObject({ changed: true, from: "observe", line: 71 });
    expect(result.text).toBe(`${full}\n[teams.growth.rules.no-force-push]\nmode = "enforce"\n`);

    const dotted = `version = 1

[[rules]]
id = "ci.deploy"
match = { command = "deploy" }
action = "ask"
message = "Ask first."

[teams."web app"]`;
    expect(promoteRule(dotted, "ci.deploy", { team: "web app" }).text).toBe(
      `${dotted}\n\n[teams."web app".rules."ci.deploy"]\nmode = "enforce"\n`,
    );
  });

  it("refuses unknown rules and teams", () => {
    expect(() => promoteRule(full, "no-rm")).toThrow(
      'No rule "no-rm" in selfhost.toml. Rules: no-force-push, protect-migrations, no-prod-urls.',
    );
    expect(() => promoteRule(config("minimal.toml"), "no-rm")).toThrow(/It has no rules/);
    expect(() => promoteRule(full, "no-force-push", { team: "infra" })).toThrow(
      'No team "infra" in selfhost.toml. Teams: platform, growth.',
    );
    expect(() => promoteRule(full, "no-force-push", { to: "strict" as "off" })).toThrow(
      /Expected a mode/,
    );
  });

  it("refuses files it cannot edit safely", () => {
    expect(() => promoteRule("version = 1\n[[rules]]\nid = 7\n", "x")).toThrow(
      /selfhost.toml is not valid/,
    );
    const inline = `version = 1
rules = [{ id = "a", match = { tool = "Bash" }, action = "block", message = "m" }]
`;
    expect(() => promoteRule(inline, "a")).toThrow(/inline table.*edit it by hand/);

    const rulesOnly = config("rules-only.toml");
    const inlineOverride = `${rulesOnly}\n[teams.web.rules]\nask-before-deploy = { mode = "observe" }\n`;
    expect(() => promoteRule(inlineOverride, "ask-before-deploy", { team: "web" })).toThrow(
      /edit it by hand/,
    );
    const inlineNoMode = `${rulesOnly}\n[teams.web.rules]\nask-before-deploy = { agents = ["codex"] }\n`;
    expect(() => promoteRule(inlineNoMode, "ask-before-deploy", { team: "web" })).toThrow(
      /edit it by hand/,
    );

    // The new table would redefine the inline one, so the result does not parse.
    const inlineTable = `${rulesOnly}\n[teams.web]\nrules = {}\n`;
    expect(() => promoteRule(inlineTable, "ask-before-deploy", { team: "web" })).toThrow(
      /would leave selfhost.toml invalid, so nothing was written/,
    );
  });
});

describe("selfhost policy promote", () => {
  function repoWithConfig(text: string) {
    const repo = tempDir("promote");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo.root, ...args], { encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "dev@example.com");
    git("config", "user.name", "Dev");
    git("config", "commit.gpgsign", "false");
    repo.write("selfhost.toml", text);
    git("add", "selfhost.toml");
    git("commit", "-q", "-m", "Add selfhost.toml");
    return { ...repo, git };
  }

  /** Added and removed lines of the working-copy diff, without the file headers. */
  const changedLines = (diff: string) =>
    diff.split("\n").filter((line) => /^[+-](?![+-]{2} )/.test(line));

  it("writes the mode and prints the git diff, leaving the change unstaged", async () => {
    const repo = repoWithConfig(full);
    const result = await run(["policy", "promote", "no-force-push", ...MEMORY], {
      cwd: repo.root,
    });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "Rule no-force-push: observe to enforce in selfhost.toml, line 20.",
    );
    expect(result.out).toContain('+mode = "enforce"');

    const diff = repo.git("diff", "--", "selfhost.toml");
    expect(changedLines(diff)).toEqual(['+mode = "enforce"']);
    expect(changedLines(result.out)).toEqual(['+mode = "enforce"']);
    expect(repo.git("diff", "--cached", "--name-only")).toBe("");
    expect(repo.git("status", "--porcelain")).toBe(" M selfhost.toml\n");
    expect(readFileSync(repo.path("selfhost.toml"), "utf8")).toBe(
      promoteRule(full, "no-force-push").text,
    );
  });

  it("prints JSON for a team override", async () => {
    const repo = repoWithConfig(full);
    const result = await run(
      ["policy", "promote", "no-force-push", "--team", "growth", "--json", ...MEMORY],
      { cwd: repo.root },
    );
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(report).toMatchObject({
      schema: "selfhost.policy_promote/v1",
      config: repo.path("selfhost.toml"),
      rule: "no-force-push",
      team: "growth",
      from: "observe",
      to: "enforce",
      changed: true,
      decision_event_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(changedLines(report.diff)).toEqual([
      "+",
      "+[teams.growth.rules.no-force-push]",
      '+mode = "enforce"',
    ]);
  });

  it("exits 0 and writes nothing when the rule is already in that mode", async () => {
    const repo = repoWithConfig(full);
    const result = await run(["policy", "promote", "protect-migrations"], { cwd: repo.root });
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      "Rule protect-migrations is already in enforce mode in selfhost.toml. Nothing changed.",
    );
    expect(repo.git("status", "--porcelain")).toBe("");
  });

  it("fails on an unknown rule or mode and leaves the file as it was", async () => {
    const repo = repoWithConfig(full);
    const unknown = await run(["policy", "promote", "no-rm"], { cwd: repo.root });
    expect(unknown.code).toBe(1);
    expect(unknown.err).toMatch(/^No rule "no-rm"/);
    const json = await run(["policy", "promote", "no-rm", "--json"], { cwd: repo.root });
    expect(JSON.parse(json.out)).toMatchObject({ schema: "selfhost.error/v1" });
    const mode = await run(["policy", "promote", "no-force-push", "--to", "strict"], {
      cwd: repo.root,
    });
    expect(mode.err).toBe('--to: expected enforce, observe or off, got "strict"');
    expect(repo.git("status", "--porcelain")).toBe("");
  });

  it("says the file changed when it is not in a git repository", async () => {
    const dir = tempDir("promote-nogit");
    const file = dir.write("policy/selfhost.toml", full);
    const result = await run(["policy", "promote", "no-prod-urls", "--config", file, ...MEMORY], {
      cwd: dir.root,
    });
    expect(result.code).toBe(0);
    const lines = result.out.split("\n");
    expect(lines.slice(0, 2)).toEqual([
      `Rule no-prod-urls: off to enforce in ${join("policy", "selfhost.toml")}, line 38.`,
      "Not in a git repository, so there is no diff to show.",
    ]);
    expect(lines[2]).toMatch(/^Recorded decision [0-9a-f-]{36} in the ledger\.$/);
    expect(lines).toHaveLength(3);
    expect(readFileSync(file, "utf8")).toBe(promoteRule(full, "no-prod-urls").text);
  });

  it("finds no selfhost.toml and says how to pass one", async () => {
    const dir = tempDir("promote-none");
    execFileSync("git", ["-C", dir.root, "init", "-q"]);
    const result = await run(["policy", "promote", "no-force-push"], { cwd: dir.root });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/No selfhost.toml found.*--config/);
  });
});

describe("policy command group", () => {
  it("is registered with promote and report", () => {
    const policy = createProgram().commands.find((command) => command.name() === "policy");
    const sub = (name: string) => policy?.commands.find((command) => command.name() === name);
    expect(sub("promote")?.options.map((option) => option.long)).toEqual([
      "--team",
      "--to",
      "--reason",
      "--config",
      "--json",
      "--database",
      "--data-dir",
    ]);
    expect(sub("report")?.options.map((option) => option.long)).toEqual([
      "--since",
      "--config",
      "--json",
      "--database",
      "--data-dir",
    ]);
  });

  it("joins a policy group that already exists", () => {
    const program = new Command();
    program.command("policy").description("existing").command("check");
    registerPolicyEditing(
      program,
      () => ({ env: {}, cwd: "/", write: () => {} }),
      () => {},
    );
    const groups = program.commands.filter((command) => command.name() === "policy");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.description()).toBe("existing");
    expect(groups[0]?.commands.map((command) => command.name())).toEqual([
      "check",
      "promote",
      "report",
    ]);
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor } from "../src/doctor.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "selfhost-doctor-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".git"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

/** An empty folder for system paths, so no test reads this machine's managed settings. */
function noSystem(): string {
  const dir = mkdtempSync(join(tmpdir(), "selfhost-doctor-root-"));
  dirs.push(dir);
  return dir;
}

function run(cwd: string, config?: string, env: NodeJS.ProcessEnv = {}, json = false) {
  const lines: string[] = [];
  const code = doctor({
    cwd,
    config,
    env,
    version: "0.0.0",
    write: (l) => lines.push(l),
    json,
    systemRoot: noSystem(),
  });
  return { code, output: lines.join("\n") };
}

describe("selfhost doctor", () => {
  it("prints the version and node version", () => {
    const { code, output } = run(repo({}));
    expect(code).toBe(0);
    expect(output).toContain("selfhost 0.0.0");
    expect(output).toContain(`node ${process.version}`);
    expect(output).toContain("no selfhost.toml found");
  });

  it("finds selfhost.toml in a parent directory and reports it valid", () => {
    const dir = repo({
      "selfhost.toml":
        'version = 1\n[[rules]]\nid = "r"\nmatch = { tool = "Bash" }\naction = "ask"\nmessage = "m"\n',
      "src/app/.keep": "",
    });
    const { code, output } = run(join(dir, "src", "app"));
    expect(code).toBe(0);
    expect(output).toContain(join(dir, "selfhost.toml"));
    expect(output).toContain("valid, 1 rules (0 enforced, 1 observe or off)");
    // The rules block nothing yet, but the guardrails do.
    expect(output).toContain(
      "6 guardrails block in every hook: guard.force_push, guard.reset_hard, guard.rm_outside_workspace, guard.secret_read, guard.prod_sql, guard.prod_credentials",
    );
  });

  it("warns once about a deprecated [integrations.runtime] and says it is [runtime] default", () => {
    const dir = repo({ "selfhost.toml": 'version = 1\n[integrations.runtime]\ntool = "e2b"\n' });
    const { code, output } = run(dir);
    expect(code).toBe(0);
    const warnings = output.split("\n").filter((line) => line.startsWith("warning"));
    expect(warnings).toEqual([
      'warning  [integrations.runtime] is deprecated: it is read as [runtime] default = "e2b"; move it there.',
    ]);
  });

  it("says which guardrails block or only record, and warns when selfhost is not on PATH", () => {
    const dir = repo({
      "selfhost.toml": 'version = 1\n[guardrails]\nmode = "observe"\n',
    });
    const lines: string[] = [];
    const code = doctor({
      cwd: dir,
      env: {},
      version: "0.0.0",
      write: (line) => lines.push(line),
      which: () => undefined,
      systemRoot: noSystem(),
    });
    expect(code).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain(
      '6 guardrails only record ([guardrails] mode = "observe"); none block',
    );
    expect(output).toMatch(/^path {5}selfhost is not on PATH/m);
    const none = run(repo({}));
    expect(none.output).toContain("6 guardrails block in every hook");
    expect(none.output).not.toContain("not on PATH");
  });

  it("does not search above the repository root", () => {
    const outer = repo({ "selfhost.toml": "version = 1\n" });
    const inner = join(outer, "inner");
    mkdirSync(join(inner, ".git"), { recursive: true });
    expect(run(inner).output).toContain("no selfhost.toml found");
  });

  it("lists errors with line and field and exits 1 when invalid", () => {
    const dir = repo({ "selfhost.toml": 'version = 1\n[ledger]\nretention_days = "x"\n' });
    const { code, output } = run(dir);
    expect(code).toBe(1);
    expect(output).toContain("invalid, 1 error(s)");
    expect(output).toContain("selfhost.toml:3: ledger.retention_days: Expected integer");
  });

  it("exits 1 when --config points at a missing file", () => {
    const dir = repo({});
    const { code, output } = run(dir, "nope.toml");
    expect(code).toBe(1);
    expect(output).toContain("does not exist");
  });

  it("uses SELFHOST_CONFIG when set", () => {
    const dir = repo({ "conf/team.toml": "version = 1\n" });
    const { output } = run(dir, undefined, { SELFHOST_CONFIG: "conf/team.toml" });
    expect(output).toContain(join(dir, "conf", "team.toml"));
  });

  it("prints the same facts as JSON", () => {
    const dir = repo({ "selfhost.toml": 'version = 1\n[ledger]\nretention_days = "x"\n' });
    const { code, output } = run(dir, undefined, {}, true);
    expect(code).toBe(1);
    const report = JSON.parse(output);
    expect(Object.keys(report)).toEqual([
      "schema",
      "version",
      "runtime",
      "config",
      "guardrails",
      "on_path",
      "enforcement",
      "team_floor",
      "managed_hooks",
    ]);
    expect(report.enforcement).toEqual([]);
    expect(report.guardrails).toMatchObject({ mode: "enforce", observed: [] });
    expect(report.on_path).toBeNull();
    expect(report.runtime).toEqual({
      node: process.version,
      bun: process.versions.bun ?? null,
      platform: process.platform,
      arch: process.arch,
    });
    expect(report.config).toEqual({
      path: join(dir, "selfhost.toml"),
      from: "search",
      team_policy: null,
      rules: 0,
      enforced: 0,
      errors: [{ field: "ledger.retention_days", line: 3, message: "Expected integer" }],
      exists: true,
      valid: false,
      warnings: [],
    });
    expect(JSON.parse(run(repo({}), undefined, {}, true).output).config).toBeNull();
  });

  it("reports the guardrails the team floor keeps on when the repository turns them off", () => {
    const dir = repo({ "selfhost.toml": 'version = 1\n[guardrails]\nmode = "off"\n' });
    const home = noSystem();
    const configPath = join(home, ".selfhost", "config.json");
    mkdirSync(join(home, ".selfhost"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        server: "http://team.test",
        token: "t",
        person: "dev@example.com",
        team: "web",
      }),
    );
    writeFileSync(
      join(home, ".selfhost", "team-policy.toml"),
      'version = 1\n[guardrails]\nmode = "enforce"\n',
    );
    const lines: string[] = [];
    doctor({
      cwd: dir,
      env: {},
      version: "0.0.0",
      write: (line) => lines.push(line),
      configPath,
      systemRoot: noSystem(),
    });
    const output = lines.join("\n");
    expect(output).not.toContain("the guardrails are off");
    expect(output).toContain("6 guardrails block in every hook");
    expect(output).toMatch(/^floor {4}the team policy holds guardrails\.mode/m);
  });

  it("says when an agent runs selfhost's hooks from managed settings and from the user's config", () => {
    const dir = repo({});
    const root = noSystem();
    const home = noSystem();
    const managed = join(root, "etc", "claude-code", "managed-settings.d", "selfhost.json");
    mkdirSync(join(managed, ".."), { recursive: true });
    writeFileSync(
      managed,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "selfhost hook claude_code" }] }],
        },
      }),
    );
    const lines: string[] = [];
    const check = () => {
      lines.length = 0;
      doctor({
        cwd: dir,
        env: {},
        version: "0.0.0",
        write: (line) => lines.push(line),
        platform: "linux",
        systemRoot: root,
        home,
      });
      return lines.join("\n");
    };
    expect(check()).toContain(`Claude Code's hooks come from the managed settings at ${managed}`);
    const user = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      user,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: "if command -v selfhost; then exec selfhost hook claude_code; fi",
                },
              ],
            },
          ],
        },
      }),
    );
    expect(check()).toContain(
      `Claude Code runs selfhost's hooks twice: from the managed settings at ${managed} and from ${user}.`,
    );
  });
});

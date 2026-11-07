import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctor } from "../src/doctor.js";

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "selfhost-doctor-"));
  mkdirSync(join(dir, ".git"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function run(cwd: string, config?: string, env: NodeJS.ProcessEnv = {}) {
  const lines: string[] = [];
  const code = doctor({ cwd, config, env, version: "0.0.0", write: (l) => lines.push(l) });
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
    expect(output).toContain("valid, 1 rules (0 enforced)");
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
});

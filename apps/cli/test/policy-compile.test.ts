import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { personalDir } from "../src/context/layers.js";
import type { PolicyCompileReport } from "../src/policy/compile.js";
import type { Fetch } from "../src/team/client.js";
import { run, tempDir } from "./run.js";

const POLICY = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "fixtures", "compile", "selfhost.toml"),
  "utf8",
);

function repo(files: Record<string, string> = {}) {
  const dir = tempDir("compile");
  mkdirSync(dir.path(".git"));
  dir.write("selfhost.toml", POLICY);
  for (const [name, content] of Object.entries(files)) dir.write(name, content);
  return dir;
}

const report = (out: string) => JSON.parse(out) as PolicyCompileReport;

describe("selfhost policy compile", () => {
  it("writes each vendor's files and the coverage into the output folder", async () => {
    const dir = repo();
    const result = await run(["policy", "compile", "--json"], { cwd: dir.root });
    expect(result.code).toBe(0);
    const body = report(result.out);
    expect(body.out).toBe(dir.path(".selfhost", "compiled"));
    expect(body.apply).toBeNull();
    for (const file of [
      "claude_code/managed-settings.d/selfhost.json",
      "codex/requirements.toml",
      "codex/hooks/selfhost-hook",
      "cursor/hooks.json",
      "cursor/team-rules.md",
      "copilot/managed-settings.json",
      "copilot/api-calls.json",
      "rules/.ruler/selfhost-policy.md",
      "rules/AGENTS.md",
      "rules/CLAUDE.md",
      "coverage.json",
    ]) {
      expect([file, existsSync(join(body.out, file))]).toEqual([file, true]);
    }
    expect(body.coverage.rules).toHaveLength(12 * 4);
    expect(body.files.find((file) => file.path.endsWith("selfhost.json"))?.target).toBe(
      "/etc/claude-code/managed-settings.d/selfhost.json",
    );
    expect(body.calls).toEqual([
      expect.objectContaining({
        method: "PUT",
        path: "/repos/{owner}/{repo}/contents/copilot/managed-settings.json",
        status: "planned",
      }),
    ]);
    // Nothing outside the output folder.
    expect(existsSync(dir.path(".ruler"))).toBe(false);
    expect(existsSync(dir.path("AGENTS.md"))).toBe(false);
  });

  it("prints the coverage table and every gap", async () => {
    const dir = repo();
    const out = dir.path("out");
    const result = await run(["policy", "compile", "--out", out], { cwd: dir.root });
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/rule\s+mode\s+claude_code\s+codex\s+cursor\s+copilot/);
    expect(result.out).toMatch(
      /no-force-push\s+enforce\s+compiled\+hook\s+partial\+hook\s+none\+hook\s+compiled\n/,
    );
    expect(result.out).toMatch(/retired\s+off\s+n\/a\s+n\/a\s+n\/a\s+n\/a/);
    expect(result.out).toContain("Gaps:");
    expect(result.out).toContain("  copilot no-rm-rf: ");
    expect(result.out).toContain("Nothing was installed.");
    expect(existsSync(join(out, "coverage.json"))).toBe(true);
  });

  it("compiles only the vendors asked for, at the version asked for", async () => {
    const dir = repo();
    const result = await run(
      ["policy", "compile", "--vendor", "claude", "--target", "claude@2.1.83", "--json"],
      { cwd: dir.root },
    );
    const body = report(result.out);
    expect(body.coverage.vendors.map((vendor) => [vendor.vendor, vendor.version])).toEqual([
      ["claude_code", "2.1.83"],
    ]);
    const paste = body.coverage.rules.find((rule) => rule.rule_id === "no-paste-sites");
    expect(paste?.status).toBe("not_expressible");
    expect(existsSync(join(body.out, "codex"))).toBe(false);
  });

  it("refuses an unknown vendor", async () => {
    const dir = repo();
    const result = await run(["policy", "compile", "--vendor", "windsurf"], { cwd: dir.root });
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      '--vendor: expected claude, codex, cursor or copilot, got "windsurf"',
    );
  });

  it("--apply writes the rules files through Ruler and prints admin commands it never runs", async () => {
    const dir = repo();
    const result = await run(["policy", "compile", "--apply", "--json"], { cwd: dir.root });
    expect(result.code).toBe(0);
    const body = report(result.out);
    expect(body.apply?.rules).toEqual({
      root: dir.root,
      written: true,
      message:
        "Wrote .ruler/selfhost-policy.md; Ruler then wrote AGENTS.md, CLAUDE.md, .gitignore.",
    });
    expect(readFileSync(dir.path(".ruler", "selfhost-policy.md"), "utf8")).toContain(
      "# Team policy",
    );
    expect(readFileSync(dir.path("AGENTS.md"), "utf8")).toContain("no-force-push");
    expect(readFileSync(dir.path("CLAUDE.md"), "utf8")).toContain("no-force-push");
    expect(body.apply?.commands).toContain(
      `sudo mkdir -p '/etc/claude-code/managed-settings.d' && sudo install -o root -m 0644 '${join(body.out, "claude_code", "managed-settings.d", "selfhost.json")}' '/etc/claude-code/managed-settings.d/selfhost.json'`,
    );
    expect(body.apply?.commands.some((command) => command.includes("-m 0755"))).toBe(true);
    expect(body.apply?.steps).toContain(
      `Paste ${join(body.out, "cursor", "team-rules.md")} into Cursor dashboard, Team content, Rules (https://cursor.com/dashboard/team-content).`,
    );
    expect(body.calls[0]).toMatchObject({ status: "skipped" });
    expect(body.calls[0]?.message).toContain("--github-org");
  });

  it("quotes macOS paths with spaces in the install commands", async () => {
    const dir = repo();
    const result = await run(["policy", "compile", "--apply", "--vendor", "cursor"], {
      cwd: dir.root,
      platform: "darwin",
    });
    expect(result.out).toContain(
      "sudo mkdir -p '/Library/Application Support/Cursor' && sudo install -o root -m 0644",
    );
    expect(result.out).toContain("selfhost does not run these");
  });

  it("--apply leaves hand-written rules files alone", async () => {
    const dir = repo({ "AGENTS.md": "# Ours\n" });
    const result = await run(["policy", "compile", "--apply", "--json"], { cwd: dir.root });
    const body = report(result.out);
    expect(body.apply?.rules.written).toBe(false);
    expect(body.apply?.rules.message).toContain("Ruler would replace AGENTS.md");
    expect(readFileSync(dir.path("AGENTS.md"), "utf8")).toBe("# Ours\n");
    expect(existsSync(dir.path(".ruler"))).toBe(false);
  });

  it("--apply writes Copilot's settings through the GitHub API with a token, never printing it", async () => {
    const dir = repo();
    const seen: { method: string; url: string; auth: string | null; body: unknown }[] = [];
    const fetch: Fetch = async (url, init) => {
      const headers = new Headers(init.headers);
      seen.push({
        method: init.method ?? "GET",
        url,
        auth: headers.get("authorization"),
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      return init.method === "GET"
        ? Response.json({ sha: "abc123" })
        : Response.json({ content: {} }, { status: 200 });
    };
    const token = "token-for-tests";
    const result = await run(
      ["policy", "compile", "--apply", "--vendor", "copilot", "--github-org", "acme", "--json"],
      { cwd: dir.root, env: { GITHUB_TOKEN: token }, fetch },
    );
    expect(result.code).toBe(0);
    expect(result.out).not.toContain(token);
    const path = "/repos/acme/.github-private/contents/copilot/managed-settings.json";
    expect(seen.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET https://api.github.com${path}`,
      `PUT https://api.github.com${path}`,
    ]);
    expect(seen[1]?.auth).toBe(`Bearer ${token}`);
    const body = seen[1]?.body as { sha: string; content: string };
    expect(body.sha).toBe("abc123");
    expect(Buffer.from(body.content, "base64").toString("utf8")).toBe(
      readFileSync(join(report(result.out).out, "copilot", "managed-settings.json"), "utf8"),
    );
    expect(report(result.out).calls[0]).toMatchObject({ path, status: "done" });
  });

  it("exits 1 when a GitHub call fails", async () => {
    const dir = repo();
    const result = await run(
      ["policy", "compile", "--apply", "--vendor", "copilot", "--github-org", "acme"],
      {
        cwd: dir.root,
        env: { GITHUB_TOKEN: "token-for-tests" },
        fetch: async () => new Response("{}", { status: 403 }),
      },
    );
    expect(result.code).toBe(1);
    expect(result.out).toContain(
      "failed: GET /repos/acme/.github-private/contents/copilot/managed-settings.json answered 403",
    );
  });

  it("with .selfhost/context, --apply leaves the rules files to the context compile", async () => {
    const dir = repo({ ".selfhost/context/rules/style.md": "Use tabs.\n" });
    const result = await run(["policy", "compile", "--apply", "--vendor", "claude", "--json"], {
      cwd: dir.root,
    });
    expect(result.code).toBe(0);
    expect(report(result.out).apply?.rules).toMatchObject({
      written: true,
      message: expect.stringContaining("selfhost context compile then wrote"),
    });
    const claude = readFileSync(dir.path("CLAUDE.md"), "utf8");
    expect(claude).toContain("<!-- Source: .ruler/selfhost-policy.md -->");
    expect(claude).toContain("<!-- Source: .selfhost/context/rules/style.md -->");
    expect((await run(["context", "check"], { cwd: dir.root })).code).toBe(0);
  });

  it("--apply makes the same layered compile, for the same agents, as context compile", async () => {
    const dir = repo({ ".selfhost/context/rules/style.md": "Use tabs.\n" });
    const configPath = tempDir("config").path("config.json");
    const personal = join(personalDir(configPath), "rules", "mine.md");
    mkdirSync(join(personalDir(configPath), "rules"), { recursive: true });
    writeFileSync(personal, "Answer in short sentences.\n");
    // Only Claude Code is set up on this machine.
    const home = tempDir("home");
    home.write(".claude/settings.json", "{}\n");
    const deps = { cwd: dir.root, configPath, home: home.root };
    const result = await run(
      ["policy", "compile", "--apply", "--vendor", "claude", "--json"],
      deps,
    );
    expect(result.code).toBe(0);
    const lock = JSON.parse(readFileSync(dir.path(".selfhost", "context.lock.json"), "utf8"));
    expect(lock.agents).toEqual(["claude_code"]);
    const claude = readFileSync(dir.path("CLAUDE.md"), "utf8");
    expect(claude).toContain("Answer in short sentences.");
    expect(claude).toContain("<!-- Source: .ruler/selfhost-policy.md -->");
    expect(existsSync(dir.path(".cursor"))).toBe(false);
    const check = await run(["context", "check"], deps);
    expect(check.code).toBe(0);
  });
});

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { applyAllAgentConfigs } from "@intellectronica/ruler";
import { COMPILE_VENDORS, parseConfig } from "@selfhost/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compilePolicy, PLATFORMS, RULER_SOURCE } from "../src/index.js";
import { handWrittenRulesFiles, runRuler } from "../src/ruler.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "selfhost-ruler-"));
  dirs.push(dir);
  return dir;
}

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Every file under `dir` with a hash of its bytes. */
function snapshot(dir: string, skip?: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (path === skip) continue;
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

const parsed = parseConfig(`version = 1

[[rules]]
id = "no-force-push"
mode = "enforce"
match = { command = '^git push --force' }
action = "block"
message = "Force pushes are blocked."

[mcp]
mode = "enforce"
allow = ["github"]
`);
if (!parsed.ok) throw new Error("invalid test policy");
const compiled = compilePolicy(parsed.config);

/** A repository a team already runs Ruler in, with MCP servers in its ruler.toml. */
function teamRepo(root: string): void {
  put(join(root, ".ruler", "AGENTS.md"), "# Team notes\n\nRun the tests before pushing.\n");
  put(
    join(root, ".ruler", "ruler.toml"),
    '[mcp_servers.docs]\ncommand = "docs-mcp"\n\n[gitignore]\nenabled = false\n',
  );
  put(join(root, RULER_SOURCE), compiled.rules?.content ?? "");
}

describe("Ruler and selfhost's files", () => {
  it("installs every native file outside the repository, where Ruler never writes", () => {
    for (const output of compiled.vendors) {
      for (const file of output.files) {
        const { install } = file;
        if (install.kind === "dashboard") continue;
        expect(install.kind).not.toBe("repo");
        if (install.kind !== "system" && install.kind !== "mdm") continue;
        for (const platform of PLATFORMS) {
          const path = install.paths[platform];
          if (path === undefined) continue;
          expect([output.vendor, file.name, /^(\/|~\/|[A-Z]:\\)/.test(path)]).toEqual([
            output.vendor,
            file.name,
            true,
          ]);
        }
      }
    }
    expect(compiled.rules?.install).toEqual({ kind: "repo", path: RULER_SOURCE });
  });

  it("a person's own ruler apply, MCP on, leaves the managed files and the policy text alone", async () => {
    const machine = temp();
    const repo = join(machine, "repo");
    teamRepo(repo);
    // selfhost's outputs where they install on Linux, under a fake root and home.
    for (const output of compiled.vendors) {
      for (const file of output.files) {
        const { install } = file;
        if (install.kind !== "system" && install.kind !== "mdm") continue;
        const path = install.paths.linux;
        if (path) put(join(machine, path.replace(/^~\//, "home/")), file.content);
      }
    }
    const outside = snapshot(machine, repo);
    const policyText = readFileSync(join(repo, RULER_SOURCE), "utf8");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // Every agent, MCP on, default skills and backups: Ruler's defaults, as `ruler apply` runs.
    await applyAllAgentConfigs(
      repo,
      undefined,
      undefined,
      true,
      undefined,
      false,
      false,
      false,
      true,
    );

    expect(snapshot(machine, repo)).toEqual(outside);
    expect(Object.keys(outside).length).toBeGreaterThanOrEqual(6);
    expect(readFileSync(join(repo, RULER_SOURCE), "utf8")).toBe(policyText);
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toContain("# Team policy");
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toContain("Force pushes are blocked.");
  });

  it("with MCP on, rewrites a project .codex/config.toml, so selfhost puts no hooks there", async () => {
    const repo = temp();
    teamRepo(repo);
    const before =
      '# selfhost hooks\n[[hooks.PreToolUse]]\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "selfhost hook codex"\n';
    put(join(repo, ".codex", "config.toml"), before);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await applyAllAgentConfigs(
      repo,
      ["codex"],
      undefined,
      true,
      undefined,
      false,
      false,
      false,
      true,
    );
    const after = readFileSync(join(repo, ".codex", "config.toml"), "utf8");
    expect(after).not.toContain("# selfhost hooks");
    expect(after).toContain("[mcp_servers.docs]");
  });

  it("selfhost's own run writes rules files only, and prints nothing", async () => {
    const repo = temp();
    teamRepo(repo);
    put(join(repo, ".codex", "config.toml"), '# mine\nmodel = "o"\n');
    const log = vi.spyOn(console, "log");
    const before = snapshot(repo);
    const printed = await runRuler(repo, COMPILE_VENDORS);
    const after = snapshot(repo);
    expect(log).not.toHaveBeenCalled();
    expect(printed.join("\n")).toContain("Applying rules for Claude Code");
    const changed = Object.keys(after).filter((name) => after[name] !== before[name]);
    expect(changed.sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(existsSync(join(repo, ".mcp.json"))).toBe(false);
  });
});

describe("handWrittenRulesFiles", () => {
  it("names rules files Ruler would replace in a repository without .ruler/", () => {
    const repo = temp();
    put(join(repo, "AGENTS.md"), "# Ours\n");
    put(join(repo, "CLAUDE.md"), "<!-- Source: .ruler/AGENTS.md -->\n");
    expect(handWrittenRulesFiles(repo)).toEqual(["AGENTS.md"]);
    mkdirSync(join(repo, ".ruler"));
    expect(handWrittenRulesFiles(repo)).toEqual([]);
  });
});

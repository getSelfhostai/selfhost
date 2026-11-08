import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planAgentConfig } from "@selfhost/agents";
import {
  COMPILE_VENDORS,
  type CompileVendor,
  createValidator,
  PolicyCoverageSchema,
  parseConfig,
  type ResolvedSelfhostConfig,
  type RuleCoverage,
} from "@selfhost/schema";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { compilePolicy, resolveVersion } from "../src/index.js";

function config(text: string): ResolvedSelfhostConfig {
  const parsed = parseConfig(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.config;
}

const oneRule = (match: string, extra = "") =>
  config(
    `version = 1\n\n[[rules]]\nid = "r"\nmode = "enforce"\nmatch = ${match}\naction = "block"\nmessage = "No."\n${extra}`,
  );

function coverageOf(result: ReturnType<typeof compilePolicy>, vendor: CompileVendor, id = "r") {
  const entry = result.coverage.rules.find((rule) => rule.rule_id === id && rule.vendor === vendor);
  if (!entry) throw new Error(`no coverage for ${id} on ${vendor}`);
  return entry;
}

const fileOf = (result: ReturnType<typeof compilePolicy>, vendor: CompileVendor, name: string) =>
  result.vendors.find((output) => output.vendor === vendor)?.files.find((f) => f.name === name)
    ?.content;

// Simple-command models of each vendor's native matcher, from the docs cited in src/vendors.
const stripList = (native: string) => native.replace(/^(deny|ask): /, "");

function claudeMatches(rule: string, command: string): boolean {
  const body = /^Bash\((.*)\)$/.exec(rule)?.[1];
  if (body === undefined) return false;
  if (body.split("*").length === 2 && body.endsWith(" *")) {
    const prefix = body.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  }
  const escaped = body.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join("[\\s\\S]*")}$`).test(command);
}

function copilotMatches(rule: string, command: string): boolean {
  const body = /^Shell\((.*)\)$/.exec(rule)?.[1];
  if (body === undefined) return false;
  if (body.endsWith(" *")) {
    const prefix = body.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  }
  return command === body;
}

function codexMatches(native: string, command: string): boolean {
  const tokens = JSON.parse(
    native.replace(/^prefix_rule /, "").replace(/ (forbidden|prompt)$/, ""),
  );
  const words = command.split(" ");
  return tokens.every((token: string, index: number) => words[index] === token);
}

const MATCHERS: Partial<Record<CompileVendor, (native: string, command: string) => boolean>> = {
  claude_code: (native, command) => claudeMatches(stripList(native), command),
  copilot: (native, command) => copilotMatches(stripList(native), command),
  codex: codexMatches,
};

/** Plain commands, one program each, as the simple models above read them. */
const COMMANDS = [
  "git push --force",
  "git push --force origin main",
  "git push --force-with-lease",
  "git push -f",
  "git push -f origin",
  "git push origin",
  "git pushx",
  "git reset --hard",
  "git reset --hard HEAD~1",
  "git reset --hardest",
  "rm -rf build",
  "rm -r build",
  "rm.sh",
  "rm",
  "echo rm -rf",
  "npm publish",
  "npm publish --tag next",
  "terraform destroy",
  "terraform destroy -auto-approve",
  "terraform destroyer",
  "ls -la",
];

const STATUSES: [string, Partial<Record<CompileVendor, RuleCoverage["status"]>>][] = [
  [
    "^git push (--force|-f)(\\s|$)",
    { claude_code: "compiled", codex: "partial", cursor: "not_expressible", copilot: "compiled" },
  ],
  ["^git reset --hard", { claude_code: "compiled", codex: "partial", copilot: "partial" }],
  ["^npm publish$", { claude_code: "compiled", codex: "partial", copilot: "compiled" }],
  ["^terraform destroy(\\s|$)", { claude_code: "compiled", copilot: "compiled" }],
  ["rm -rf", { claude_code: "partial", codex: "not_expressible", copilot: "not_expressible" }],
  ["^rm\\b", { claude_code: "partial", codex: "partial", copilot: "partial" }],
  ["^git\\s+push --force", { claude_code: "partial", copilot: "partial" }],
  ["curl .*\\| *sh", { claude_code: "not_expressible", codex: "not_expressible" }],
];

describe("command rules", () => {
  it.each(STATUSES)("%s compiles to the expected status per vendor", (pattern, expected) => {
    const result = compilePolicy(oneRule(`{ command = '${pattern}' }`));
    for (const [vendor, status] of Object.entries(expected)) {
      expect([vendor, coverageOf(result, vendor as CompileVendor).status]).toEqual([
        vendor,
        status,
      ]);
    }
  });

  it.each(STATUSES)(
    "is compiled only when native rules match every command %s matches",
    (pattern) => {
      const result = compilePolicy(oneRule(`{ command = '${pattern}' }`));
      const regex = new RegExp(pattern);
      for (const [vendor, matches] of Object.entries(MATCHERS)) {
        const entry = coverageOf(result, vendor as CompileVendor);
        if (entry.status !== "compiled") continue;
        expect(entry.native.length).toBeGreaterThan(0);
        for (const command of COMMANDS.filter((candidate) => regex.test(candidate))) {
          const covered = entry.native.some((native) => matches(native, command));
          expect([vendor, command, covered]).toEqual([vendor, command, true]);
        }
      }
    },
  );

  it("says why a regular expression does not reduce", () => {
    const result = compilePolicy(oneRule(`{ command = 'curl .*\\| *sh' }`));
    expect(coverageOf(result, "claude_code").detail).toContain("uses quantifier .*");
    expect(coverageOf(result, "claude_code").hook).toBe("enforce");
    expect(coverageOf(result, "copilot")).toMatchObject({ hook: "none" });
    expect(coverageOf(result, "copilot").detail).toContain("Nothing checks it on Copilot.");
  });

  it("writes block rules as deny and ask rules as ask", () => {
    const result = compilePolicy(
      config(`version = 1

[[rules]]
id = "push"
mode = "enforce"
match = { command = '^git push --force' }
action = "block"
message = "No force pushes."

[[rules]]
id = "reset"
mode = "enforce"
match = { command = '^git reset --hard$' }
action = "ask"
message = "Ask first."
`),
    );
    const claude = JSON.parse(
      fileOf(result, "claude_code", "managed-settings.d/selfhost.json") ?? "",
    );
    expect(claude.permissions).toEqual({
      deny: ["Bash(git push --force*)"],
      ask: ["Bash(git reset --hard)"],
    });
    const codex = parseToml(fileOf(result, "codex", "requirements.toml") ?? "") as {
      rules: { prefix_rules: unknown[] };
    };
    expect(codex.rules.prefix_rules).toEqual([
      {
        pattern: [{ token: "git" }, { token: "push" }, { token: "--force" }],
        decision: "forbidden",
        justification: "No force pushes.",
      },
      {
        pattern: [{ token: "git" }, { token: "reset" }, { token: "--hard" }],
        decision: "prompt",
        justification: "Ask first.",
      },
    ]);
    const copilot = JSON.parse(fileOf(result, "copilot", "managed-settings.json") ?? "");
    expect(copilot.permissions).toEqual({
      deny: ["Shell(git push --force)", "Shell(git push --force *)"],
      ask: ["Shell(git reset --hard)"],
    });
  });
});

describe("path, URL and tool rules", () => {
  it("anchors paths at the start folder for Claude Code and the workspace root for Copilot", () => {
    const result = compilePolicy(oneRule(`{ path = "**/.env*" }`));
    expect(coverageOf(result, "claude_code")).toMatchObject({
      status: "partial",
      native: ["deny: Read(./**/.env*)", "deny: Edit(./**/.env*)"],
    });
    expect(coverageOf(result, "copilot")).toMatchObject({
      status: "compiled",
      native: ["deny: Read(/**/.env*)", "deny: Edit(/**/.env*)"],
    });
    expect(coverageOf(result, "codex").status).toBe("not_expressible");
    expect(coverageOf(result, "codex").hook).toBe("enforce");
  });

  it("refuses path globs vendors can't read", () => {
    const result = compilePolicy(oneRule(`{ path = "src/{a,b}/*.ts" }`));
    for (const vendor of ["claude_code", "copilot"] as const) {
      expect(coverageOf(result, vendor).status).toBe("not_expressible");
      expect(coverageOf(result, vendor).detail).toContain("braces");
    }
  });

  it("gates WebFetch domain wildcards on Claude Code 2.1.172", () => {
    const rule = oneRule(`{ url = "https://*.paste.example/**" }`);
    const old = compilePolicy(rule, { versions: { claude_code: "2.1.83" } });
    expect(coverageOf(old, "claude_code").status).toBe("not_expressible");
    expect(coverageOf(old, "claude_code").detail).toContain("2.1.172");
    const current = compilePolicy(rule, { versions: { claude_code: "2.1.319" } });
    expect(coverageOf(current, "claude_code")).toMatchObject({
      status: "compiled",
      native: ["deny: WebFetch(domain:*.paste.example)"],
    });
    expect(coverageOf(current, "copilot").native).toEqual(["deny: Domain(*.paste.example)"]);
  });

  it("refuses URL globs narrower than a site", () => {
    const result = compilePolicy(oneRule(`{ url = "https://github.com/acme/**" }`));
    for (const vendor of COMPILE_VENDORS) {
      expect(coverageOf(result, vendor).status).toBe("not_expressible");
    }
  });

  it("marks another vendor's tool names not applicable", () => {
    const result = compilePolicy(oneRule(`{ tool = "Bash" }`));
    expect(coverageOf(result, "claude_code")).toMatchObject({
      status: "compiled",
      native: ["deny: Bash"],
    });
    expect(coverageOf(result, "codex").status).toBe("not_expressible");
    expect(coverageOf(result, "cursor")).toMatchObject({
      status: "not_applicable",
      hook: "none",
      detail: "Bash is another agent's tool name: Cursor reports this tool as Shell.",
    });
    expect(coverageOf(result, "copilot").detail).toContain("bash or powershell");
  });

  it("knows Codex's hosted tools run no hooks", () => {
    const result = compilePolicy(oneRule(`{ tool = "WebSearch" }`));
    expect(coverageOf(result, "codex")).toMatchObject({ status: "not_expressible", hook: "none" });
    expect(coverageOf(result, "claude_code")).toMatchObject({
      status: "compiled",
      hook: "enforce",
    });
  });

  it("can't combine conditions natively", () => {
    const result = compilePolicy(oneRule(`{ path = "infra/**", url = "https://x.example/**" }`));
    expect(coverageOf(result, "claude_code").status).toBe("not_expressible");
    expect(coverageOf(result, "claude_code").detail).toContain("path and url together");
  });
});

describe("modes, agents and teams", () => {
  const TOML = `version = 1

[[rules]]
id = "push"
mode = "observe"
match = { command = '^git push --force' }
action = "block"
message = "No force pushes."

[[rules]]
id = "codex-only"
mode = "enforce"
agents = ["codex"]
match = { command = '^npm publish' }
action = "block"
message = "CI publishes."

[[rules]]
id = "retired"
mode = "off"
match = { tool = "Bash" }
action = "block"
message = "Retired."

[teams.platform.rules.push]
mode = "enforce"
`;

  it("writes nothing native for observe rules and reports how they will compile", () => {
    const result = compilePolicy(config(TOML));
    const push = coverageOf(result, "claude_code", "push");
    expect(push).toMatchObject({ mode: "observe", status: "compiled", native: [], hook: "record" });
    expect(push.detail).toMatch(/^Observe mode: nothing native is written/);
    expect(fileOf(result, "claude_code", "managed-settings.d/selfhost.json")).not.toContain(
      "git push",
    );
    expect(result.vendors.find((output) => output.vendor === "copilot")?.files).toEqual([]);
  });

  it("applies a team's overrides", () => {
    const result = compilePolicy(config(TOML), { team: "platform" });
    expect(coverageOf(result, "claude_code", "push")).toMatchObject({
      mode: "enforce",
      native: ["deny: Bash(git push --force*)"],
    });
    expect(result.coverage.team).toBe("platform");
  });

  it("marks mode off and other agents' rules not applicable", () => {
    const result = compilePolicy(config(TOML));
    for (const vendor of COMPILE_VENDORS) {
      expect(coverageOf(result, vendor, "retired")).toMatchObject({
        status: "not_applicable",
        detail: "Mode off.",
      });
    }
    expect(coverageOf(result, "claude_code", "codex-only")).toMatchObject({
      status: "not_applicable",
      detail: "The rule is only for Codex.",
    });
    expect(coverageOf(result, "codex", "codex-only").status).toBe("partial");
  });

  it("lists one entry per rule and vendor, in rule order then vendor order", () => {
    const result = compilePolicy(config(TOML));
    expect(result.coverage.rules.map((rule) => `${rule.rule_id}:${rule.vendor}`)).toEqual(
      ["push", "codex-only", "retired"].flatMap((id) =>
        COMPILE_VENDORS.map((vendor) => `${id}:${vendor}`),
      ),
    );
    expect(createValidator(PolicyCoverageSchema).validate(result.coverage)).toMatchObject({
      ok: true,
    });
  });

  it("compiles only the vendors asked for", () => {
    const result = compilePolicy(config(TOML), { vendors: ["codex"] });
    expect(result.vendors.map((output) => output.vendor)).toEqual(["codex"]);
    expect(new Set(result.coverage.rules.map((rule) => rule.vendor))).toEqual(new Set(["codex"]));
  });
});

describe("allow lists", () => {
  it("compiles literal MCP names and refuses globs where the vendor matches exactly", () => {
    const literal = compilePolicy(
      config(`version = 1\n[mcp]\nmode = "enforce"\nallow = ["github"]\n`),
    );
    expect(coverageOf(literal, "claude_code", "mcp.allow").status).toBe("compiled");
    const settings = JSON.parse(
      fileOf(literal, "claude_code", "managed-settings.d/selfhost.json") ?? "",
    );
    expect(settings.allowedMcpServers).toEqual([{ serverName: "github" }]);
    expect(settings.allowManagedMcpServersOnly).toBe(true);
    expect(JSON.parse(fileOf(literal, "cursor", "permissions.json") ?? "")).toEqual({
      mcpAllowlist: ["github:*"],
    });
    expect(coverageOf(literal, "codex", "mcp.allow").status).toBe("not_expressible");

    const glob = compilePolicy(
      config(`version = 1\n[mcp]\nmode = "enforce"\nallow = ["acme-*"]\n`),
    );
    expect(coverageOf(glob, "claude_code", "mcp.allow").status).toBe("not_expressible");
    expect(coverageOf(glob, "copilot", "mcp.allow").status).toBe("not_expressible");
    expect(coverageOf(glob, "cursor", "mcp.allow").status).toBe("partial");
  });

  it("writes availableModels and never calls it compiled", () => {
    const result = compilePolicy(
      config(`version = 1\n[models]\nmode = "enforce"\nallow = ["claude-opus-5"]\n`),
    );
    const entry = coverageOf(result, "claude_code", "models.allow");
    expect(entry.status).toBe("partial");
    const settings = JSON.parse(
      fileOf(result, "claude_code", "managed-settings.d/selfhost.json") ?? "",
    );
    expect(settings.availableModels).toEqual(["claude-opus-5"]);
    expect(settings.availableModelsMatch).toBe("exact");
  });
});

describe("hooks and outputs", () => {
  it("writes the same Claude Code hook handler selfhost agents configure writes", () => {
    const home = mkdtempSync(join(tmpdir(), "selfhost-compile-"));
    try {
      const plan = planAgentConfig("claude_code", {
        home,
        hooks: { command: "selfhost hook {agent}" },
      });
      const user = JSON.parse(plan.changes[0]?.after ?? "{}");
      const managed = JSON.parse(
        fileOf(
          compilePolicy(config("version = 1\n")),
          "claude_code",
          "managed-settings.d/selfhost.json",
        ) ?? "",
      );
      expect(managed.hooks).toEqual(user.hooks);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("puts the hook command in every vendor's hooks", () => {
    const result = compilePolicy(config("version = 1\n"), { hookCommand: "/opt/sh hook {agent}" });
    expect(fileOf(result, "claude_code", "managed-settings.d/selfhost.json")).toContain(
      '"command": "/opt/sh hook claude_code"',
    );
    expect(fileOf(result, "codex", "hooks/selfhost-hook")).toContain("exec /opt/sh hook codex");
    expect(fileOf(result, "codex", "requirements.toml")).toContain(
      'command_windows = "/opt/sh hook codex"',
    );
    expect(fileOf(result, "cursor", "hooks.json")).toContain('"command": "/opt/sh hook cursor"');
  });

  it("writes TOML and JSON that parse", () => {
    const result = compilePolicy(config("version = 1\n"));
    const requirements = parseToml(fileOf(result, "codex", "requirements.toml") ?? "") as {
      features: unknown;
      hooks: Record<string, unknown>;
    };
    expect(requirements.features).toEqual({ hooks: true });
    expect(requirements.hooks.managed_dir).toBe("/etc/codex/hooks");
    expect(requirements.hooks.PreToolUse).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: "/etc/codex/hooks/selfhost-hook",
            command_windows: "selfhost hook codex",
          },
        ],
      },
    ]);
    expect(JSON.parse(fileOf(result, "cursor", "hooks.json") ?? "").version).toBe(1);
  });

  it("sends Copilot's managed settings through the contents API", () => {
    const result = compilePolicy(oneRule(`{ command = '^git push --force$' }`));
    const copilot = result.vendors.find((output) => output.vendor === "copilot");
    const [call] = copilot?.calls ?? [];
    expect(call).toMatchObject({
      method: "PUT",
      path: "/repos/{owner}/{repo}/contents/copilot/managed-settings.json",
      needsSha: true,
    });
    expect(Buffer.from(String(call?.body.content), "base64").toString("utf8")).toBe(
      fileOf(result, "copilot", "managed-settings.json"),
    );
  });

  it("refuses a version older than the oldest fixture", () => {
    expect(() => resolveVersion("claude_code", "2.0.70")).toThrow(/older than the oldest/);
    expect(resolveVersion("claude_code", "2.1.200")).toBe("2.1.200");
    expect(resolveVersion("codex")).toBe("0.167.0");
  });
});

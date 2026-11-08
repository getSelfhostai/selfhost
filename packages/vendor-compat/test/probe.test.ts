import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLAUDE_CODE_HOOK_EVENTS,
  CLAUDE_CODE_HOOK_SCHEMAS,
  CODEX_HOOK_EVENTS,
} from "@selfhost/schema";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { tempDir } from "../src/exec.js";
import { platformSuffix } from "../src/install.js";
import { compiledFiles, requiredFields } from "../src/probe.js";
import {
  doctorInvalidSettings,
  doctorValidEvents,
  interfaceFields,
  missingStrings,
} from "../src/strings.js";

// Shaped like claude doctor 2.1.319 output for a settings file with an unknown hook event.
const DOCTOR = `Claude Code doctor

Running: npm-global (2.1.319)

Invalid settings
- /tmp/p/.claude/settings.json › hooks.SelfhostProbeEvent: Unknown hook event "SelfhostProbeEvent" was ignored. Valid events: PreToolUse, PostToolUse, Stop, SessionStart
- /tmp/p/.claude/settings.json › permissions.deny: Non-string value in deny array was removed

1 warning found
`;

describe("doctor output", () => {
  it("reads the valid hook events and the invalid settings", () => {
    expect(doctorValidEvents(DOCTOR)).toEqual([
      "PreToolUse",
      "PostToolUse",
      "Stop",
      "SessionStart",
    ]);
    expect(doctorInvalidSettings(DOCTOR)).toHaveLength(2);
    expect(doctorInvalidSettings(DOCTOR)[1]).toMatch(/permissions\.deny/);
  });

  it("finds nothing in a clean report", () => {
    const clean = "Claude Code doctor\n\nRunning: npm-global (2.1.319)\n";
    expect(doctorValidEvents(clean)).toBeUndefined();
    expect(doctorInvalidSettings(clean)).toEqual([]);
  });
});

describe("interfaceFields", () => {
  it("lists the fields of one interface in a generated .d.ts", () => {
    const dts = `export interface BashInput {\n  /**\n   * The command\n   */\n  command: string;\n  timeout?: number;\n}\nexport interface Other {\n  command: string;\n}\n`;
    expect(interfaceFields(dts, "BashInput")).toEqual(["command", "timeout"]);
    expect(interfaceFields(dts, "Missing")).toBeUndefined();
  });
});

describe("missingStrings", () => {
  it("searches every file as bytes", () => {
    const dir = tempDir("strings");
    writeFileSync(join(dir, "a"), Buffer.from([0, 1, ...Buffer.from("PreToolUse"), 0]));
    writeFileSync(join(dir, "b"), "tool.execute.before");
    const files = [join(dir, "a"), join(dir, "b")];
    expect(missingStrings(files, ["PreToolUse", "tool.execute.before", "Gone"])).toEqual(["Gone"]);
  });
});

describe("compiledFiles", () => {
  it("hooks every Claude Code event selfhost models", () => {
    const settings = JSON.parse(
      compiledFiles("claude_code", "2.1.319").get("managed-settings.d/selfhost.json") ?? "{}",
    );
    expect(Object.keys(settings.hooks).sort()).toEqual([...CLAUDE_CODE_HOOK_EVENTS].sort());
  });

  it("hooks every Codex event selfhost models", () => {
    const requirements = parseToml(
      compiledFiles("codex", "0.167.0").get("requirements.toml") ?? "",
    );
    const hooks = requirements.hooks as Record<string, unknown>;
    const events = Object.keys(hooks).filter((key) => Array.isArray(hooks[key]));
    expect(events.sort()).toEqual([...CODEX_HOOK_EVENTS].sort());
  });
});

describe("requiredFields", () => {
  it("collects the fields some hook event requires", () => {
    expect(requiredFields(CLAUDE_CODE_HOOK_SCHEMAS)).toEqual(
      expect.arrayContaining(["cwd", "hook_event_name", "session_id", "tool_input", "tool_name"]),
    );
  });
});

describe("platformSuffix", () => {
  it("names the vendor platform packages", () => {
    expect(platformSuffix("linux", "x64")).toBe("linux-x64");
    expect(platformSuffix("darwin", "arm64")).toBe("darwin-arm64");
    expect(() => platformSuffix("win32", "x64")).toThrow(/win32-x64/);
  });
});

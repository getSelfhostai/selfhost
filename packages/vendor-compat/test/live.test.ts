import { copyFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../src/exec.js";
import { checkCapturedSession } from "../src/live.js";
import { REPO_ROOT } from "../src/types.js";

const FIXTURES = join(REPO_ROOT, "fixtures");

/** The fixture payloads laid out the way the capture hook writes them. */
function captured(vendor: "claude-code" | "codex"): string {
  const dir = tempDir("payloads");
  const from = join(FIXTURES, "hooks", vendor);
  for (const name of readdirSync(from).filter((n) => n !== "manifest.json")) {
    const kind = name.startsWith("notify-") ? "notify" : "hook";
    copyFileSync(join(from, name), join(dir, `${kind}-${name}`));
  }
  return dir;
}

// The live step's checks, run on the fixture payloads and session logs instead of a real session.
describe("checkCapturedSession", () => {
  it("accepts the Claude Code fixture payloads and session logs", async () => {
    const checks = await checkCapturedSession({
      vendor: "claude_code",
      payloads: captured("claude-code"),
      logs: join(FIXTURES, "claude-code"),
    });
    expect(checks.map((c) => [c.id, c.status, c.status === "fail" ? c.detail : ""])).toEqual([
      ["live-hooks", "pass", ""],
      ["live-import", "pass", ""],
    ]);
  });

  it("accepts the Codex fixture payloads, notify and rollouts", async () => {
    const checks = await checkCapturedSession({
      vendor: "codex",
      payloads: captured("codex"),
      logs: join(FIXTURES, "codex"),
    });
    expect(checks.map((c) => [c.id, c.status, c.status === "fail" ? c.detail : ""])).toEqual([
      ["live-hooks", "pass", ""],
      ["live-import", "pass", ""],
    ]);
    expect(checks[0]?.detail).toContain("agent-turn-complete");
  });

  it("fails a payload that lost a field selfhost needs", async () => {
    const payloads = captured("claude-code");
    writeFileSync(
      join(payloads, "hook-PreToolUse.json"),
      JSON.stringify({ hook_event_name: "PreToolUse", cwd: "/home/dev", tool_name: "Bash" }),
    );
    const [hooks] = await checkCapturedSession({
      vendor: "claude_code",
      payloads,
      logs: join(FIXTURES, "claude-code"),
    });
    expect(hooks?.status).toBe("fail");
    expect(hooks?.detail).toMatch(/^PreToolUse session_id: /m);
    expect(hooks?.detail).toMatch(/^PreToolUse tool_input: /m);
  });

  it("fails when no hook fired and no session log was written", async () => {
    const checks = await checkCapturedSession({
      vendor: "codex",
      payloads: tempDir("payloads"),
      logs: tempDir("logs"),
    });
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ["live-hooks", "fail"],
      ["live-import", "fail"],
    ]);
  });
});

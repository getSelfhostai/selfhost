import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeProjectName,
  findTranscript,
  placeTranscript,
  rehomeTranscript,
  transcriptCwd,
} from "../src/transcripts.js";

const SESSION = "5f0c2b1e-7d4a-4c8e-9a51-3e2d1c0b9a87";
const NOW = new Date("2026-11-11T12:00:00Z");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp() {
  const dir = mkdtempSync(join(tmpdir(), "selfhost-transcripts-"));
  dirs.push(dir);
  return dir;
}

const claudeLines = (cwd: string) =>
  [
    JSON.stringify({ type: "user", cwd, sessionId: SESSION, message: { content: "hi" } }),
    JSON.stringify({ type: "assistant", cwd: `${cwd}/src`, sessionId: SESSION }),
    "",
  ].join("\n");

const codexLines = (cwd: string) =>
  [
    JSON.stringify({ type: "session_meta", payload: { id: SESSION, cwd } }),
    JSON.stringify({ type: "turn_context", payload: { cwd, model: "gpt-5-codex" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message" } }),
  ].join("\n");

describe("finding a session's transcript", () => {
  it("finds a Claude Code session in any project, the newest copy first", () => {
    const home = temp();
    const older = join(home, ".claude", "projects", "-home-ana-api");
    const newer = join(home, ".claude", "projects", "-home-ana-api-wt");
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });
    writeFileSync(join(older, `${SESSION}.jsonl`), claudeLines("/home/ana/api"));
    writeFileSync(join(newer, `${SESSION}.jsonl`), claudeLines("/home/ana/api-wt"));
    utimesSync(join(older, `${SESSION}.jsonl`), new Date(1000), new Date(1000));
    expect(findTranscript("claude_code", SESSION, { env: {}, home })).toBe(
      join(newer, `${SESSION}.jsonl`),
    );
    expect(findTranscript("claude_code", "other", { env: {}, home })).toBeUndefined();
    expect(findTranscript("claude_code", "../x", { env: {}, home })).toBeUndefined();
  });

  it("reads CLAUDE_CONFIG_DIR and CODEX_HOME instead of the home folder", () => {
    const home = temp();
    const config = temp();
    const codex = temp();
    mkdirSync(join(config, "projects", "p"), { recursive: true });
    writeFileSync(join(config, "projects", "p", `${SESSION}.jsonl`), "{}");
    const day = join(codex, "sessions", "2026", "11", "10");
    mkdirSync(day, { recursive: true });
    const rollout = `rollout-2026-11-10T09-00-00-${SESSION}.jsonl`;
    writeFileSync(join(day, rollout), codexLines("/home/ana/api"));
    const env = { CLAUDE_CONFIG_DIR: config, CODEX_HOME: codex };
    expect(findTranscript("claude_code", SESSION, { env, home })).toBe(
      join(config, "projects", "p", `${SESSION}.jsonl`),
    );
    expect(findTranscript("codex", SESSION, { env, home })).toBe(join(day, rollout));
  });
});

describe("placing a transcript for a native resume", () => {
  it("puts a Claude Code session in the clone's project folder, moved to the clone", () => {
    const home = temp();
    const clone = join(temp(), "work", "api");
    const placed = placeTranscript(
      "claude_code",
      { sessionId: SESSION, fileName: `${SESSION}.jsonl`, text: claudeLines("/home/ana/api") },
      clone,
      { env: {}, home },
      { spare: join(home, "spare"), now: NOW },
    );
    const project = claudeProjectName(clone) ?? "";
    expect(project).toMatch(/^-.*-work-api$/);
    expect(placed).toEqual({
      path: join(home, ".claude", "projects", project, `${SESSION}.jsonl`),
      resumeBy: "id",
      written: true,
    });
    const text = readFileSync(placed.path, "utf8");
    expect(transcriptCwd("claude_code", text)).toBe(clone);
    expect(text).toContain(`"cwd":"${clone}/src"`);
    expect(text.endsWith("\n")).toBe(true);

    // A second takeover keeps the file that is there.
    const again = placeTranscript(
      "claude_code",
      { sessionId: SESSION, fileName: `${SESSION}.jsonl`, text: "changed" },
      clone,
      { env: {}, home },
      { spare: join(home, "spare"), now: NOW },
    );
    expect(again).toMatchObject({ path: placed.path, written: false });
    expect(readFileSync(placed.path, "utf8")).toBe(text);
  });

  it("resumes a Claude Code session by path when the project folder name would need a hash", () => {
    const home = temp();
    const clone = `/${"deep/".repeat(45)}api`;
    expect(claudeProjectName(clone)).toBeUndefined();
    const placed = placeTranscript(
      "claude_code",
      { sessionId: SESSION, fileName: `${SESSION}.jsonl`, text: claudeLines("/home/ana/api") },
      clone,
      { env: {}, home },
      { spare: join(home, "spare"), now: NOW },
    );
    expect(placed).toEqual({
      path: join(home, "spare", `${SESSION}.jsonl`),
      resumeBy: "path",
      written: true,
    });
  });

  it("puts a Codex rollout under its day in CODEX_HOME's sessions, moved to the clone", () => {
    const home = temp();
    const codex = temp();
    const fileName = `rollout-2026-11-10T09-00-00-${SESSION}.jsonl`;
    const placed = placeTranscript(
      "codex",
      { sessionId: SESSION, fileName, text: codexLines("/home/ana/api") },
      "/srv/ben/api",
      { env: { CODEX_HOME: codex }, home },
      { spare: join(home, "spare"), now: NOW },
    );
    expect(placed.path).toBe(join(codex, "sessions", "2026", "11", "10", fileName));
    const lines = readFileSync(placed.path, "utf8").split("\n");
    expect(JSON.parse(lines[0] ?? "").payload).toEqual({ id: SESSION, cwd: "/srv/ben/api" });
    expect(JSON.parse(lines[1] ?? "").payload.cwd).toBe("/srv/ben/api");
    expect(lines[2]).toBe(JSON.stringify({ type: "response_item", payload: { type: "message" } }));
  });

  it("refuses a file name that is not one path segment", () => {
    expect(() =>
      placeTranscript(
        "codex",
        { sessionId: SESSION, fileName: "../escape.jsonl", text: "" },
        "/srv/api",
        { env: {}, home: temp() },
        { spare: temp(), now: NOW },
      ),
    ).toThrow(/Not a transcript name/);
  });

  it("leaves lines that name another directory as they are", () => {
    const text = claudeLines("/elsewhere");
    expect(rehomeTranscript("claude_code", text, "/home/ana/api", "/srv/api")).toBe(text);
  });
});

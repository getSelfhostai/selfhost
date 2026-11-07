import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { plantedValues, readPlanted } from "../../../fixtures/redaction/planted.js";
import { importAll } from "../src/index.js";
import { summarize } from "../src/summary.js";
import { ALL_TIME, CLAUDE_DIR, CODEX_DIR, MemoryWriter, tempDir } from "./helpers.js";

const PROMPTS = [
  "Add a GET /health endpoint to the Express app",
  "GET /users?page=2 returns the same rows as page 1",
  "Write a short CONTRIBUTING.md",
  "Add a request logging middleware",
  "fails on CI about one run in five",
  "Review the last commit on this branch",
];

// File contents and patch bodies that tool calls carried in the fixtures.
const CONTENTS = [
  'import request from \\"supertest\\"',
  "vi.restoreAllMocks",
  "process.env.npm_package_version",
  "# Contributing to a",
];

async function fixtureJson(logPrompts: boolean): Promise<string> {
  const writer = new MemoryWriter();
  await importAll(writer, {
    claudeDir: CLAUDE_DIR,
    codexDir: CODEX_DIR,
    since: ALL_TIME,
    logPrompts,
  });
  return JSON.stringify(writer.list());
}

describe("what the importer stores", () => {
  it("stores no prompt text unless logPrompts is on", async () => {
    const off = await fixtureJson(false);
    for (const prompt of PROMPTS) expect(off).not.toContain(prompt);
    expect(off).not.toContain("prompt.submitted");
    const on = await fixtureJson(true);
    for (const prompt of PROMPTS) expect(on).toContain(prompt);
  });

  it("never stores file contents or patch bodies", async () => {
    const json = await fixtureJson(true);
    for (const content of CONTENTS) expect(json).not.toContain(content);
  });

  it("masks planted secrets in summaries and prompts", async () => {
    const lines = readPlanted("events-with-secrets.jsonl")
      .split("\n")
      .filter((line) => line.trim() !== "");
    const dir = tempDir("secrets");
    try {
      const claude = join(dir.path, "claude", "projects", "-home-dev-acme-api");
      const codex = join(dir.path, "codex", "sessions", "2026", "10", "10");
      mkdirSync(claude, { recursive: true });
      mkdirSync(codex, { recursive: true });
      const codexLines = lines.filter((line) => line.includes('"response_item"'));
      const claudeLines = lines.filter((line) => !codexLines.includes(line));
      writeFileSync(
        join(claude, "00000000-0000-4000-8000-000000000099.jsonl"),
        `${claudeLines.join("\n")}\n`,
      );
      writeFileSync(
        join(codex, "rollout-2026-10-10T12-05-00-01a12000-0000-7000-8000-000000000002.jsonl"),
        `${codexLines.join("\n")}\n`,
      );
      const writer = new MemoryWriter();
      await importAll(writer, {
        claudeDir: join(dir.path, "claude"),
        codexDir: join(dir.path, "codex"),
        since: ALL_TIME,
        logPrompts: true,
      });
      const events = writer.list();
      expect(events.map((event) => event.kind)).toEqual(
        expect.arrayContaining(["prompt.submitted", "tool.called"]),
      );
      const json = JSON.stringify(events);
      for (const { value } of plantedValues()) expect(json).not.toContain(value);
      for (const event of events.filter(
        (e) => e.kind === "tool.called" || e.kind === "prompt.submitted",
      )) {
        expect(event.redacted, event.kind).toBeDefined();
        expect(validateEvent(event).ok).toBe(true);
      }
    } finally {
      dir.cleanup();
    }
  });
});

describe("summaries", () => {
  it("keeps the first line of a command, truncated", () => {
    const long = `npm run build -- ${"--flag ".repeat(40)}`;
    const summary = summarize(long);
    expect(summary?.text.length).toBeLessThanOrEqual(120);
    expect(summary?.text.endsWith("...")).toBe(true);
    expect(summarize("cat <<'EOF' > notes.txt\nsecret body\nEOF")?.text).toBe(
      "cat <<'EOF' > notes.txt ...",
    );
  });
});

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { openLedger } from "@selfhost/ledger";
import { describe, expect, it } from "vitest";
import { drainSpool } from "../src/hooks/drain.js";
import { appendToSpool, runHook, spoolDir, spoolFile } from "../src/hooks/receive.js";
import { runImport } from "../src/import.js";
import { createProgram } from "../src/program.js";
import { run, tempDir } from "./run.js";

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");
const payload = (agent: "claude-code" | "codex", name: string) =>
  readFileSync(join(fixtures, "hooks", agent, `${name}.json`), "utf8");

function hookIo(home: string, stdin = "") {
  const errors: string[] = [];
  return {
    errors,
    io: {
      env: { HOME: home },
      readStdin: async () => stdin,
      writeError: (line: string) => errors.push(line),
      now: new Date("2026-10-09T10:00:00Z"),
    },
  };
}

const spoolLines = (dir: string) =>
  readdirSync(dir).flatMap((name) =>
    readFileSync(join(dir, name), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line)),
  );

describe("selfhost hook", () => {
  it("appends one line per event to the day's spool file and prints nothing", async () => {
    const home = tempDir("hook-home");
    const claude = hookIo(home.root, payload("claude-code", "PostToolUse"));
    expect(await runHook(["claude_code"], claude.io)).toBe(0);
    const notify = hookIo(home.root, "");
    const notifyPayload = payload("codex", "notify-agent-turn-complete");
    expect(await runHook(["codex-notify", notifyPayload], notify.io)).toBe(0);
    expect([...claude.errors, ...notify.errors]).toEqual([]);

    const dir = home.path(".selfhost", "spool");
    expect(readdirSync(dir)).toEqual(["hooks-2026-10-09.jsonl"]);
    const lines = spoolLines(dir);
    expect(lines.map((line) => [line.agent, line.received_at])).toEqual([
      ["claude", "2026-10-09T10:00:00.000Z"],
      ["codex-notify", "2026-10-09T10:00:00.000Z"],
    ]);
    // Tool output is never kept: the ledger does not read it.
    expect(lines[0].payload.hook_event_name).toBe("PostToolUse");
    expect(lines[0].payload.tool_response).toBeNull();
    expect(lines[1].payload).toEqual(JSON.parse(notifyPayload));
  });

  it("exits 0 and reports on stderr when the spool folder is not writable", async () => {
    const home = tempDir("hook-home");
    // A file where the spool folder should be: no process can create the folder.
    home.write(".selfhost/spool", "not a folder");
    const blocked = hookIo(home.root, payload("claude-code", "PreToolUse"));
    expect(await runHook(["claude"], blocked.io)).toBe(0);
    expect(blocked.errors.join("\n")).toMatch(/^selfhost hook: .*spool/);

    for (const [args, stdin] of [
      [["goose"], "{}"],
      [["claude"], "not json"],
      [["codex"], ""],
      [[], "{}"],
    ] as const) {
      const bad = hookIo(home.root, stdin);
      expect(await runHook([...args], bad.io)).toBe(0);
      expect(bad.errors).toHaveLength(1);
    }
    const noHome = hookIo(home.root, "{}");
    expect(await runHook(["claude"], { ...noHome.io, env: {} })).toBe(0);
    expect(noHome.errors[0]).toContain("HOME is not set");
  });

  it.skipIf(process.getuid?.() === 0)(
    "exits 0 from the command line with a read-only spool folder",
    () => {
      const home = tempDir("hook-home");
      const dir = home.path(".selfhost", "spool");
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o500);
      try {
        const cli = join(import.meta.dirname, "..");
        const result = spawnSync(
          process.execPath,
          ["--import", "tsx", join(cli, "src", "main.ts"), "hook", "claude"],
          {
            cwd: cli,
            env: { PATH: process.env.PATH, HOME: home.root },
            input: payload("claude-code", "PreToolUse"),
            encoding: "utf8",
          },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toMatch(/^selfhost hook: EACCES/);
        expect(readdirSync(dir)).toEqual([]);
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );

  it("is a command of the program and runs in process", async () => {
    expect(createProgram().commands.map((command) => command.name())).toContain("hook");
    const home = tempDir("hook-home");
    const result = await run(
      ["hook", "codex-notify", payload("codex", "notify-agent-turn-complete")],
      {
        env: { HOME: home.root },
      },
    );
    expect(result).toEqual({ code: 0, out: "", err: "" });
    expect(spoolLines(home.path(".selfhost", "spool"))).toHaveLength(1);
  });
});

describe("spool drain", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  const person = "dev@example.com";

  function spool() {
    const home = tempDir("spool-home");
    const dir = spoolDir({ HOME: home.root }) ?? "";
    // Yesterday: two events, a duplicate line, a malformed line and a cut-off last line.
    const yesterday = new Date("2026-10-09T09:00:00Z");
    appendToSpool(dir, "claude", payload("claude-code", "PreToolUse"), yesterday);
    appendToSpool(dir, "codex", payload("codex", "PostModelRequest"), yesterday);
    const old = spoolFile(dir, yesterday.toISOString());
    const first = readFileSync(old, "utf8").split("\n")[0];
    writeFileSync(old, `${readFileSync(old, "utf8")}${first}\n{"agent":"claude"\n{"agent":`, {
      flag: "w",
    });
    utimesSync(old, yesterday, yesterday);
    // Today: a Stop event (no ledger kind), an unknown agent and a notify payload.
    appendToSpool(dir, "claude", payload("claude-code", "Stop"), now);
    appendToSpool(dir, "codex-notify", payload("codex", "notify-agent-turn-complete"), now);
    const today = spoolFile(dir, now.toISOString());
    writeFileSync(today, '{"agent":"goose","received_at":"2026-10-10T12:00:00Z","payload":{}}\n', {
      flag: "a",
    });
    return { dir, old, today };
  }

  it("maps every line with deterministic ids, skips malformed ones and removes finished days", async () => {
    const { dir, old, today } = spool();
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      const first = await drainSpool(ledger, dir, { person, now });
      expect(first).toEqual({
        files: 2,
        lines: 8,
        accepted: 3,
        duplicates: 0,
        malformed: 3,
        // The copied first line is the same tool call again.
        repeated: 1,
        removed: 1,
      });
      expect(existsSync(old)).toBe(false);
      expect(existsSync(today)).toBe(true);

      // Today's file stays while hooks append to it; reading it again adds nothing.
      const second = await drainSpool(ledger, dir, { person, now });
      expect(second).toMatchObject({
        files: 1,
        lines: 3,
        accepted: 0,
        duplicates: 1,
        malformed: 1,
      });

      const tools = await ledger.query({ kind: "tool.called" });
      expect(tools.events.map((event) => [event.source, event.ts, event.actor.id])).toEqual([
        ["hook", "2026-10-09T09:00:00.000Z", person],
      ]);
      expect((await ledger.query({ kind: "cost.recorded" })).events).toHaveLength(1);
    } finally {
      await ledger.close();
    }
  });

  it("counts a call two hook entries both wrote once, by its tool call id", async () => {
    const home = tempDir("spool-twice");
    const dir = spoolDir({ HOME: home.root }) ?? "";
    // The managed settings' hook and the user's hook both ran for one call, ms apart.
    const at = new Date("2026-10-10T11:00:00.000Z");
    const later = new Date("2026-10-10T11:00:00.040Z");
    for (const name of ["PreToolUse", "PostToolUse", "UserPromptSubmit"]) {
      appendToSpool(dir, "claude", payload("claude-code", name), at);
      appendToSpool(dir, "claude", payload("claude-code", name), later);
    }
    // The same prompt typed again a minute later is a new event.
    appendToSpool(
      dir,
      "claude",
      payload("claude-code", "UserPromptSubmit"),
      new Date("2026-10-10T11:01:00.000Z"),
    );
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      const report = await drainSpool(ledger, dir, { person, now });
      expect(report).toMatchObject({ lines: 7, repeated: 3, malformed: 0 });
      expect((await ledger.query({ kind: "tool.called" })).events).toHaveLength(1);
      expect((await ledger.query({ kind: "tool.result" })).events).toHaveLength(1);
      expect((await ledger.query({ kind: "prompt.submitted" })).events).toHaveLength(2);
    } finally {
      await ledger.close();
    }
  });

  it("keeps every file on a dry run and drains through selfhost import", async () => {
    const { dir, old } = spool();
    const counted: string[] = [];
    const counting = {
      append: async (events: { id: string }[]) => {
        counted.push(...events.map((event) => event.id));
        return { accepted: events.map((event) => event.id), duplicates: [] };
      },
    };
    expect((await drainSpool(counting, dir, { person, now, keep: true })).accepted).toBe(3);
    expect(existsSync(old)).toBe(true);

    const ledger = await openLedger({ dataDir: "memory://" });
    const lines: string[] = [];
    const io = {
      env: {},
      write: (line: string) => lines.push(line),
      now,
      configPath: tempDir("spool-config").path("config.json"),
    };
    const empty = tempDir("no-logs");
    const options = { claudeDir: empty.root, codexDir: empty.root, person, spoolDir: dir };
    try {
      const first = await runImport(options, io, ledger);
      expect(first.hooks).toMatchObject({ accepted: 3, malformed: 3, removed: 1 });
      expect(lines).toContain(
        "Imported 3 new hook events from the spool (0 already in the ledger, 3 malformed lines skipped, 1 line from a second hook entry for the same call skipped).",
      );
      const second = await runImport(options, io, ledger);
      expect(second.hooks).toMatchObject({ accepted: 0, duplicates: 1 });
      expect((await ledger.query({})).events.map((event) => event.id).sort()).toEqual(
        [...new Set(counted)].sort(),
      );
    } finally {
      await ledger.close();
    }
  });
});

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importAll } from "@selfhost/importers";
import { type Ledger, openLedger } from "@selfhost/ledger";
import type { LedgerEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { cachedRepoOf } from "../src/git-repo.js";
import { oneCopyPerFact } from "../src/hooks/dedupe.js";
import { drainSpool } from "../src/hooks/drain.js";
import { runImport } from "../src/import.js";
import { tempDir } from "./run.js";

/**
 * Real Claude Code 2.1.83 sessions and the hook spool `selfhost hook` wrote for them on the
 * same laptop (fixtures/dogfood): every tool call and session start is in both.
 */
const DOGFOOD = join(import.meta.dirname, "..", "..", "..", "fixtures", "dogfood");
const SESSIONS = ["e47b0f2d-1c53-402b-a447-f6d3eb628c4d", "1e4bd4cd-c12d-4937-b679-d9a8041f63e2"];
const REPO = "acme/web-site";

/** The fixtures with the session's folder moved to a git clone whose origin is on GitHub. */
function laptop() {
  const dir = tempDir("dogfood");
  const clone = dir.path("web-site");
  mkdirSync(clone);
  execFileSync("git", ["init", "-q", clone]);
  execFileSync("git", ["-C", clone, "remote", "add", "origin", "git@github.com:acme/web-site.git"]);
  const cwd = realpathSync(clone);
  const move = (text: string) => text.replaceAll("/home/dev/project-1", cwd);
  const project = dir.path("claude", "projects", "-home-dev-project-1");
  mkdirSync(project, { recursive: true });
  const from = join(DOGFOOD, "claude-code", "projects", "-home-dev-project-1");
  for (const session of SESSIONS) {
    const name = `${session}.jsonl`;
    writeFileSync(join(project, name), move(readFileSync(join(from, name), "utf8")));
  }
  const spool = dir.path("spool");
  mkdirSync(spool);
  for (const name of readdirSync(join(DOGFOOD, "spool"))) {
    writeFileSync(join(spool, name), move(readFileSync(join(DOGFOOD, "spool", name), "utf8")));
  }
  return { claudeDir: dir.path("claude"), spool, configPath: dir.path("config.json") };
}

async function all(ledger: Ledger, kind: string): Promise<LedgerEvent[]> {
  const events: LedgerEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await ledger.query({ kind, limit: 1000, ...(cursor ? { cursor } : {}) });
    events.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor);
  return events.filter((e) => SESSIONS.includes(e.session_id ?? ""));
}

const perSession = (events: LedgerEvent[]) =>
  SESSIONS.map((session) => events.filter((e) => e.session_id === session).length);

async function expectOneCopy(ledger: Ledger) {
  // The transcripts hold 3 tool calls each; the first session's first Write failed validation
  // before its pre-tool hook ran, so the hooks saw only 2 of its 3.
  const calls = await all(ledger, "tool.called");
  expect(perSession(calls)).toEqual([3, 3]);
  expect(new Set(calls.map((e) => e.data?.tool_use_id)).size).toBe(6);
  expect(perSession(await all(ledger, "session.started"))).toEqual([1, 1]);
  // Each pre-tool decision links to the tool call that stayed.
  const ids = new Set(calls.map((e) => e.id));
  const decisions = await all(ledger, "policy.evaluated");
  expect(decisions).toHaveLength(5);
  for (const decision of decisions)
    expect(ids.has(String(decision.data?.tool_event_id))).toBe(true);
}

describe("hook and log copies of one session (real Claude Code 2.1.83 sessions)", () => {
  it("selfhost import keeps one tool.called per call and one session.started per session", async () => {
    const files = laptop();
    const ledger = await openLedger({ dataDir: "memory://" });
    const io = { env: {}, write: () => {}, configPath: files.configPath };
    const options = {
      claudeDir: files.claudeDir,
      spoolDir: files.spool,
      vendor: "claude",
      since: "2026-11-01",
      person: "alice@example.com",
    };
    try {
      const first = await runImport(options, io, ledger);
      await expectOneCopy(ledger);
      expect(first.duplicates).toBeGreaterThan(0);
      // The hook's copies stayed: they carry the permission mode the hook saw.
      const calls = await all(ledger, "tool.called");
      expect(calls.filter((e) => e.source === "hook")).toHaveLength(5);

      const second = await runImport(options, io, ledger);
      expect(second.accepted + second.hooks.accepted).toBe(0);
      await expectOneCopy(ledger);
    } finally {
      await ledger.close();
    }
  });

  it("keeps the log's copy when the log is read first, as a running --watch can", async () => {
    const files = laptop();
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      const writer = oneCopyPerFact(ledger);
      await importAll(writer, {
        claudeDir: files.claudeDir,
        vendor: "claude_code",
        since: new Date("2026-11-01"),
        actorId: "alice@example.com",
      });
      const report = await drainSpool(writer, files.spool, { person: "alice@example.com" });
      expect(report.duplicates).toBe(7); // 5 tool calls and 2 session starts
      await expectOneCopy(ledger);
      const calls = await all(ledger, "tool.called");
      expect(calls.every((e) => e.source === "local_log")).toBe(true);
    } finally {
      await ledger.close();
    }
  });

  it("sets owner/name from the clone's origin on hook and log events", async () => {
    const files = laptop();
    const ledger = await openLedger({ dataDir: "memory://" });
    const io = { env: {}, write: () => {}, configPath: files.configPath };
    try {
      await runImport(
        {
          claudeDir: files.claudeDir,
          spoolDir: files.spool,
          vendor: "claude",
          since: "2026-11-01",
          person: "alice@example.com",
        },
        io,
        ledger,
      );
      for (const kind of [
        "session.started",
        "tool.called",
        "cost.recorded",
        "policy.evaluated",
        "prompt.submitted",
        "tool.result",
        "session.ended",
      ]) {
        const events = await all(ledger, kind);
        expect(events.length, kind).toBeGreaterThan(0);
        expect(
          events.filter((e) => e.repo !== REPO).map((e) => `${e.kind} ${e.source}`),
          kind,
        ).toEqual([]);
      }
      const tail = await ledger.query({ kind: "tool.called", limit: 1000 });
      expect(tail.events.every((e) => e.repo === REPO)).toBe(true);
    } finally {
      await ledger.close();
    }
  });

  it("reads each folder's origin once, and nothing for a folder that is gone", () => {
    let calls = 0;
    const repoOf = cachedRepoOf((cwd) => {
      calls++;
      return cwd === "/a" ? "acme/api" : undefined;
    });
    expect([repoOf("/a"), repoOf("/a"), repoOf("/b"), repoOf("/b")]).toEqual([
      "acme/api",
      "acme/api",
      undefined,
      undefined,
    ]);
    expect(calls).toBe(2);
    expect(cachedRepoOf()("/nonexistent/selfhost-test-folder")).toBeUndefined();
  });
});

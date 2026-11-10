import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LedgerEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { importAll } from "../src/index.js";
import { createFileState, readChunk } from "../src/parse.js";
import { EventSelector } from "../src/select.js";
import { ALL_TIME, FIXTURES, MemoryWriter } from "./helpers.js";

/** Real Claude Code 2.1.83 sessions, scrubbed (fixtures/dogfood). */
const DOGFOOD = join(FIXTURES, "dogfood", "claude-code");
const PROJECT = join(DOGFOOD, "projects", "-home-dev-project-1");
const ALICE_SESSION = "e47b0f2d-1c53-402b-a447-f6d3eb628c4d";
const FILES = [
  ALICE_SESSION,
  "1e4bd4cd-c12d-4937-b679-d9a8041f63e2",
  "915dc8f5-6c69-4388-8b5b-2998a83d4e4d",
  "fd281561-c586-42ca-8bf5-caeaa48b5b19",
];

function totals(events: LedgerEvent[], session?: string) {
  const costs = events.filter(
    (e) => e.kind === "cost.recorded" && (session === undefined || e.session_id === session),
  );
  return {
    requests: costs.length,
    output: costs.reduce((sum, e) => sum + (e.cost?.output_tokens ?? 0), 0),
    usd: Math.round(costs.reduce((sum, e) => sum + (e.cost?.usd ?? 0), 0) * 1e9) / 1e9,
  };
}

/**
 * Reads a log the way `import --watch` does when each line lands in its own poll: one read per
 * line, flushed at a clock just after that line was written.
 */
async function tailLineByLine(path: string): Promise<LedgerEvent[]> {
  const state = createFileState("claude_code", path, { since: ALL_TIME });
  const selector = new EventSelector();
  const out: LedgerEvent[] = [];
  const text = readFileSync(path, "utf8");
  let end = 0;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    end += Buffer.byteLength(line) + 1;
    const ts = Date.parse((JSON.parse(line) as { timestamp?: string }).timestamp ?? "");
    const now = Number.isNaN(ts) ? undefined : ts + 500;
    selector.add(await readChunk(state, { end, ...(now === undefined ? {} : { now }) }));
    out.push(...selector.drain(ALL_TIME));
  }
  // The watcher keeps polling a quiet file; the session goes idle.
  selector.add(state.mapper.flush(Date.parse("2026-11-11T00:00:00Z")));
  out.push(...selector.drain(ALL_TIME));
  return out;
}

describe("real Claude Code 2.1.83 sessions", () => {
  it("one-shot import takes each response's final usage", async () => {
    const writer = new MemoryWriter();
    await importAll(writer, { claudeDir: DOGFOOD, since: ALL_TIME, vendor: "claude_code" });
    // What Claude Code reported for the session: 4 responses, 667 output tokens.
    expect(totals(writer.list(), ALICE_SESSION)).toEqual({
      requests: 4,
      output: 667,
      usd: expect.closeTo(0.049, 3),
    });
  });

  it("tailing line by line gives the same events as one read, for every session", async () => {
    const writer = new MemoryWriter();
    await importAll(writer, { claudeDir: DOGFOOD, since: ALL_TIME, vendor: "claude_code" });
    const oneShot = writer.list("cost.recorded");
    const tailed: LedgerEvent[] = [];
    for (const file of FILES)
      tailed.push(...(await tailLineByLine(join(PROJECT, `${file}.jsonl`))));
    const tailedCosts = tailed.filter((e) => e.kind === "cost.recorded");
    expect(totals(tailedCosts, ALICE_SESSION).output).toBe(667);
    for (const file of FILES) expect(totals(tailedCosts, file)).toEqual(totals(oneShot, file));
    const byId = (events: LedgerEvent[]) =>
      events.map((e) => [e.id, e.cost]).sort(([a], [b]) => String(a).localeCompare(String(b)));
    expect(byId(tailedCosts)).toEqual(byId(oneShot));
  });

  it("sets the repository of the session's working folder and the tool_use_id on every call", async () => {
    const writer = new MemoryWriter();
    const asked: string[] = [];
    await importAll(writer, {
      claudeDir: DOGFOOD,
      since: ALL_TIME,
      vendor: "claude_code",
      repoOf: (cwd) => {
        asked.push(cwd);
        return cwd === "/home/dev/project-1" ? "acme/web-site" : undefined;
      },
    });
    const events = writer.list();
    expect(events.length).toBeGreaterThan(0);
    expect(events.filter((e) => e.repo !== "acme/web-site")).toEqual([]);
    // Looked up once per folder and file, not once per event.
    expect(asked).toEqual(FILES.map(() => "/home/dev/project-1"));
    const calls = writer.list("tool.called");
    expect(calls.map((e) => e.data?.tool_use_id)).toContain("toolu_01UyeH63SwDAoaL1gB65aT5b");
    expect(calls.every((e) => typeof e.data?.tool_use_id === "string")).toBe(true);
  });

  it("waits for a response's final line, and emits a cut-off one once the log goes quiet", async () => {
    const path = join(PROJECT, `${ALICE_SESSION}.jsonl`);
    const lines = readFileSync(path, "utf8").split("\n");
    // Lines 0 to 5: the prompt and the first line of the first response (4 output tokens so far).
    const end = lines.slice(0, 6).reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
    const state = createFileState("claude_code", path, { since: ALL_TIME });
    const early = await readChunk(state, { end, now: Date.parse("2026-11-10T07:33:56Z") });
    expect(early.filter((p) => p.event.kind === "cost.recorded")).toEqual([]);
    const late = state.mapper.flush(Date.parse("2026-11-10T09:00:00Z"));
    expect(late.filter((p) => p.event.kind === "cost.recorded")).toHaveLength(1);
  });
});

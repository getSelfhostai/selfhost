import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRequestType, type LedgerEvent } from "@selfhost/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { codexThreadRequestType } from "../src/codex.js";
import { importAll, parseLogFile } from "../src/index.js";
import { ALL_TIME, CLAUDE_DIR, CODEX_DIR, FIXTURES, MemoryWriter, tempDir } from "./helpers.js";

const WEEK = join(FIXTURES, "sources", "subscription-week");

function costs(writer: MemoryWriter, vendor: "claude_code" | "codex"): LedgerEvent[] {
  return writer.list("cost.recorded").filter((event) => event.agent?.vendor === vendor);
}

const summary = (events: LedgerEvent[]) =>
  [
    ...new Set(events.map((e) => `${e.data?.request_type} ${e.data?.request_source ?? "-"}`)),
  ].sort();

describe("request types from local logs", () => {
  const writer = new MemoryWriter();

  beforeAll(async () => {
    await importAll(writer, {
      claudeDir: join(WEEK, "claude-code"),
      codexDir: join(WEEK, "codex"),
      since: ALL_TIME,
    });
  });

  it("labels Claude Code responses from the api-request line their requestRef names", () => {
    expect(summary(costs(writer, "claude_code"))).toEqual([
      "main repl_main_thread",
      "retry repl_main_thread",
      "subagent -",
      "subagent agent:builtin:Explore",
    ]);
  });

  it("falls back to the sidechain flag when a subagent transcript has no api-request lines", () => {
    const fallback = costs(writer, "claude_code").filter(
      (e) => e.data?.request_type === "subagent" && e.data?.request_source === undefined,
    );
    expect(fallback.map((e) => e.ts.slice(0, 10))).toEqual(["2026-10-20", "2026-10-20"]);
  });

  it("marks the first response after an api_error line as a retry", () => {
    const retries = costs(writer, "claude_code").filter((e) => e.data?.request_type === "retry");
    expect(retries.map((e) => e.ts.slice(0, 10))).toEqual(["2026-10-21"]);
  });

  it("labels Codex rollouts from session_meta and compaction records", () => {
    expect(summary(costs(writer, "codex"))).toEqual([
      "background guardian_review",
      "compaction -",
      "main -",
    ]);
    const reviews = costs(writer, "codex").filter((e) => e.data?.request_type === "background");
    expect(new Set(reviews.map((e) => e.model))).toEqual(new Set(["gpt-5.6-luna"]));
    expect(reviews.every((e) => (e.cost?.usd ?? 0) > 0)).toBe(true);
  });
});

describe("request types on the original fixtures", () => {
  it("labels every cost, and every Claude Code response main", async () => {
    const writer = new MemoryWriter();
    await importAll(writer, { claudeDir: CLAUDE_DIR, codexDir: CODEX_DIR, since: ALL_TIME });
    const all = writer.list("cost.recorded");
    expect(all.every((e) => isRequestType(e.data?.request_type))).toBe(true);
    expect(summary(costs(writer, "claude_code"))).toEqual(["main -"]);
    expect(summary(costs(writer, "codex"))).toEqual(["main -"]);
  });
});

describe("Claude Code retries", () => {
  const session = "665bce74-4bdc-4164-8bb1-cc4246de2400";
  const base = {
    sessionId: session,
    version: "2.1.312",
    cwd: "/home/dev/acme-api",
    isSidechain: false,
  };
  const response = (n: number, timestamp: string) => ({
    ...base,
    type: "assistant",
    uuid: `00000000-0000-4000-8000-00000000b00${n}`,
    timestamp,
    requestId: `req_retrytest${n}`,
    message: {
      id: `msg_retrytest${n}`,
      model: "claude-opus-5-5",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 6, output_tokens: 20, cache_read_input_tokens: 1000 },
    },
  });
  const errorMessage = (timestamp: string) => ({
    ...base,
    type: "assistant",
    uuid: "00000000-0000-4000-8000-00000000b0e1",
    timestamp,
    isApiErrorMessage: true,
    error: "overloaded",
    message: {
      id: "msg_synthetic",
      model: "<synthetic>",
      role: "assistant",
      content: [{ type: "text", text: "API Error: 529 Overloaded" }],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  const prompt = (timestamp: string) => ({
    ...base,
    type: "user",
    uuid: "00000000-0000-4000-8000-00000000b0f1",
    timestamp,
    message: { role: "user", content: "try again" },
  });

  async function types(lines: object[]): Promise<unknown[]> {
    const dir = tempDir("retry");
    try {
      const path = join(dir.path, `${session}.jsonl`);
      writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
      const { events } = await parseLogFile("claude_code", path, { since: ALL_TIME });
      return events.filter((e) => e.kind === "cost.recorded").map((e) => e.data?.request_type);
    } finally {
      dir.cleanup();
    }
  }

  it("counts the response after a synthetic API error message as a retry", async () => {
    expect(
      await types([
        response(1, "2026-10-21T09:00:00.000Z"),
        errorMessage("2026-10-21T09:01:00.000Z"),
        response(2, "2026-10-21T09:02:00.000Z"),
        response(3, "2026-10-21T09:03:00.000Z"),
      ]),
    ).toEqual(["main", "retry", "main"]);
  });

  it("counts the response to a new prompt after an error as main", async () => {
    expect(
      await types([
        errorMessage("2026-10-21T09:01:00.000Z"),
        prompt("2026-10-21T09:01:30.000Z"),
        response(2, "2026-10-21T09:02:00.000Z"),
      ]),
    ).toEqual(["main"]);
  });
});

describe("codexThreadRequestType", () => {
  it.each([
    ["cli", "user", "main", undefined],
    ["exec", undefined, "main", undefined],
    [{ subagent: "compact" }, undefined, "compaction", "subagent_compact"],
    [{ subagent: "review" }, undefined, "subagent", "subagent_review"],
    [{ subagent: { thread_spawn: { depth: 1 } } }, "subagent", "subagent", "subagent"],
    [
      { subagent: "memory_consolidation" },
      undefined,
      "background",
      "subagent_memory_consolidation",
    ],
    [{ internal: "guardian" }, "guardian_review", "background", "guardian_review"],
    [
      { internal: "memory_consolidation" },
      undefined,
      "background",
      "internal_memory_consolidation",
    ],
  ])("maps source %j with thread_source %s to %s", (source, thread, type, label) => {
    expect(codexThreadRequestType(source, thread)).toEqual({
      type,
      ...(label ? { label } : {}),
    });
  });
});

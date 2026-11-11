import type { LedgerEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { lastTurns } from "../src/index.js";

let n = 0;
const call = (source: LedgerEvent["source"], toolUse: string, minute: number): LedgerEvent => ({
  id: `019a7200-0000-7000-8000-${(++n).toString(16).padStart(12, "0")}`,
  schema: "selfhost.event/v1",
  ts: `2026-11-11T10:${String(minute).padStart(2, "0")}:00.000Z`,
  source,
  kind: "tool.called",
  actor: { kind: "person", id: "ada@example.com" },
  session_id: "s-1",
  agent: { vendor: "claude_code" },
  tool: { name: "Bash", input_summary: `pnpm test ${toolUse}` },
  data: { tool_use_id: toolUse },
});

describe("last turns of a handoff", () => {
  it("lists a tool call once when the hook and the session log both stored it", () => {
    const turns = lastTurns(
      [
        call("hook", "toolu_a", 1),
        call("local_log", "toolu_a", 1),
        call("hook", "toolu_b", 2),
        call("local_log", "toolu_b", 2),
        call("local_log", "toolu_c", 3),
      ],
      10,
    );
    expect(turns.map((turn) => turn.text)).toEqual([
      "Bash: pnpm test toolu_a",
      "Bash: pnpm test toolu_b",
      "Bash: pnpm test toolu_c",
    ]);
  });
});

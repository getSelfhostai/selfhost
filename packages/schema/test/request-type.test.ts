import { describe, expect, it } from "vitest";
import { claudeCodeRequestType, isRequestType, REQUEST_TYPES } from "../src/index.js";

describe("request types", () => {
  it("keeps a small, fixed vocabulary", () => {
    expect(REQUEST_TYPES).toEqual([
      "main",
      "subagent",
      "compaction",
      "title",
      "status_line",
      "background",
      "retry",
      "unknown",
    ]);
    expect(isRequestType("status_line")).toBe(true);
    expect(isRequestType("agent_summary")).toBe(false);
    expect(isRequestType(undefined)).toBe(false);
  });
});

describe("claudeCodeRequestType", () => {
  it.each([
    ["repl_main_thread", "main"],
    ["repl_main_thread:outputStyle:Explanatory", "main"],
    ["sdk", "main"],
    ["agent:builtin:general-purpose", "subagent"],
    ["agent:custom", "subagent"],
    ["agent.builtin.Explore", "subagent"],
    ["hook_agent", "subagent"],
    ["compact", "compaction"],
    ["generate_session_title", "title"],
    ["agent_summary", "status_line"],
    ["prompt_suggestion", "background"],
    ["auto_mode", "background"],
    ["away_summary", "background"],
    ["extract_memories", "background"],
  ])("maps %s to %s", (source, type) => {
    expect(claudeCodeRequestType(source)).toBe(type);
  });

  it("prefers the named source over the subagent hint", () => {
    expect(claudeCodeRequestType("agent_summary", { subagent: true })).toBe("status_line");
    expect(claudeCodeRequestType("compact", { subagent: true })).toBe("compaction");
  });

  it("treats an unlisted source from a named subagent as subagent work", () => {
    expect(claudeCodeRequestType("general-purpose", { subagent: true })).toBe("subagent");
  });

  it("leaves the default to the caller when there is no source", () => {
    expect(claudeCodeRequestType(undefined)).toBeUndefined();
    expect(claudeCodeRequestType(" ")).toBeUndefined();
    expect(claudeCodeRequestType(undefined, { subagent: true })).toBe("subagent");
  });
});

import { TypeCompiler } from "@sinclair/typebox/compiler";
import { describe, expect, it } from "vitest";
import { MCP_TOOLS } from "../src/index.js";
import { PACKAGE_ROOT, read } from "./contracts.js";

interface ToolEntry {
  name: string;
  description: string;
  annotations: { readOnlyHint: boolean };
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

const file: { tools: ToolEntry[] } = JSON.parse(read(PACKAGE_ROOT, "mcp-tools.json"));

describe("mcp-tools.json", () => {
  it("lists the v1 tools", () => {
    expect(file.tools.map((tool) => tool.name)).toEqual([
      "get_policy",
      "get_budget",
      "list_review_items",
      "search_events",
      "search_decisions",
      "list_file_runs",
      "list_active_on_file",
      "who",
      "ask_human",
      "request_exception",
      "get_answer",
      "record_decision",
    ]);
  });

  it("marks only the three writing tools as not read-only", () => {
    const writers = file.tools.filter((tool) => !tool.annotations.readOnlyHint);
    expect(writers.map((tool) => tool.name)).toEqual([
      "ask_human",
      "request_exception",
      "record_decision",
    ]);
  });

  it.each(file.tools)("$name has object input and output schemas", (tool) => {
    expect(tool.description).toBeTruthy();
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.outputSchema.type).toBe("object");
    expect(JSON.stringify(tool)).not.toContain('"$ref"');
  });

  it("accepts an empty input for every tool that needs no subject", () => {
    const needInput = new Set([
      "list_file_runs",
      "list_active_on_file",
      "ask_human",
      "request_exception",
      "get_answer",
      "record_decision",
    ]);
    for (const tool of MCP_TOOLS) {
      const accepts = TypeCompiler.Compile(tool.inputSchema).Check({});
      expect(accepts, tool.name).toBe(!needInput.has(tool.name));
    }
  });
});

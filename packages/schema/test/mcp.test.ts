import { TypeCompiler } from "@sinclair/typebox/compiler";
import { describe, expect, it } from "vitest";
import { MCP_TOOLS } from "../src/index.js";
import { PACKAGE_ROOT, read } from "./contracts.js";

interface ToolEntry {
  name: string;
  description: string;
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
      "record_decision",
    ]);
  });

  it.each(file.tools)("$name has object input and output schemas", (tool) => {
    expect(tool.description).toBeTruthy();
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.outputSchema.type).toBe("object");
    expect(JSON.stringify(tool)).not.toContain('"$ref"');
  });

  it("accepts an empty input for every read tool", () => {
    for (const tool of MCP_TOOLS) {
      const accepts = TypeCompiler.Compile(tool.inputSchema).Check({});
      expect(accepts, tool.name).toBe(tool.name !== "record_decision");
    }
  });
});

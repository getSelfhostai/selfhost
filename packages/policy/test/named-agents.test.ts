import { describe, expect, it } from "vitest";
import { evaluate, namedAgentToolsRuleId } from "../src/index.js";
import { config } from "./helpers.js";

const policy = (mode: string) =>
  config(`version = 1
[agents.janitor]
owner = "bo@example.com"
tools = ["Read", "Edit", "mcp__github__*"]
mode = "${mode}"
`);

describe("a named agent's tools", () => {
  it("records a call outside its tools in observe and blocks it in enforce", () => {
    const call = { agent: "claude_code" as const, tool: "Bash", command: "rm -rf build" };
    expect(evaluate(policy("observe"), { ...call, namedAgent: "janitor" })).toEqual([
      {
        rule_id: namedAgentToolsRuleId("janitor"),
        mode: "observe",
        verdict: "block",
        message: "Agent janitor may not use Bash: it is not in [agents.janitor] tools.",
        alternative:
          "Use one of Read, Edit, mcp__github__*, or ask bo@example.com to add this tool to the list.",
        irreversible: false,
      },
    ]);
    expect(evaluate(policy("enforce"), { ...call, namedAgent: "janitor" })).toEqual([
      expect.objectContaining({ rule_id: "agents.janitor.tools", mode: "enforce" }),
    ]);
  });

  it("lets its own tools through, and does not check other agents or people", () => {
    const enforce = policy("enforce");
    expect(evaluate(enforce, { tool: "Edit", path: "a.ts", namedAgent: "janitor" })).toEqual([]);
    expect(evaluate(enforce, { tool: "mcp__github__get_issue", namedAgent: "janitor" })).toEqual(
      [],
    );
    expect(evaluate(enforce, { tool: "Bash", command: "ls" })).toEqual([]);
    expect(evaluate(enforce, { tool: "Bash", command: "ls", namedAgent: "other" })).toEqual([]);
  });
});

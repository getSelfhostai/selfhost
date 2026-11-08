import { describe, expect, it } from "vitest";
import { parsePolicyTestFile } from "../src/index.js";

describe("parsePolicyTestFile", () => {
  it("defaults the tool to Bash and reports the line of each case", () => {
    const result = parsePolicyTestFile(`config = "strict.toml"

[[cases]]
name = "npm publish"
command = "npm publish"
decision = "ask"
mode = "enforce"
rules = ["package-publish"]

[[cases]]
name = "slack MCP"
tool = "mcp__slack__post_message"
agent = "codex"
team = "platform"
decision = "allow"
`);
    expect(result).toEqual({
      ok: true,
      file: {
        config: "strict.toml",
        cases: [
          {
            name: "npm publish",
            tool: "Bash",
            command: "npm publish",
            decision: "ask",
            mode: "enforce",
            rules: ["package-publish"],
          },
          {
            name: "slack MCP",
            tool: "mcp__slack__post_message",
            agent: "codex",
            team: "platform",
            decision: "allow",
          },
        ],
      },
      lines: [3, 10],
    });
  });

  it("names the field and line of every schema error", () => {
    const result = parsePolicyTestFile(`[[cases]]
name = "a"
decision = "maybe"

[[cases]]
name = "b"
decision = "block"
mode = "always"
comand = "ls"
`);
    expect(result).toEqual({
      ok: false,
      errors: [
        { field: "cases[0].decision", message: "Expected one of: allow, ask, block", line: 3 },
        { field: "cases[1].comand", message: "Unexpected property", line: 9 },
        { field: "cases[1].mode", message: "Expected one of: enforce, observe", line: 8 },
      ],
    });
  });

  it("rejects duplicate names and a mode on an allow decision", () => {
    const result = parsePolicyTestFile(`[[cases]]
name = "same"
decision = "allow"
mode = "observe"

[[cases]]
name = "same"
decision = "block"
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      {
        field: "cases[0].mode",
        message: "An allow decision has no mode: no rule fires. Remove mode or expect block or ask",
        line: 4,
      },
      {
        field: "cases[1].name",
        message: 'Duplicate case name "same", also used by cases[0]',
        line: 7,
      },
    ]);
  });

  it("needs at least one case and reports TOML syntax errors with their line", () => {
    const empty = parsePolicyTestFile('config = "x.toml"\n');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.errors[0]?.field).toBe("cases");
    const broken = parsePolicyTestFile("[[cases]]\nname = \n");
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.errors[0]).toMatchObject({ field: "(toml)", line: 2 });
  });
});

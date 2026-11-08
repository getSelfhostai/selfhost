import { describe, expect, it } from "vitest";
import { setGuardrailsMode } from "../src/promote.js";

const RULE = `version = 1

[[rules]]
id = "no-force-push"
match = { tool = "Bash", command = "git push --force" }
action = "block"
message = "No force pushes."
`;

describe("setGuardrailsMode", () => {
  it("sets the mode line of a [guardrails] table, keeping its comment and quotes", () => {
    const text = `version = 1\n\n[guardrails]\nmode = 'observe' # for now\ndisable = []\n`;
    const result = setGuardrailsMode(text);
    expect(result).toEqual({
      text: `version = 1\n\n[guardrails]\nmode = 'enforce' # for now\ndisable = []\n`,
      changed: true,
      from: "observe",
      to: "enforce",
      line: 4,
    });
  });

  it("adds a mode line after a [guardrails] header that has none", () => {
    const text = `version = 1\n\n[guardrails]\ndisable = ["guard.reset_hard"]\n`;
    const result = setGuardrailsMode(text, "observe");
    expect(result.text).toBe(
      `version = 1\n\n[guardrails]\nmode = "observe"\ndisable = ["guard.reset_hard"]\n`,
    );
    expect(result).toMatchObject({ changed: true, from: "enforce", to: "observe", line: 4 });
  });

  it("appends a [guardrails] table to a file that has none", () => {
    const result = setGuardrailsMode(RULE, "observe");
    expect(result.text).toBe(`${RULE}\n[guardrails]\nmode = "observe"\n`);
    expect(result.line).toBe(10);
    expect(result.text.split("\n")[(result.line ?? 0) - 1]).toBe('mode = "observe"');
  });

  it("keeps CRLF line endings", () => {
    const text = `version = 1\r\n\r\n[guardrails]\r\nmode = "off"\r\n`;
    expect(setGuardrailsMode(text).text).toBe(
      `version = 1\r\n\r\n[guardrails]\r\nmode = "enforce"\r\n`,
    );
  });

  it("changes nothing when guardrails already have the mode, including the default", () => {
    expect(setGuardrailsMode(RULE)).toEqual({
      text: RULE,
      changed: false,
      from: "enforce",
      to: "enforce",
      line: null,
    });
  });

  it("refuses inline tables and dotted keys", () => {
    expect(() => setGuardrailsMode(`version = 1\nguardrails = { mode = "observe" }\n`)).toThrow(
      /inline table.*edit it by hand/,
    );
    expect(() => setGuardrailsMode(`version = 1\nguardrails.mode = "observe"\n`)).toThrow(
      /edit it by hand/,
    );
  });

  it("refuses an invalid file and an unknown mode", () => {
    expect(() => setGuardrailsMode(`version = 1\n[guardrails]\nmode = "loud"\n`)).toThrow(
      /not valid/,
    );
    expect(() => setGuardrailsMode(RULE, "loud" as "enforce")).toThrow(/Expected a mode/);
  });
});

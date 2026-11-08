import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parse as parseToml, TomlError } from "smol-toml";
import { NonEmpty, StringEnum } from "./common.js";
import { AGENT_VENDORS } from "./event.js";
import { TomlLineIndex } from "./toml-lines.js";
import {
  type FieldError,
  formatField,
  lazyCheck,
  type SegmentError,
  schemaErrors,
} from "./validate.js";

/**
 * What selfhost decides on one tool call: block or ask when a rule fires, allow when none
 * does. Block wins over ask.
 */
export const POLICY_DECISIONS = ["allow", "ask", "block"] as const;
/** enforce: the decision is applied. observe: it is only recorded and the call goes through. */
export const DECISION_MODES = ["enforce", "observe"] as const;

export type PolicyDecision = (typeof POLICY_DECISIONS)[number];
export type DecisionMode = (typeof DECISION_MODES)[number];

/** Tool a case calls when it names none: the shell, where most rules match. */
export const DEFAULT_TEST_TOOL = "Bash";

export const PolicyTestCaseSchema = Type.Object(
  {
    name: NonEmpty({ description: "What the case checks. Shown when it fails." }),
    tool: Type.Optional(
      NonEmpty({
        default: DEFAULT_TEST_TOOL,
        description:
          "Tool name as the agent reports it, like Bash, exec_command, Edit or mcp__github__get_issue. Default Bash.",
      }),
    ),
    command: Type.Optional(NonEmpty({ description: "Shell command." })),
    path: Type.Optional(
      NonEmpty({ description: "File path relative to the repository root, with / separators." }),
    ),
    url: Type.Optional(NonEmpty({ description: "URL the agent requests." })),
    model: Type.Optional(NonEmpty({ description: "Model id the agent reports." })),
    agent: Type.Optional(
      StringEnum(AGENT_VENDORS, { description: "Agent that makes the call. Default: any." }),
    ),
    team: Type.Optional(NonEmpty({ description: "Apply this team's overrides from [teams]." })),
    decision: StringEnum(POLICY_DECISIONS, {
      description:
        "Expected decision. Enforce rules decide first, observe rules only when no enforce rule fires; block wins over ask. allow means no rule fires.",
    }),
    mode: Type.Optional(
      StringEnum(DECISION_MODES, {
        description:
          "Expected mode of a block or ask decision: enforce applies it, observe only records it. Not checked when absent.",
      }),
    ),
    rules: Type.Optional(
      Type.Array(NonEmpty(), {
        description:
          "Exactly the rule ids that fire, in any order, enforce and observe alike. Not checked when absent.",
      }),
    ),
  },
  { additionalProperties: false, description: "One tool call and the decision it should get." },
);

export const PolicyTestFileSchema = Type.Object(
  {
    config: Type.Optional(
      NonEmpty({
        description:
          "The selfhost.toml these cases test, relative to this file. Default: this file's name without .test, so strict.test.toml tests strict.toml.",
      }),
    ),
    cases: Type.Array(PolicyTestCaseSchema, { minItems: 1, description: "The cases, in order." }),
  },
  {
    title: "PolicyTestFile",
    description: "Test cases for the rules in a selfhost.toml, run by selfhost policy test.",
    additionalProperties: false,
  },
);

export type PolicyTestCase = Static<typeof PolicyTestCaseSchema>;
export type PolicyTestFile = Static<typeof PolicyTestFileSchema>;
export type ResolvedPolicyTestCase = PolicyTestCase & { tool: string };
export type ResolvedPolicyTestFile = Omit<PolicyTestFile, "cases"> & {
  cases: ResolvedPolicyTestCase[];
};

export type PolicyTestFileResult =
  | {
      ok: true;
      file: ResolvedPolicyTestFile;
      /** 1-based line of each case's [[cases]] header, in case order. */
      lines: (number | undefined)[];
    }
  | { ok: false; errors: FieldError[] };

const testFileCheck = lazyCheck(PolicyTestFileSchema);

function semanticErrors(file: ResolvedPolicyTestFile): SegmentError[] {
  const errors: SegmentError[] = [];
  const names = new Map<string, number>();
  file.cases.forEach((testCase, index) => {
    const earlier = names.get(testCase.name);
    if (earlier === undefined) names.set(testCase.name, index);
    else {
      errors.push({
        segments: ["cases", index, "name"],
        message: `Duplicate case name "${testCase.name}", also used by cases[${earlier}]`,
      });
    }
    if (testCase.decision === "allow" && testCase.mode !== undefined) {
      errors.push({
        segments: ["cases", index, "mode"],
        message: "An allow decision has no mode: no rule fires. Remove mode or expect block or ask",
      });
    }
  });
  return errors;
}

/**
 * Parses a policy test file (TOML): applies defaults and validates it. Errors name the field
 * and, when it can be found, the line.
 */
export function parsePolicyTestFile(text: string): PolicyTestFileResult {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error) {
    if (error instanceof TomlError) {
      const message = error.message.split("\n")[0] ?? error.message;
      return {
        ok: false,
        errors: [{ field: "(toml)", message, line: error.line, column: error.column }],
      };
    }
    throw error;
  }
  const withDefaults = Value.Default(PolicyTestFileSchema, Value.Clone(raw));
  let errors = schemaErrors(testFileCheck(), withDefaults);
  const file = withDefaults as ResolvedPolicyTestFile;
  if (errors.length === 0) errors = semanticErrors(file);
  const index = new TomlLineIndex(text);
  if (errors.length === 0) {
    return { ok: true, file, lines: file.cases.map((_, i) => index.lineOf(["cases", i])) };
  }
  return {
    ok: false,
    errors: errors.map((e) => {
      const line = index.lineOf(e.segments);
      const field = formatField(e.segments);
      return line === undefined
        ? { field, message: e.message }
        : { field, message: e.message, line };
    }),
  };
}

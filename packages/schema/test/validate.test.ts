import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createValidator, parseConfig } from "../src/index.js";

/** What a browser does with new Function under a content security policy without unsafe-eval. */
function blocked(): never {
  throw new EvalError("Evaluating a string as JavaScript violates the content security policy");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validators where eval is not allowed", () => {
  it("check by walking the schema, with the same answers and errors", () => {
    const schema = Type.Object({ id: Type.String({ minLength: 2 }), n: Type.Integer() });
    const csp = vi.spyOn(globalThis, "Function").mockImplementation(blocked);
    const validator = createValidator(schema);
    expect(validator.check({ id: "ab", n: 1 })).toBe(true);
    expect(validator.validate({ id: "a", n: 1.5 })).toEqual({
      ok: false,
      errors: [
        { field: "id", message: "Expected string length greater or equal to 2" },
        { field: "n", message: "Expected integer" },
      ],
    });
    expect(csp).toHaveBeenCalled();
  });

  it("still parse selfhost.toml", () => {
    vi.spyOn(globalThis, "Function").mockImplementation(blocked);
    const result = parseConfig('version = 1\n\n[guardrails]\nmode = "observe"\n');
    expect(result.ok).toBe(true);
  });
});

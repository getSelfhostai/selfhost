import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACTS, FIXTURES, listFiles, read, readExpected } from "./contracts.js";

describe.each(Object.entries(CONTRACTS))("%s fixtures", (name, contract) => {
  const dir = join(FIXTURES, name);
  const valid = listFiles(join(dir, "valid"), contract.ext);
  const invalid = listFiles(join(dir, "invalid"), contract.ext);
  const expected = readExpected(name);

  it("has valid and invalid fixtures", () => {
    expect(valid.length).toBeGreaterThan(0);
    expect(invalid.length).toBeGreaterThan(0);
  });

  it("lists every invalid fixture in expected.json", () => {
    expect(Object.keys(expected).sort()).toEqual(invalid);
  });

  it.each(valid)("accepts valid/%s", (file) => {
    const result = contract.validate(read(dir, "valid", file));
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it.each(invalid)("rejects invalid/%s with an error naming the field", (file) => {
    const want = expected[file];
    const result = contract.validate(read(dir, "invalid", file));
    expect(result.ok).toBe(false);
    if (result.ok || !want) return;
    const error = result.errors.find((e) => e.field === want.field);
    expect(error, `errors were ${JSON.stringify(result.errors)}`).toBeDefined();
    expect(error?.message).not.toBe("");
    if (want.line !== undefined) expect(error?.line).toBe(want.line);
  });
});

// CI writes every valid event fixture to a real server in one batch, which rejects repeated ids.
describe("event fixtures", () => {
  it("use a different id each", () => {
    const dir = join(FIXTURES, "event", "valid");
    const ids = listFiles(dir, ".json").map((file) => JSON.parse(read(dir, file)).id as string);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

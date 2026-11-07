import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { CONTRACTS, FIXTURES, listFiles, PACKAGE_ROOT, read } from "./contracts.js";

// The exported JSON Schema files are the contract for other languages. This checks them with
// an independent validator, so they agree with the TypeBox validators on every fixture.
// Config fixtures are checked after TOML parsing; semantic checks (duplicate ids, regex
// syntax, unknown rule overrides, reserved rule ids) live in parseConfig only, so those
// fixtures are skipped.
const SEMANTIC_ONLY = new Set([
  "bad-command-regex.toml",
  "duplicate-rule-id.toml",
  "override-unknown-rule.toml",
  "reserved-rule-id.toml",
  "not-toml.toml",
]);

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);

function load(text: string, ext: string): unknown {
  return ext === ".toml" ? parse(text) : JSON.parse(text);
}

describe.each(Object.entries(CONTRACTS))("json/%s", (name, contract) => {
  const schema = JSON.parse(read(PACKAGE_ROOT, "json", contract.jsonSchema));
  const validate = ajv.compile(schema);
  const dir = join(FIXTURES, name);

  it.each(listFiles(join(dir, "valid"), contract.ext))("accepts valid/%s", (file) => {
    const ok = validate(load(read(dir, "valid", file), contract.ext));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  const invalid = listFiles(join(dir, "invalid"), contract.ext).filter(
    (file) => !SEMANTIC_ONLY.has(file),
  );
  it.each(invalid)("rejects invalid/%s", (file) => {
    expect(validate(load(read(dir, "invalid", file), contract.ext))).toBe(false);
  });
});

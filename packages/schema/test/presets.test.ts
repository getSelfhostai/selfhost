import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { CONFIG_SCHEMA_DIRECTIVE, CONFIG_SCHEMA_URL, parseConfig } from "../src/index.js";
import { FIXTURES, listFiles, PACKAGE_ROOT, read } from "./contracts.js";

// The presets in the repository's presets/ folder are what `selfhost init --preset` writes.
// Each must pass the published JSON Schema the way editors read it, and parseConfig.
const PRESETS = join(PACKAGE_ROOT, "..", "..", "presets");
const presets = readdirSync(PRESETS)
  .filter((file) => file.endsWith(".toml") && !file.endsWith(".test.toml"))
  .sort();

const schema = JSON.parse(read(PACKAGE_ROOT, "json", "config.schema.json"));

const draft2020 = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(draft2020);
const validate = draft2020.compile(schema);

// Taplo (Even Better TOML) does not know the 2020-12 meta-schema and falls back to draft-07,
// so the schema has to mean the same there.
const { $schema: _metaSchema, ...draft7Schema } = schema;
const draft7 = new Ajv({ allErrors: true, strict: false });
addFormats.default(draft7);
const validateDraft7 = draft7.compile(draft7Schema);

describe("config.schema.json", () => {
  it("has the published URL as its $id", () => {
    expect(schema.$id).toBe(CONFIG_SCHEMA_URL);
  });

  it("rejects the invalid config fixtures as draft-07 too", () => {
    const semanticOnly = [
      "bad-command-regex.toml",
      "duplicate-rule-id.toml",
      "override-unknown-rule.toml",
      "reserved-rule-id.toml",
      "reserved-package-rule-id.toml",
      "reserved-guardrail-id.toml",
      "not-toml.toml",
    ];
    const dir = join(FIXTURES, "config", "invalid");
    for (const file of listFiles(dir, ".toml").filter((name) => !semanticOnly.includes(name))) {
      expect(validateDraft7(parse(read(dir, file))), file).toBe(false);
    }
  });
});

describe("presets", () => {
  it("are all there", () => {
    expect(presets).toEqual(["irreversible.toml", "oss.toml", "startup.toml", "strict.toml"]);
  });

  describe.each(presets)("%s", (file) => {
    const text = read(PRESETS, file);

    it("starts with the schema directive editors read", () => {
      expect(text.split("\n")[0]).toBe(CONFIG_SCHEMA_DIRECTIVE);
    });

    it("validates against the published JSON Schema, as 2020-12 and as draft-07", () => {
      const value = parse(text);
      expect(validate(value) ? [] : validate.errors).toEqual([]);
      expect(validateDraft7(value) ? [] : validateDraft7.errors).toEqual([]);
    });

    it("parses with parseConfig", () => {
      const result = parseConfig(text);
      expect(result.ok ? [] : result.errors).toEqual([]);
    });

    it("has a test file next to it", () => {
      expect(existsSync(join(PRESETS, file.replace(/\.toml$/, ".test.toml")))).toBe(true);
    });
  });
});

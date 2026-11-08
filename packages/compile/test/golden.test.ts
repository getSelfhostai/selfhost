import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { COMPILE_VENDORS, type CompileVendor, parseConfig } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { listFiles, writeFolder } from "../src/golden.js";
import { compilePolicy, RULER_SOURCE, RULER_VERSION, VENDOR_VERSIONS } from "../src/index.js";
import { runRuler } from "../src/ruler.js";

// Golden files: fixtures/compile/<vendor>/<version>/ holds what selfhost.toml next to them
// compiles to for that vendor version, and fixtures/compile/rules/<ruler version>/ the rules
// files Ruler writes from it. A change in the output fails here until the fixtures are
// regenerated on purpose: UPDATE_GOLDEN=1 pnpm --filter @selfhost/compile test.
const ROOT = join(import.meta.dirname, "..", "..", "..", "fixtures", "compile");
const UPDATE = process.env.UPDATE_GOLDEN === "1";
const HINT = "Regenerate on purpose with UPDATE_GOLDEN=1 pnpm --filter @selfhost/compile test.";

const parsed = parseConfig(readFileSync(join(ROOT, "selfhost.toml"), "utf8"));
if (!parsed.ok) throw new Error(`fixtures/compile/selfhost.toml: ${JSON.stringify(parsed.errors)}`);
const policy = parsed.config;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function matchesFolder(dir: string, expected: Map<string, string>): void {
  if (UPDATE) {
    writeFolder(dir, expected);
    return;
  }
  const shown = relative(join(ROOT, "..", ".."), dir);
  expect(listFiles(dir).sort(), `files in ${shown}. ${HINT}`).toEqual([...expected.keys()].sort());
  for (const [name, content] of expected) {
    expect(readFileSync(join(dir, name), "utf8"), `${shown}/${name} drifted. ${HINT}`).toBe(
      content,
    );
  }
}

function expectedFiles(vendor: CompileVendor, version: string): Map<string, string> {
  const result = compilePolicy(policy, { vendors: [vendor], versions: { [vendor]: version } });
  const output = result.vendors[0];
  if (!output) throw new Error(`no output for ${vendor}`);
  const files = new Map(output.files.map((file) => [file.name, file.content]));
  files.set(
    "coverage.json",
    json({ vendor: result.coverage.vendors[0], rules: result.coverage.rules }),
  );
  files.set(
    "install.json",
    json({
      files: output.files.map(({ name, description, install }) => ({ name, description, install })),
      calls: output.calls,
    }),
  );
  return files;
}

describe.each(COMPILE_VENDORS.map((vendor) => [vendor, VENDOR_VERSIONS[vendor]] as const))(
  "%s",
  (vendor, versions) => {
    it("has one fixture folder per version in VENDOR_VERSIONS", () => {
      if (UPDATE) return;
      expect(readdirSync(join(ROOT, vendor)).sort()).toEqual([...versions].sort());
    });

    it.each([...versions])(
      `compiles fixtures/compile/selfhost.toml as in ${vendor}/%s`,
      (version) => {
        matchesFolder(join(ROOT, vendor, version), expectedFiles(vendor, version));
      },
    );
  },
);

describe("rules files", () => {
  it("uses the pinned Ruler", () => {
    const require = createRequire(import.meta.url);
    expect(require("@intellectronica/ruler/package.json").version).toBe(RULER_VERSION);
    if (!UPDATE) expect(readdirSync(join(ROOT, "rules"))).toEqual([RULER_VERSION]);
  });

  it(`writes AGENTS.md and CLAUDE.md through Ruler as in rules/${RULER_VERSION}`, async () => {
    const rules = compilePolicy(policy).rules;
    if (!rules) throw new Error("the fixture policy has rules");
    const dir = mkdtempSync(join(tmpdir(), "selfhost-golden-"));
    try {
      mkdirSync(join(dir, ".ruler"));
      writeFileSync(join(dir, RULER_SOURCE), rules.content);
      await runRuler(dir, COMPILE_VENDORS, { gitignore: false, backup: false });
      expect(listFiles(dir).sort()).toEqual([RULER_SOURCE, "AGENTS.md", "CLAUDE.md"].sort());
      // Ruler's files are kept as <name>.out: a file named CLAUDE.md is often ignored locally.
      const expected = new Map(
        listFiles(dir).map((name) => [
          name === RULER_SOURCE ? name : `${name}.out`,
          readFileSync(join(dir, name), "utf8"),
        ]),
      );
      matchesFolder(join(ROOT, "rules", RULER_VERSION), expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

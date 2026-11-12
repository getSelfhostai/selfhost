import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsup";
import { afterEach, describe, expect, it } from "vitest";
import { checkChunks, ESM_REQUIRE_BANNER } from "../tsup.config.js";

const PLAYWRIGHT = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "ee",
  "receipt",
  "src",
  "playwright.ts",
);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the server bundle's require banner", () => {
  // POST /v1/receipts loads ee/receipt, whose Playwright loader imports createRequire itself;
  // with the banner's own `import { createRequire }` in the same chunk Node refused to load it.
  it("loads a chunk that bundles a module importing createRequire", async () => {
    const dir = mkdtempSync(join(tmpdir(), "selfhost-bundle-"));
    dirs.push(dir);
    writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
    const entry = join(dir, "entry.ts");
    writeFileSync(
      entry,
      `export const load = () => import(${JSON.stringify(PLAYWRIGHT)});\nexport const req = typeof require;\n`,
    );
    const out = join(dir, "dist");
    await build({
      config: false,
      entry: [entry],
      outDir: out,
      format: "esm",
      platform: "node",
      target: "node20",
      splitting: true,
      silent: true,
      noExternal: [/.*/],
      banner: { js: ESM_REQUIRE_BANNER },
    });
    expect(() => checkChunks(out)).not.toThrow();
    const built = await import(pathToFileURL(join(out, "entry.js")).href);
    expect(built.req).toBe("function");
    const playwright = await built.load();
    expect(typeof playwright.launchBrowser).toBe("function");
  });

  it("would have caught the old banner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "selfhost-bundle-"));
    dirs.push(dir);
    writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
    const entry = join(dir, "entry.ts");
    writeFileSync(entry, `export * from ${JSON.stringify(PLAYWRIGHT)};\n`);
    const out = join(dir, "dist");
    await build({
      config: false,
      entry: [entry],
      outDir: out,
      format: "esm",
      platform: "node",
      target: "node20",
      silent: true,
      noExternal: [/.*/],
      banner: {
        js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
      },
    });
    expect(() => checkChunks(out)).toThrow();
  });
});

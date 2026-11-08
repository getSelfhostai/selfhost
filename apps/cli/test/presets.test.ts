import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_SCHEMA_DIRECTIVE, parseConfig } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import {
  buildPresetsModule,
  GENERATED_PATH,
  PACKAGE_ROOT,
  PRESETS_DIR,
} from "../scripts/presets.js";
import { PRESET_NAMES, PRESETS } from "../src/init/presets.generated.js";
import type { PolicyTestsReport } from "../src/policy/test-files.js";
import { run } from "./run.js";

const read = (name: string) => readFileSync(join(PRESETS_DIR, name), "utf8");

/** Rules each preset enforces, by what they protect. */
const IRREVERSIBLE = {
  payments: ["stripe-live", "payment-api"],
  emails: ["email-send"],
  "production data": ["prod-db", "prod-migrations", "prod-ssh"],
  publishes: ["package-publish", "release-publish", "container-push", "registry-admin"],
  infrastructure: ["infra-destroy", "infra-apply", "cloud-delete", "kubectl-prod", "prod-deploy"],
};

describe("embedded presets", () => {
  it("are the files in presets/, byte for byte", () => {
    const hint = `${GENERATED_PATH} is out of date. Run: pnpm --filter @selfhost/cli embed-presets`;
    expect(readFileSync(join(PACKAGE_ROOT, GENERATED_PATH), "utf8"), hint).toBe(
      buildPresetsModule(),
    );
    for (const name of PRESET_NAMES) expect(PRESETS[name]).toBe(read(`${name}.toml`));
  });

  it("each start with the schema directive", () => {
    for (const name of PRESET_NAMES) {
      expect(PRESETS[name].split("\n")[0]).toBe(CONFIG_SCHEMA_DIRECTIVE);
    }
  });
});

describe("preset tests", () => {
  it("pass for every preset, and cover every rule in it", async () => {
    const result = await run(["policy", "test", PRESETS_DIR, "--json"], { cwd: PRESETS_DIR });
    const report: PolicyTestsReport = JSON.parse(result.out);
    const failures = report.files.flatMap((file) => [
      ...file.errors.map((error) => `${file.path}: ${error.field}: ${error.message}`),
      ...file.cases.filter((c) => !c.passed).map((c) => `${file.path}: ${c.name}: ${c.problems}`),
    ]);
    expect(failures).toEqual([]);
    expect(result.code).toBe(0);
    expect(report.files.map((file) => file.config)).toEqual(
      PRESET_NAMES.map((name) => join(PRESETS_DIR, `${name}.toml`)),
    );
    for (const file of report.files) {
      const parsed = parseConfig(readFileSync(file.config ?? "", "utf8"));
      if (!parsed.ok) throw new Error(file.path);
      const fired = new Set(file.cases.flatMap((c) => c.actual.rules));
      const untested = parsed.config.rules.map((rule) => rule.id).filter((id) => !fired.has(id));
      expect(untested, `${file.path} has no case where these rules fire`).toEqual([]);
      const allowed = file.cases.filter((c) => c.expected.decision === "allow");
      expect(allowed.length, `${file.path} needs cases that must not fire`).toBeGreaterThan(0);
    }
  });

  it("text output names each file and the total", async () => {
    const result = await run(["policy", "test", "."], { cwd: PRESETS_DIR });
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^strict\.test\.toml \(strict\.toml\): \d+ passed$/m);
    expect(result.out).toMatch(/^PASS: (\d+) of \1 cases passed in 4 files\.$/m);
  });
});

describe("irreversible preset", () => {
  it("enforces only payments, emails, production data, publishes and infrastructure", () => {
    const result = parseConfig(read("irreversible.toml"));
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const enforced = result.config.rules.filter((rule) => rule.mode === "enforce");
    expect(enforced.map((rule) => rule.id).sort()).toEqual(
      Object.values(IRREVERSIBLE).flat().sort(),
    );
    const others = result.config.rules.filter((rule) => !enforced.includes(rule));
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((rule) => rule.mode === "observe")).toBe(true);
    const { mcp, models, packages } = result.config;
    expect([mcp.mode, models.mode, packages.mode]).toEqual(["observe", "observe", "observe"]);
  });
});

describe("every preset", () => {
  it("keeps every rule enforced or observed, never off, with a message telling the agent what to do", () => {
    for (const name of PRESET_NAMES) {
      const result = parseConfig(PRESETS[name]);
      if (!result.ok) throw new Error(name);
      for (const rule of result.config.rules) {
        expect(["enforce", "observe"], `${name} ${rule.id}`).toContain(rule.mode);
        expect(rule.message.endsWith("."), `${name} ${rule.id}`).toBe(true);
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import { formatConfigError, parseConfig, roiBaselinePeriod, validateConfig } from "../src/index.js";

describe("parseConfig", () => {
  it("applies defaults to a minimal file", () => {
    const result = parseConfig("version = 1\n");
    expect(result).toEqual({
      ok: true,
      config: {
        version: 1,
        ledger: { retention_days: 90, log_prompts: false },
        redaction: [],
        rules: [],
        review: {
          high_risk_paths: [],
          high_risk_threshold: 70,
          owners: {},
          fallback: [],
          approval_timeout_minutes: 30,
          exception_expiry_minutes: 30,
          github_logins: {},
          block_merge_on_high: false,
          revert_rate_threshold: 0.25,
          revert_window_days: 14,
          modules: {},
          module_depth: 1,
        },
        packages: {
          mode: "observe",
          allow: [],
          deny: [],
          blocked_registries: [],
          install_scripts: "ask",
        },
        mcp: { mode: "observe", allow: [] },
        models: { mode: "observe", allow: [] },
        alerts: {
          spike_factor: 10,
          spike_floor_usd: 5,
          spike_baseline_days: 14,
          forecast_warn_hours: 24,
        },
        guardrails: { mode: "enforce", disable: [], prod_connections: [], prod_credentials: [] },
        teams: {},
        integrations: {},
      },
    });
  });

  it("defaults rule mode to observe, agents to all and irreversible to false", () => {
    const result = parseConfig(`version = 1
[[rules]]
id = "r1"
match = { tool = "Bash" }
action = "ask"
message = "Check first."
`);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.config.rules[0]).toMatchObject({
      mode: "observe",
      agents: ["all"],
      irreversible: false,
    });
  });

  it("keeps explicit values over defaults", () => {
    const result = parseConfig(`version = 1
[ledger]
retention_days = 30
log_prompts = true
[alerts]
spike_factor = 3
`);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.config.ledger).toEqual({ retention_days: 30, log_prompts: true });
    expect(result.config.alerts).toMatchObject({ spike_factor: 3 });
  });

  it("checks [plans] tier names, limits and the overflow key", () => {
    const result = parseConfig(`version = 1
[plans.claude."Max 5x"]
weekly_usd = 300
[plans.codex.plus]
session_usd = 0
[plans.overflow]
key = "team-overflow"
`);
    expect(result.ok ? [] : result.errors.map((error) => [error.field, error.line])).toEqual([
      ['plans.claude["Max 5x"]', 2],
      ["plans.codex.plus.session_usd", 5],
      ["plans.overflow.monthly_cap_usd", 6],
    ]);
  });

  it("does not share default objects between calls", () => {
    const a = parseConfig("version = 1\n");
    const b = parseConfig("version = 1\n");
    if (!a.ok || !b.ok) throw new Error("expected valid");
    a.config.rules.push({} as never);
    expect(b.config.rules).toEqual([]);
  });

  it("reads [runtime] and defaults its run_mode to concurrent", () => {
    const result = parseConfig(`version = 1
[runtime]
setup = "pnpm install"
[runtime.run.dev]
command = "pnpm dev --port $SELFHOST_PORT"
default = true
[runtime.env]
API_BASE_URL = "http://localhost:\${SELFHOST_PORT}"
`);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.config.runtime).toEqual({
      setup: "pnpm install",
      run_mode: "concurrent",
      run: { dev: { command: "pnpm dev --port $SELFHOST_PORT", default: true } },
      env: { API_BASE_URL: `http://localhost:\${SELFHOST_PORT}` },
    });
    const minimal = parseConfig("version = 1\n");
    expect(minimal.ok && "runtime" in minimal.config).toBe(false);
  });

  it("reports every schema error with field and line", () => {
    const result = parseConfig(`version = 1
[ledger]
retention_days = "ninety"

[[rules]]
id = "b"
mode = "loud"
action = "nope"
match = { tool = "Bash" }
message = "m"
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      { field: "ledger.retention_days", message: "Expected integer", line: 3 },
      { field: "rules[0].mode", message: "Expected one of: observe, enforce, off", line: 7 },
      { field: "rules[0].action", message: "Expected one of: block, ask", line: 8 },
    ]);
  });

  it("locates fields in quoted keys and sub-tables", () => {
    const result = parseConfig(`version = 1

[review.owners]
"infra/**" = []
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ field: 'review.owners["infra/**"]', line: 4 });
  });

  it("accepts team overrides for the [mcp] and [models] checks", () => {
    const result = parseConfig(`version = 1
[mcp]
allow = ["github"]
[teams.platform.rules."mcp.allow"]
mode = "enforce"
[teams.platform.rules."models.allow"]
mode = "off"
`);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.config.mcp).toEqual({ mode: "observe", allow: ["github"] });
    expect(result.config.teams.platform?.rules).toEqual({
      "mcp.allow": { mode: "enforce" },
      "models.allow": { mode: "off" },
    });
  });

  it("reserves a built-in rule id only while its allow list is in use", () => {
    const rule = `[[rules]]
id = "models.allow"
match = { tool = "Bash" }
action = "ask"
message = "m"
`;
    expect(parseConfig(`version = 1\n${rule}`).ok).toBe(true);
    const result = parseConfig(`version = 1\n[models]\nallow = ["gpt-5*"]\n${rule}`);
    expect(result.ok ? [] : result.errors).toEqual([
      {
        field: "rules[0].id",
        message: 'Rule id "models.allow" is reserved for [models] allow',
        line: 5,
      },
    ]);
  });

  it("reserves rule ids that start with packages. for the package guard", () => {
    const result = parseConfig(`version = 1
[[rules]]
id = "packages.too_new"
match = { tool = "Bash" }
action = "ask"
message = "m"
`);
    expect(result.ok ? [] : result.errors).toEqual([
      {
        field: "rules[0].id",
        message:
          'Rule id "packages.too_new" is reserved: ids that start with "packages." belong to [packages]',
        line: 3,
      },
    ]);
  });

  it("reads blocked registries and the install script action in [packages]", () => {
    const result = parseConfig(`version = 1
[packages]
mode = "enforce"
min_age_days = 14
blocked_registries = ["*.example.com"]
install_scripts = "block"
`);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.config.packages).toEqual({
      mode: "enforce",
      allow: [],
      deny: [],
      min_age_days: 14,
      blocked_registries: ["*.example.com"],
      install_scripts: "block",
    });
  });

  it("reads an [roi] baseline period, and refuses half of one or one that runs backwards", () => {
    const roi = (lines: string) => parseConfig(`version = 1\n[roi]\n${lines}\n`);
    const ok = roi('baseline_from = "2026-11-02"\nbaseline_to = "2026-11-09T00:00:00Z"');
    expect(ok.ok && roiBaselinePeriod(ok.config.roi)).toEqual({
      from: new Date("2026-11-02T00:00:00.000Z"),
      to: new Date("2026-11-09T00:00:00.000Z"),
    });
    expect(roi('baseline_from = "2026-11-02"')).toMatchObject({
      ok: false,
      errors: [{ field: "roi.baseline_to", message: "Set both baseline_from and baseline_to" }],
    });
    expect(roi('baseline_from = "2026-11-09"\nbaseline_to = "2026-11-02"')).toMatchObject({
      ok: false,
      errors: [{ field: "roi.baseline_to", message: "Expected a time after baseline_from" }],
    });
    expect(roi('baseline_from = "last week"\nbaseline_to = "2026-11-02"').ok).toBe(false);
  });

  it("formats errors as file:line: field: message", () => {
    expect(
      formatConfigError({ field: "rules[0].mode", message: "Expected one of: observe", line: 7 }),
    ).toBe("selfhost.toml:7: rules[0].mode: Expected one of: observe");
    expect(formatConfigError({ field: "version", message: "Expected required property" })).toBe(
      "selfhost.toml: version: Expected required property",
    );
  });
});

describe("validateConfig", () => {
  it("validates an object without TOML", () => {
    expect(validateConfig({ version: 1, org: { name: "acme" } }).ok).toBe(true);
    const result = validateConfig({ version: 1, extra: true });
    expect(result.ok ? [] : result.errors.map((e) => e.field)).toEqual(["extra"]);
  });
});

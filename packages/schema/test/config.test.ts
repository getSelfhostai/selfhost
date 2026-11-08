import { describe, expect, it } from "vitest";
import { formatConfigError, parseConfig, validateConfig } from "../src/index.js";

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
          github_logins: {},
          block_merge_on_high: false,
        },
        packages: { mode: "observe", allow: [], deny: [] },
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

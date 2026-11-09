import { describe, expect, it } from "vitest";
import {
  checkLayer,
  composePolicy,
  type LayerResult,
  type PolicyLayer,
  parseConfig,
  withinList,
} from "../src/index.js";

const ORG = `version = 1

[[rules]]
id = "no-force-push"
mode = "enforce"
match = { tool = "Bash", command = "git push --force" }
action = "block"
message = "No force pushes."

[[rules]]
id = "drop-table"
agents = ["claude_code", "codex"]
irreversible = true
match = { tool = "Bash", command = "DROP TABLE" }
action = "ask"
message = "Ask before dropping a table."

[mcp]
mode = "enforce"
allow = ["github", "acme-*"]

[models]
allow = ["claude-opus-*"]

[packages]
mode = "enforce"
deny = ["event-stream"]
min_age_days = 7
install_scripts = "block"

[guardrails]
disable = ["guard.reset_hard"]

[[redaction]]
name = "ticket"
pattern = "TICKET-\\\\d+"

[ledger]
log_prompts = false

[budget]
monthly_usd = 5000
`;

const FORCE_PUSH = `id = "no-force-push"
match = { tool = "Bash", command = "git push --force" }
action = "block"
message = "Ours."`;

const team = (body: string) => `version = 1\n${body}\n`;

function floorErrors(result: LayerResult) {
  if (result.ok) return [];
  return result.errors.map(({ field, org_rule }) => ({ field, org_rule }));
}

describe("checkLayer: what relaxing the org floor means", () => {
  it.each([
    ["a lower rule mode", `[[rules]]\n${FORCE_PUSH}\nmode = "observe"`, "rules[0].mode"],
    ["mode off", `[[rules]]\n${FORCE_PUSH}\nmode = "off"`, "rules[0].mode"],
    [
      "ask where the org blocks",
      `[[rules]]\n${FORCE_PUSH}\nmode = "enforce"\naction = "ask"`.replace(
        'action = "block"\n',
        "",
      ),
      "rules[0].action",
    ],
    [
      "fewer agents",
      `[[rules]]\n${FORCE_PUSH}\nmode = "enforce"\nagents = ["codex"]`,
      "rules[0].agents",
    ],
    [
      "another match",
      `[[rules]]\n${FORCE_PUSH.replace("git push --force", "git push -f")}\nmode = "enforce"`,
      "rules[0].match",
    ],
  ])("refuses %s on an org rule", (_name, body, field) => {
    expect(floorErrors(checkLayer(ORG, team(body)))).toEqual([
      { field, org_rule: "no-force-push" },
    ]);
  });

  it("refuses dropping irreversible or an agent of an org rule", () => {
    const result = checkLayer(
      ORG,
      team(`[[rules]]
id = "drop-table"
agents = ["codex"]
match = { tool = "Bash", command = "DROP TABLE" }
action = "ask"
message = "x"`),
    );
    expect(floorErrors(result)).toEqual([
      { field: "rules[0].agents", org_rule: "drop-table" },
      { field: "rules[0].irreversible", org_rule: "drop-table" },
    ]);
  });

  it("refuses team overrides that relax an org rule, naming it", () => {
    const result = checkLayer(
      ORG,
      team(`[teams.platform.rules.no-force-push]
mode = "observe"
[teams.platform.rules."mcp.allow"]
mode = "off"`),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      {
        field: "teams.platform.rules.no-force-push.mode",
        org_rule: "no-force-push",
        message: 'Relaxes org rule "no-force-push": mode "observe" is below the org\'s "enforce"',
        line: 3,
      },
      {
        field: 'teams.platform.rules["mcp.allow"].mode',
        org_rule: "mcp.allow",
        message: 'Relaxes org rule "mcp.allow": mode "off" is below the org\'s "enforce"',
        line: 5,
      },
    ]);
  });

  it("refuses an allow list that widens the org's, and a lower mode", () => {
    expect(
      floorErrors(checkLayer(ORG, team('[mcp]\nallow = ["github", "slack"]\nmode = "observe"'))),
    ).toEqual([
      { field: "mcp.mode", org_rule: "[mcp] mode" },
      { field: "mcp.allow[1]", org_rule: "[mcp] allow" },
    ]);
    expect(floorErrors(checkLayer(ORG, team("[models]\nallow = []")))).toEqual([
      { field: "models.allow", org_rule: "[models] allow" },
    ]);
    expect(floorErrors(checkLayer(ORG, team('[models]\nallow = ["gpt-*"]')))).toEqual([
      { field: "models.allow[0]", org_rule: "[models] allow" },
    ]);
  });

  it("refuses softer package checks", () => {
    const result = checkLayer(
      ORG,
      team(`[packages]
mode = "observe"
allow = ["@acme/*"]
min_age_days = 1
install_scripts = "ask"`),
    );
    expect(floorErrors(result)).toEqual([
      { field: "packages.mode", org_rule: "[packages] mode" },
      { field: "packages.allow[0]", org_rule: "[packages] allow" },
      { field: "packages.min_age_days", org_rule: "[packages] min_age_days" },
      { field: "packages.install_scripts", org_rule: "[packages] install_scripts" },
    ]);
  });

  it("refuses guardrails the org keeps on, a replaced redaction and prompt logging", () => {
    const result = checkLayer(
      ORG,
      team(`[guardrails]
mode = "observe"
disable = ["guard.reset_hard", "guard.force_push"]
[[redaction]]
name = "ticket"
pattern = "T-\\\\d+"
[ledger]
log_prompts = true`),
    );
    expect(floorErrors(result)).toEqual([
      { field: "guardrails.mode", org_rule: "[guardrails] mode" },
      { field: "guardrails.disable[1]", org_rule: "guard.force_push" },
      { field: "redaction[0].pattern", org_rule: "[[redaction]] ticket" },
      { field: "ledger.log_prompts", org_rule: "[ledger] log_prompts" },
    ]);
  });

  it("lets teams add rules and tighten the org's", () => {
    const result = checkLayer(
      ORG,
      team(`[[rules]]
id = "drop-table"
mode = "enforce"
agents = ["all"]
irreversible = true
match = { tool = "Bash", command = "DROP TABLE" }
action = "block"
message = "Never drop a table here."

[[rules]]
id = "no-curl"
match = { tool = "Bash", command = "curl" }
action = "ask"
message = "Ask first."

[mcp]
allow = ["github", "acme-api"]

[models]
allow = ["claude-opus-4*"]

[packages]
deny = ["left-pad"]
min_age_days = 14

[guardrails]
disable = []
prod_connections = ["*.prod.acme.internal"]

[[redaction]]
name = "customer"
pattern = "CUST-\\\\d+"

[teams.platform.rules.no-force-push]
message = "Platform blocks force pushes."

[budget]
monthly_usd = 200`),
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("still reports the file's own errors first", () => {
    const result = checkLayer(ORG, team('[[rules]]\nid = "x"\nmatch = {}\naction = "nope"'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.every((error) => error.org_rule === undefined)).toBe(true);
    const unknown = checkLayer(ORG, team('[teams.x.rules.not-a-rule]\nmode = "enforce"'));
    expect(unknown).toMatchObject({
      ok: false,
      errors: [{ message: 'Override for unknown rule "not-a-rule"' }],
    });
  });

  it("checks only the file when there is no org policy", () => {
    expect(checkLayer(undefined, team(`[[rules]]\n${FORCE_PUSH}\nmode = "off"`)).ok).toBe(true);
  });

  it("treats an allow entry as covered when the org's list or one of its globs covers it", () => {
    expect(withinList("acme-api", ["github", "acme-*"])).toBe(true);
    expect(withinList("acme-*", ["acme-*"])).toBe(true);
    expect(withinList("acme-api-*", ["acme-*"])).toBe(true);
    expect(withinList("acme/x", ["acme-*"])).toBe(false);
    expect(withinList("slack", ["github", "acme-*"])).toBe(false);
    // Globs it cannot reason about cover only the same text.
    expect(withinList("a", ["{a,b}"])).toBe(false);
    expect(withinList("{a,b}", ["{a,b}"])).toBe(true);
  });
});

describe("composePolicy", () => {
  const org: PolicyLayer = { kind: "org", name: "acme", text: ORG };

  it("keeps a single team policy as it is", () => {
    const text = team(`[[rules]]\n${FORCE_PUSH}`);
    const composed = composePolicy([{ kind: "team", name: "platform", text }]);
    expect(composed.text).toBe(text);
    expect(composed.conflicts).toEqual([]);
  });

  it("inherits the org floor, adds team rules and joins protective lists", () => {
    const composed = composePolicy([
      org,
      {
        kind: "team",
        name: "platform",
        text: team(`[[rules]]
id = "no-curl"
match = { tool = "Bash", command = "curl" }
action = "ask"
message = "Ask first."
[packages]
deny = ["left-pad"]
[teams.platform]
members = ["ada@example.com"]
[budget]
monthly_usd = 200`),
      },
    ]);
    expect(composed.conflicts).toEqual([]);
    expect(composed.text).toMatch(
      /^#:schema .*\n# The policy in use: org acme, then team platform\./,
    );
    const { config } = composed;
    expect(config.rules.map((r) => [r.id, r.mode])).toEqual([
      ["no-force-push", "enforce"],
      ["drop-table", "observe"],
      ["no-curl", "observe"],
    ]);
    expect(config.packages.deny).toEqual(["event-stream", "left-pad"]);
    expect(config.mcp).toEqual({ mode: "enforce", allow: ["github", "acme-*"] });
    expect(config.redaction.map((r) => r.name)).toEqual(["ticket"]);
    expect(config.teams.platform?.members).toEqual(["ada@example.com"]);
    // A team's budget is its own; the org's is never inherited.
    expect(config.budget).toEqual({ monthly_usd: 200 });
    const orgOnly = composePolicy([org]);
    expect(orgOnly.config.budget).toBeUndefined();
    expect(orgOnly.config.rules).toHaveLength(2);
  });

  it("uses a team's tighter values", () => {
    const { config, conflicts } = composePolicy([
      org,
      {
        kind: "team",
        name: "platform",
        text: team(`[[rules]]
id = "drop-table"
mode = "enforce"
agents = ["all"]
irreversible = true
match = { tool = "Bash", command = "DROP TABLE" }
action = "block"
message = "Never."
[mcp]
allow = ["github"]
[packages]
min_age_days = 14`),
      },
    ]);
    expect(conflicts).toEqual([]);
    expect(config.rules[1]).toMatchObject({
      id: "drop-table",
      mode: "enforce",
      action: "block",
      agents: ["all"],
    });
    expect(config.mcp.allow).toEqual(["github"]);
    expect(config.packages.min_age_days).toBe(14);
  });

  it("keeps the org's value where a stored layer relaxes a floor raised later", () => {
    const relaxed: PolicyLayer = {
      kind: "team",
      name: "platform",
      text: team(`[[rules]]
${FORCE_PUSH}
mode = "observe"
[mcp]
allow = ["slack"]
[teams.platform.rules.no-force-push]
mode = "off"
[guardrails]
disable = ["guard.force_push"]`),
    };
    const { config, conflicts } = composePolicy([org, relaxed]);
    expect(conflicts.map((c) => [c.layer.name, c.field, c.org_rule])).toEqual([
      ["platform", "rules[0].mode", "no-force-push"],
      ["platform", "teams.platform.rules.no-force-push.mode", "no-force-push"],
      ["platform", "mcp.allow[0]", "[mcp] allow"],
      ["platform", "guardrails.disable[0]", "guard.force_push"],
    ]);
    expect(config.rules[0]).toMatchObject({
      id: "no-force-push",
      mode: "enforce",
      message: "No force pushes.",
    });
    expect(config.teams.platform?.rules["no-force-push"]).toBeUndefined();
    expect(config.mcp.allow).toEqual(["github", "acme-*"]);
    expect(config.guardrails.disable).toEqual(["guard.reset_hard"]);
  });

  it("composes org, team and repo in that order, the org floor holding for the repo", () => {
    const teamLayer: PolicyLayer = {
      kind: "team",
      name: "platform",
      text: team(`[[rules]]
id = "no-curl"
match = { tool = "Bash", command = "curl" }
action = "ask"
message = "Ask first."
[review]
fallback = ["lead@example.com"]`),
    };
    const repo: PolicyLayer = {
      kind: "repo",
      name: "acme/api",
      text: team(`[[rules]]
id = "no-curl"
mode = "enforce"
match = { tool = "Bash", command = "curl" }
action = "ask"
message = "Never in api."
[[rules]]
${FORCE_PUSH}
mode = "off"
[review]
high_risk_paths = ["migrations/**"]`),
    };
    const { config, conflicts, text } = composePolicy([org, teamLayer, repo]);
    expect(text).toMatch(/org acme, then team platform, then repo acme\/api/);
    expect(conflicts.map((c) => [c.layer.kind, c.field])).toEqual([["repo", "rules[1].mode"]]);
    expect(config.rules.map((r) => [r.id, r.mode, r.message])).toEqual([
      ["no-force-push", "enforce", "No force pushes."],
      ["drop-table", "observe", "Ask before dropping a table."],
      ["no-curl", "enforce", "Never in api."],
    ]);
    expect(config.review).toMatchObject({
      fallback: ["lead@example.com"],
      high_risk_paths: ["migrations/**"],
    });
  });

  it("drops overrides of org rules the org removed later", () => {
    const layer: PolicyLayer = {
      kind: "team",
      name: "platform",
      text: team('[teams.platform.rules.drop-table]\nmode = "enforce"'),
    };
    expect(checkLayer(ORG, layer.text).ok).toBe(true);
    const smaller = ORG.replace(/\[\[rules\]\]\nid = "drop-table"[\s\S]*?message = "[^"]*"\n/, "");
    expect(parseConfig(smaller).ok).toBe(true);
    const { config } = composePolicy([{ kind: "org", name: "acme", text: smaller }, layer]);
    expect(config.rules.map((r) => r.id)).toEqual(["no-force-push"]);
    expect(config.teams.platform?.rules).toEqual({});
  });
});

describe("review routes and auto-approve on the org floor", () => {
  const ORG_REVIEW = `version = 1
[[review.routes]]
id = "prod-db"
paths = ["db/**"]
to = ["role:admin", "dba@example.com"]
escalate_after_minutes = 30

[review.auto_approve]
enabled = true
max_risk = 10
allowed_paths = ["docs/**"]
`;
  const orgLayer: PolicyLayer = { kind: "org", name: "acme", text: ORG_REVIEW };

  it("refuses a team route that changes an org route, and a looser auto-approve", () => {
    const result = checkLayer(
      ORG_REVIEW,
      team(`[[review.routes]]
id = "prod-db"
paths = ["db/**"]
to = ["dev@example.com"]

[review.auto_approve]
dry_run = false
max_risk = 40
allowed_paths = ["docs/**", "src/**"]`),
    );
    expect(floorErrors(result)).toEqual([
      { field: "review.routes[0]", org_rule: "[[review.routes]] prod-db" },
      { field: "review.auto_approve.max_risk", org_rule: "[review.auto_approve] max_risk" },
      {
        field: "review.auto_approve.allowed_paths[1]",
        org_rule: "[review.auto_approve] allowed_paths",
      },
    ]);
  });

  it("lets a team restate an org route, add its own and tighten auto-approve", () => {
    const result = checkLayer(
      ORG_REVIEW,
      team(`[[review.routes]]
id = "prod-db"
paths = ["db/**"]
to = ["role:admin", "dba@example.com"]
escalate_after_minutes = 30

[[review.routes]]
id = "docs"
kinds = ["pr"]
paths = ["docs/**"]
to = ["writer@example.com"]

[review.auto_approve]
max_risk = 5`),
    );
    expect(result.ok).toBe(true);
  });

  it("refuses turning auto-approve on or live when the org keeps it off or in dry run", () => {
    const off = "version = 1\n[review.auto_approve]\nenabled = false\ndry_run = true\n";
    expect(
      floorErrors(checkLayer(off, team("[review.auto_approve]\nenabled = true\ndry_run = false"))),
    ).toEqual([
      { field: "review.auto_approve.enabled", org_rule: "[review.auto_approve] enabled" },
      { field: "review.auto_approve.dry_run", org_rule: "[review.auto_approve] dry_run" },
    ]);
  });

  it("puts org routes first, joins the rest by id and keeps the org's values on conflict", () => {
    const teamLayer: PolicyLayer = {
      kind: "team",
      name: "platform",
      text: team(`[[review.routes]]
id = "everything"
to = ["lead@example.com"]

[[review.routes]]
id = "prod-db"
to = ["intern@example.com"]

[review.auto_approve]
max_risk = 50
dry_run = false`),
    };
    const repo: PolicyLayer = {
      kind: "repo",
      name: "acme/api",
      text: team(`[[review.routes]]
id = "everything"
to = ["api-lead@example.com"]`),
    };
    const { config, conflicts } = composePolicy([orgLayer, teamLayer, repo]);
    expect(conflicts.map((c) => [c.layer.name, c.field])).toEqual([
      ["platform", "review.routes[1]"],
      ["platform", "review.auto_approve.max_risk"],
    ]);
    expect(config.review.routes.map((route) => [route.id, route.to])).toEqual([
      ["prod-db", ["role:admin", "dba@example.com"]],
      ["everything", ["api-lead@example.com"]],
    ]);
    expect(config.review.auto_approve).toMatchObject({
      enabled: true,
      dry_run: false,
      max_risk: 10,
      allowed_paths: ["docs/**"],
    });
  });
});

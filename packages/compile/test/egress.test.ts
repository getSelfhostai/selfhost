import {
  createValidator,
  PolicyCoverageSchema,
  parseConfig,
  type ResolvedSelfhostConfig,
} from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { compilePolicy } from "../src/index.js";

function config(text: string): ResolvedSelfhostConfig {
  const parsed = parseConfig(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.config;
}

const POLICY = config(`version = 1
[egress]
mode = "enforce"
allow = ["github.com", "*.npmjs.org", "10.0.0.0/8"]

[teams.payments.egress]
allow = ["github.com"]
`);

const claudeSettings = (result: ReturnType<typeof compilePolicy>) =>
  JSON.parse(
    result.vendors.find((v) => v.vendor === "claude_code")?.files[0]?.content ?? "{}",
  ) as Record<string, unknown>;

describe("[egress] in each agent's own controls", () => {
  it("becomes Claude Code's sandbox network allow list, locked to managed settings", () => {
    const result = compilePolicy(POLICY);
    expect(claudeSettings(result).sandbox).toEqual({
      enabled: true,
      network: {
        allowedDomains: ["github.com", "*.npmjs.org"],
        allowManagedDomainsOnly: true,
      },
    });
    const coverage = result.coverage.rules.filter((rule) => rule.rule_id === "egress.allow");
    expect(coverage.map((rule) => [rule.vendor, rule.status, rule.hook])).toEqual([
      ["claude_code", "partial", "enforce"],
      ["codex", "not_expressible", "enforce"],
      ["cursor", "not_expressible", "enforce"],
      ["copilot", "not_expressible", "none"],
    ]);
    expect(coverage[0]?.detail).toContain("not ranges such as `10.0.0.0/8`");
    expect(createValidator(PolicyCoverageSchema).validate(result.coverage).ok).toBe(true);
    expect(result.rules?.content).toContain(
      "Reach only these hosts (enforced): `github.com`, `*.npmjs.org`, `10.0.0.0/8`.",
    );
  });

  it("uses the team's own list, and writes nothing native while observed", () => {
    expect(claudeSettings(compilePolicy(POLICY, { team: "payments" })).sandbox).toEqual({
      enabled: true,
      network: { allowedDomains: ["github.com"], allowManagedDomainsOnly: true },
    });
    const observed = config('version = 1\n[egress]\nallow = ["github.com"]\n');
    expect(claudeSettings(compilePolicy(observed)).sandbox).toBeUndefined();
  });
});

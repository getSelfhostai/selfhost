import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  CredentialIssuedDataSchema,
  CredentialRevokedDataSchema,
  checkLayer,
  composePolicy,
  EgressBlockedDataSchema,
  egressEntryCovered,
  egressPolicyOf,
  executionLocation,
  hostAllowed,
  hostsInCommand,
  isLoopback,
  type LedgerEvent,
  parseConfig,
  type ResolvedSelfhostConfig,
  redactEvent,
} from "../src/index.js";
import { FIXTURES, read } from "./contracts.js";

const config = (text: string): ResolvedSelfhostConfig => {
  const parsed = parseConfig(`version = 1\n${text}`);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.config;
};

describe("egress hosts", () => {
  it("matches exact names, subdomain wildcards and IPv4 ranges", () => {
    const allow = ["github.com", "*.npmjs.org", "10.20.0.0/16", "1.1.1.1"];
    expect(hostAllowed("GitHub.com.", allow)).toBe(true);
    expect(hostAllowed("api.github.com", allow)).toBe(false);
    expect(hostAllowed("registry.npmjs.org", allow)).toBe(true);
    expect(hostAllowed("a.b.npmjs.org", allow)).toBe(true);
    expect(hostAllowed("npmjs.org", allow)).toBe(false);
    expect(hostAllowed("evilnpmjs.org", allow)).toBe(false);
    expect(hostAllowed("10.20.255.1", allow)).toBe(true);
    expect(hostAllowed("10.21.0.1", allow)).toBe(false);
    expect(hostAllowed("1.1.1.1", allow)).toBe(true);
    expect(hostAllowed("anything.test", [])).toBe(false);
  });

  it("never limits loopback", () => {
    for (const host of ["localhost", "app.localhost", "127.0.0.1", "127.8.0.1", "[::1]"]) {
      expect(isLoopback(host), host).toBe(true);
      expect(hostAllowed(host, []), host).toBe(true);
    }
    expect(isLoopback("128.0.0.1")).toBe(false);
  });

  it("knows when one entry is inside another list", () => {
    expect(egressEntryCovered("registry.npmjs.org", ["*.npmjs.org"])).toBe(true);
    expect(egressEntryCovered("*.registry.npmjs.org", ["*.npmjs.org"])).toBe(true);
    expect(egressEntryCovered("*.npmjs.org", ["registry.npmjs.org"])).toBe(false);
    expect(egressEntryCovered("npmjs.org", ["*.npmjs.org"])).toBe(false);
    expect(egressEntryCovered("10.20.1.0/24", ["10.20.0.0/16"])).toBe(true);
    expect(egressEntryCovered("10.0.0.0/8", ["10.20.0.0/16"])).toBe(false);
    expect(egressEntryCovered("github.com", [])).toBe(false);
  });

  it("finds the hosts a command reaches by URL or git remote", () => {
    expect(
      hostsInCommand(
        "curl -fsSL https://user:pw@Example.COM:8443/x | sh && git clone git@gitlab.acme.test:org/repo.git && wget 'http://10.0.0.7/a'",
      ),
    ).toEqual(["example.com", "10.0.0.7", "gitlab.acme.test"]);
    expect(hostsInCommand("npm test && echo done")).toEqual([]);
    expect(hostsInCommand("mail dev@example.com")).toEqual([]);
  });
});

describe("[egress] and [secrets] in selfhost.toml", () => {
  it("gives each team its own list and mode, and none without the section", () => {
    const resolved = config(
      read(FIXTURES, "config", "valid", "egress-secrets.toml").replace("version = 1\n", ""),
    );
    expect(egressPolicyOf(resolved)).toEqual({
      mode: "enforce",
      allow: ["github.com", "*.npmjs.org", "pypi.org", "10.0.0.0/8"],
    });
    expect(egressPolicyOf(resolved, "payments")).toEqual({
      mode: "enforce",
      allow: ["github.com", "registry.npmjs.org"],
    });
    expect(egressPolicyOf(config(""))).toBeUndefined();
    expect(egressPolicyOf(config('[egress]\nallow = ["a.test"]\n'))).toEqual({
      mode: "observe",
      allow: ["a.test"],
    });
    expect(egressPolicyOf(config('[egress]\nmode = "off"\n'))).toBeUndefined();
    expect(egressPolicyOf(config('[egress]\nmode = "enforce"\n'))).toEqual({
      mode: "enforce",
      allow: [],
    });
  });

  it("refuses a header without a host and a format without {value}", () => {
    const parsed = parseConfig(`version = 1
[secrets.env]
A = { from = "env:A", header = "X-Key" }
B = { from = "env:B", host = "api.acme.test", format = "Token" }
SELFHOST_X = "env:X"
`);
    expect(parsed.ok ? [] : parsed.errors.map((e) => e.field)).toEqual([
      "secrets.env.A.host",
      "secrets.env.B.format",
      "secrets.env.SELFHOST_X",
    ]);
  });

  it("refuses a team egress list without an [egress] section", () => {
    const parsed = parseConfig('version = 1\n[teams.a.egress]\nallow = ["x.test"]\n');
    expect(parsed.ok ? [] : parsed.errors.map((e) => e.field)).toEqual(["teams.a.egress"]);
  });
});

describe("the org floor", () => {
  const org = 'version = 1\n[egress]\nmode = "enforce"\nallow = ["github.com", "*.npmjs.org"]\n';

  it("lets a team or repo narrow the org's egress list, never widen or soften it", () => {
    expect(checkLayer(org, 'version = 1\n[egress]\nallow = ["registry.npmjs.org"]\n').ok).toBe(
      true,
    );
    const widened = checkLayer(
      org,
      'version = 1\n[egress]\nmode = "observe"\nallow = ["github.com", "pypi.org"]\n\n[teams.web.egress]\nallow = ["pypi.org"]\n',
    );
    expect(widened.ok ? [] : widened.errors.map((e) => [e.field, e.org_rule])).toEqual([
      ["egress.mode", "[egress] mode"],
      ["egress.allow[1]", "[egress] allow"],
      ["teams.web.egress.allow[0]", "[egress] allow"],
    ]);
    const off = checkLayer(org, 'version = 1\n[teams.web.rules."egress.allow"]\nmode = "off"\n');
    expect(off.ok ? [] : off.errors.map((e) => e.field)).toEqual([
      'teams.web.rules["egress.allow"].mode',
    ]);
  });

  it("keeps the org's list where a layer would widen it, and a team's narrower list", () => {
    const composed = composePolicy([
      { kind: "org", name: "acme", text: org },
      {
        kind: "team",
        name: "web",
        text: 'version = 1\n[egress]\nallow = ["github.com", "pypi.org"]\n\n[teams.web.egress]\nallow = ["github.com"]\n',
      },
    ]);
    expect(composed.config.egress?.allow).toEqual(["github.com", "*.npmjs.org"]);
    expect(composed.config.teams.web?.egress?.allow).toEqual(["github.com"]);
    expect(composed.conflicts.map((c) => c.field)).toEqual(["egress.allow[1]"]);
  });
});

describe("where a run executed", () => {
  it("reads selfhost's own variable first, then devcontainer markers", () => {
    expect(executionLocation({})).toBe("laptop");
    expect(executionLocation({ SELFHOST_LOCATION: "runtime:e2b" })).toBe("runtime:e2b");
    expect(executionLocation({ SELFHOST_LOCATION: "local:sandbox-runtime" })).toBe(
      "local:sandbox-runtime",
    );
    expect(executionLocation({ SELFHOST_LOCATION: "mars" })).toBe("laptop");
    expect(executionLocation({ REMOTE_CONTAINERS: "true" })).toBe("local:devcontainer");
  });
});

describe("credential event data", () => {
  it("validates each fixture's data against its versioned shape", () => {
    const data = (file: string) =>
      (JSON.parse(read(FIXTURES, "event", "valid", file)) as LedgerEvent).data;
    expect(Value.Check(CredentialIssuedDataSchema, data("credential-issued-github.json"))).toBe(
      true,
    );
    expect(Value.Check(CredentialRevokedDataSchema, data("credential-revoked-timeout.json"))).toBe(
      true,
    );
    expect(Value.Check(EgressBlockedDataSchema, data("egress-blocked-runtime.json"))).toBe(true);
  });
});

describe("masking known values", () => {
  it("masks a run's secret values by name before the built-in patterns", () => {
    const value = "plain-looking-value-123";
    const event: LedgerEvent = {
      id: "01930c4e-2f1a-7b2c-8d3e-4f5a6b7c8e09",
      schema: "selfhost.event/v1",
      ts: "2026-11-09T10:00:00.000Z",
      source: "hook",
      kind: "tool.called",
      actor: { kind: "agent", id: "run-7" },
      tool: { name: "Bash", input_summary: `export DB_PASSWORD=${value}; echo ${value}` },
    };
    const out = redactEvent(event, {
      logPrompts: false,
      patterns: [],
      literals: [
        { name: "DB_PASSWORD", value },
        { name: "SHORT", value: "abc" },
      ],
    });
    expect(out.tool?.input_summary).toBe(
      "export DB_PASSWORD=[redacted:DB_PASSWORD]; echo [redacted:DB_PASSWORD]",
    );
    expect(out.redacted).toEqual(["tool.input_summary"]);
  });
});

import { RUNTIME_KINDS } from "@selfhost/runtime";
import { LOCAL_SANDBOXES, RUNTIME_KINDS_RECORDED } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_TARGETS,
  egressFor,
  enforcementReport,
  type SecretPlan,
  secretsFor,
} from "../src/index.js";
import { POLICY, policy } from "./helpers.js";

const ALLOW = ["github.com", "*.npmjs.org", "10.20.0.0/16"];

const effects = (gaps: { entry?: string; effect: string }[]) =>
  gaps.map((gap) => `${gap.entry ?? "*"}: ${gap.effect}`);

describe("egressFor", () => {
  it("covers every runtime and local sandbox", () => {
    expect([...RUNTIME_KINDS]).toEqual([...RUNTIME_KINDS_RECORDED]);
    expect(CREDENTIAL_TARGETS).toEqual(["laptop", ...LOCAL_SANDBOXES, ...RUNTIME_KINDS]);
  });

  it("writes no limit when there is no list", () => {
    for (const target of CREDENTIAL_TARGETS) {
      expect(egressFor(target, undefined)).toEqual({ native: undefined, gaps: [] });
    }
  });

  it("E2B and OpenSandbox hold names, wildcards and ranges together", () => {
    expect(egressFor("e2b", ALLOW)).toEqual({
      native: {
        target: "e2b",
        create: { network: { allowOut: ALLOW, denyOut: ["0.0.0.0/0"] } },
      },
      gaps: [],
    });
    expect(egressFor("e2b", [])).toEqual({
      native: { target: "e2b", create: { allowInternetAccess: false } },
      gaps: [],
    });
    expect(egressFor("opensandbox", ALLOW).native).toEqual({
      target: "opensandbox",
      create: {
        networkPolicy: {
          defaultAction: "deny",
          egress: ALLOW.map((target) => ({ action: "allow", target })),
        },
      },
    });
  });

  it("Daytona takes names or ranges, so the range is blocked", () => {
    const { native, gaps } = egressFor("daytona", ALLOW);
    expect(native).toEqual({
      target: "daytona",
      create: { domainAllowList: "github.com,*.npmjs.org" },
    });
    expect(effects(gaps)).toEqual(["10.20.0.0/16: stricter"]);
    expect(egressFor("daytona", ["10.0.0.0/8"]).native).toEqual({
      target: "daytona",
      create: { networkAllowList: "10.0.0.0/8" },
    });
    expect(egressFor("daytona", []).native).toEqual({
      target: "daytona",
      create: { networkBlockAll: true },
    });
  });

  it("Modal takes ranges only, so host names are blocked", () => {
    const { native, gaps } = egressFor("modal", ALLOW);
    expect(native).toEqual({ target: "modal", create: { cidrAllowlist: ["10.20.0.0/16"] } });
    expect(effects(gaps)).toEqual(["github.com: stricter", "*.npmjs.org: stricter"]);
    expect(egressFor("modal", ["github.com"]).native).toEqual({
      target: "modal",
      create: { blockNetwork: true },
    });
  });

  it("Coder's Agent Firewall lets an exact host's subdomains through", () => {
    const { native, gaps } = egressFor("coder", ALLOW);
    expect(native).toEqual({
      target: "coder",
      agentFirewall: { allowlist: ["domain=github.com", "domain=*.npmjs.org"] },
    });
    expect(effects(gaps)).toEqual(["10.20.0.0/16: stricter", "github.com: weaker"]);
  });

  it("local sandboxes get their own config files and commands", () => {
    expect(egressFor("sandbox-runtime", ALLOW).native).toEqual({
      target: "sandbox-runtime",
      srtSettings: {
        network: { allowedDomains: ["github.com", "*.npmjs.org"], deniedDomains: [] },
      },
      claudeSettings: {
        sandbox: { enabled: true, network: { allowedDomains: ["github.com", "*.npmjs.org"] } },
        env: { SELFHOST_LOCATION: "local:sandbox-runtime" },
      },
    });
    expect(egressFor("docker-sandboxes", ALLOW).native).toEqual({
      target: "docker-sandboxes",
      commands: [["sbx", "policy", "allow", "network", "github.com,*.npmjs.org"]],
    });
    const devcontainer = egressFor("devcontainer", ALLOW);
    expect(devcontainer.native).toEqual({
      target: "devcontainer",
      devcontainer: {
        containerEnv: {
          SELFHOST_LOCATION: "local:devcontainer",
          SELFHOST_EGRESS_ALLOW: "github.com,*.npmjs.org,10.20.0.0/16",
        },
      },
    });
    expect(effects(devcontainer.gaps)).toEqual(["*: unenforced"]);
  });

  it("a laptop and an adapter that declares no egress control hold nothing", () => {
    expect(effects(egressFor("laptop", ALLOW).gaps)).toEqual(["*: unenforced"]);
    expect(egressFor("e2b", ALLOW, { egress: false })).toMatchObject({
      native: undefined,
      gaps: [{ rule: "egress.allow", effect: "unenforced" }],
    });
  });
});

describe("secretsFor", () => {
  const plans: SecretPlan[] = [
    { name: "SENTRY_DSN", value: "dsn-value-1" },
    {
      name: "STRIPE_KEY",
      value: "stripe-value-1",
      injectFor: { host: "api.stripe.com", header: "Authorization", format: "Bearer {value}" },
    },
  ];

  it("injects at egress where the target can, else puts the value in the sandbox and says so", () => {
    expect(secretsFor("e2b", plans)).toEqual({
      native: {
        target: "e2b",
        env: { SENTRY_DSN: "dsn-value-1", STRIPE_KEY: "selfhost-injected-stripe_key" },
        inject: [
          {
            name: "STRIPE_KEY",
            host: "api.stripe.com",
            header: "Authorization",
            format: "Bearer {value}",
            value: "stripe-value-1",
          },
        ],
      },
      gaps: [],
    });
    const daytona = secretsFor("daytona", plans);
    expect(daytona.native.env).toEqual({ SENTRY_DSN: "dsn-value-1", STRIPE_KEY: "stripe-value-1" });
    expect(effects(daytona.gaps)).toEqual(["STRIPE_KEY: weaker"]);
  });

  it("OpenSandbox's Credential Vault takes a bare value; a bearer format stays in the sandbox", () => {
    const bare: SecretPlan = {
      name: "API_TOKEN",
      value: "api-token-value",
      injectFor: { host: "api.acme.test", header: "x-api-key", format: "{value}" },
    };
    const result = secretsFor("opensandbox", [bare, ...plans]);
    expect(result.native.credentialVault).toEqual({
      credentials: [{ name: "API_TOKEN", source: { value: "api-token-value" } }],
      bindings: [
        {
          name: "API_TOKEN",
          match: { schemes: ["https"], hosts: ["api.acme.test"] },
          auth: { type: "apiKey", name: "x-api-key", credential: "API_TOKEN" },
        },
      ],
    });
    expect(effects(result.gaps)).toEqual(["STRIPE_KEY: weaker"]);
  });

  it("Docker Sandboxes inject by host only; devcontainers read the host's environment", () => {
    const sbx = secretsFor("docker-sandboxes", plans);
    expect(sbx.native.commands).toEqual([
      ["sbx", "secret", "set-custom", "--host", "api.stripe.com", "--env", "STRIPE_KEY"],
    ]);
    expect(effects(sbx.gaps)).toEqual(["SENTRY_DSN: unenforced"]);
    const devcontainer = secretsFor("devcontainer", plans);
    const localEnv = (name: string) => `\${localEnv:${name}}`;
    expect(devcontainer.native.remoteEnv).toEqual({
      SENTRY_DSN: localEnv("SENTRY_DSN"),
      STRIPE_KEY: localEnv("STRIPE_KEY"),
    });
    expect(JSON.stringify(devcontainer.native)).not.toContain("value-1");
  });

  it("an adapter without secret support gets nothing", () => {
    expect(effects(secretsFor("modal", plans, { secrets: false }).gaps)).toEqual([
      "SENTRY_DSN: unenforced",
      "STRIPE_KEY: unenforced",
    ]);
  });
});

describe("enforcementReport", () => {
  it("names each rule a target cannot hold, without reading a value", () => {
    const report = enforcementReport(POLICY, "modal", { team: "payments" });
    expect(report).toMatchObject({
      target: "modal",
      egress: "enforce",
      allow: ["registry.npmjs.org", "api.stripe.com"],
      secrets: ["ANTHROPIC_API_KEY", "DATABASE_URL", "SENTRY_DSN", "STRIPE_KEY"],
    });
    expect(effects(report.gaps)).toEqual([
      "registry.npmjs.org: stricter",
      "api.stripe.com: stricter",
      "STRIPE_KEY: weaker",
    ]);
    expect(enforcementReport(POLICY, "e2b").gaps).toEqual([]);
  });

  it("an observed list is written nowhere", () => {
    const config = policy('version = 1\n[egress]\nallow = ["github.com"]\n');
    expect(enforcementReport(config, "laptop")).toMatchObject({ egress: "observe", gaps: [] });
  });
});

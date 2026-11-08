import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composePolicy, parseConfig } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { IntegrationEditError, listIntegrations, setIntegrationTable } from "../src/index.js";

const FIXTURE = readFileSync(
  join(import.meta.dirname, "../../schema/fixtures/config/valid/integrations.toml"),
  "utf8",
);

const configOf = (text: string) => {
  const parsed = parseConfig(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.config;
};

describe("setIntegrationTable", () => {
  const POLICY = `version = 1

# Agents may not push to main.
[[rules]]
id = "no-push-main"
match = { tool = "Bash", command = "git push .* main" }
action = "block"
message = "Open a pull request."

[integrations.router]
tool = "bifrost"
# The bundled one.

# Review settings follow.
[review]
high_risk_threshold = 60
`;

  it("replaces a table in place and keeps every other line", () => {
    const next = setIntegrationTable(POLICY, "router", {
      tool: "litellm",
      url: "http://litellm:4000",
      admin_key_env: "LITELLM_MASTER_KEY",
    });
    expect(next).toBe(
      POLICY.replace(
        '[integrations.router]\ntool = "bifrost"\n# The bundled one.\n',
        '[integrations.router]\ntool = "litellm"\nurl = "http://litellm:4000"\nadmin_key_env = "LITELLM_MASTER_KEY"\n',
      ),
    );
    expect(configOf(next).integrations.router).toEqual({
      tool: "litellm",
      url: "http://litellm:4000",
      admin_key_env: "LITELLM_MASTER_KEY",
    });
  });

  it("adds a new table at the end, with inline tables for headers_env", () => {
    const next = setIntegrationTable(POLICY, "tracer", {
      tool: "datadog",
      endpoint: "https://otlp.datadoghq.com",
      headers_env: { "dd-api-key": "DD_API_KEY" },
    });
    expect(next).toBe(
      `${POLICY}\n[integrations.tracer]\ntool = "datadog"\nendpoint = "https://otlp.datadoghq.com"\nheaders_env = { dd-api-key = "DD_API_KEY" }\n`,
    );
    expect(configOf(next).review.high_risk_threshold).toBe(60);
  });

  it("removes a table with null, and leaves a file without it alone", () => {
    const next = setIntegrationTable(POLICY, "router", null);
    expect(next).not.toContain("integrations");
    expect(next).toContain("# Review settings follow.\n[review]");
    expect(setIntegrationTable(next, "router", null)).toBe(next);
  });

  it("works on the schema fixture and keeps CRLF line endings", () => {
    const crlf = FIXTURE.replaceAll("\n", "\r\n");
    const next = setIntegrationTable(crlf, "runtime", { tool: "modal" });
    expect(next).toContain('[integrations.runtime]\r\ntool = "modal"\r\n');
    expect(next.replaceAll("\r\n", "")).not.toContain("\n");
    expect(configOf(next).integrations).toMatchObject({
      router: { tool: "bifrost" },
      runtime: { tool: "modal" },
      reviewer: { tool: "pr-agent" },
    });
  });

  it("refuses tables it cannot replace line by line", () => {
    const inline = 'version = 1\n[integrations]\nrouter = { tool = "bifrost" }\n';
    expect(() => setIntegrationTable(inline, "router", { tool: "litellm" })).toThrow(
      IntegrationEditError,
    );
    const dotted = 'version = 1\n[integrations]\nrouter.tool = "bifrost"\n';
    expect(() => setIntegrationTable(dotted, "router", null)).toThrow(/dotted keys/);
    expect(() => setIntegrationTable("version = \n", "router", null)).toThrow(/not valid TOML/);
  });
});

describe("[integrations] in layers", () => {
  it("lets a team pick another tool than the org without inheriting its settings", () => {
    const org = `version = 1
[integrations.router]
tool = "litellm"
url = "http://litellm:4000"
admin_key_env = "LITELLM_MASTER_KEY"

[integrations.runtime]
tool = "e2b"
`;
    const team = 'version = 1\n[integrations.router]\ntool = "bifrost"\n';
    const { config, conflicts } = composePolicy([
      { kind: "org", name: "acme", text: org },
      { kind: "team", name: "web", text: team },
    ]);
    expect(conflicts).toEqual([]);
    expect(config.integrations).toEqual({
      router: { tool: "bifrost" },
      runtime: { tool: "e2b" },
    });
  });

  it("lists choices without checking them, with URL credentials masked", () => {
    const listed = listIntegrations(
      configOf('version = 1\n[integrations.router]\ntool = "litellm"\nurl = "http://u:p@h:4000"\n')
        .integrations,
    );
    expect(listed).toEqual({
      router: { tool: "litellm", settings: { url: "http://***@h:4000" } },
      tracer: { tool: null, settings: {} },
      runtime: { tool: null, settings: {} },
      reviewer: { tool: null, settings: {} },
    });
  });
});

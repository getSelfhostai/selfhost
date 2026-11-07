import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type LedgerEvent,
  maskSecrets,
  parseConfig,
  REDACTED,
  redactEvent,
  redactionSettings,
  validateEvent,
} from "../src/index.js";
import { FIXTURES } from "./contracts.js";

// Fake values are joined from parts so the repository carries no key-shaped string.
const fake = (...parts: string[]) => parts.join("");

const SECRETS: [string, string][] = [
  ["Anthropic key", fake("sk-ant-", "api03-", "FAKE".repeat(6))],
  ["OpenAI key", fake("sk-", "proj-", "FAKE_".repeat(6))],
  ["Stripe key", fake("sk", "_live_", "FAKE".repeat(5))],
  ["GitHub token", fake("gh", "p_", "FAKE".repeat(9))],
  ["GitHub fine-grained token", fake("github", "_pat_", "FAKE_".repeat(5))],
  ["GitLab token", fake("glpat", "-", "FAKE".repeat(5))],
  ["npm token", fake("npm", "_", "FAKE".repeat(9))],
  ["Slack token", fake("xox", "b-", "FAKE-1234567")],
  ["AWS access key id", fake("AKIA", "FAKEEXAMPLE23456")],
  ["Google API key", fake("AIza", "FAKE".repeat(8), "abc")],
  ["selfhost person token", fake("selfhost", "_pt_", "FAKE".repeat(9))],
  ["JWT", fake("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiJGQUtFIn0", ".", "FAKEsignature1")],
  ["private key", fake("-----BEGIN ", "PRIVATE KEY-----\nFAKE\n-----END ", "PRIVATE KEY-----")],
];

describe("maskSecrets", () => {
  it.each(SECRETS)("masks a bare %s", (_kind, secret) => {
    const result = maskSecrets(`before ${secret} after`);
    expect(result).toEqual({ text: `before ${REDACTED} after`, masked: true });
  });

  it("masks key assignments, auth headers, URL credentials and emails", () => {
    expect(maskSecrets("export API_KEY=abc123 && run").text).toBe(
      "export API_KEY=[redacted] && run",
    );
    expect(maskSecrets("curl -H 'Authorization: Bearer abcdefghijkl'").text).toContain(
      "Bearer [redacted]",
    );
    expect(maskSecrets("git clone https://bob:hunter22@example.com/r.git").text).toBe(
      "git clone https://[redacted]@example.com/r.git",
    );
    expect(maskSecrets("git config user.email bob@example.com").text).toBe(
      "git config user.email [redacted]",
    );
  });

  it("leaves ordinary text and git remotes alone", () => {
    for (const text of [
      "git clone git@github.com:acme/api.git",
      "npm test -- --max-workers 4",
      "max_output_tokens 12000",
      "Read src/routes/health.ts",
    ]) {
      expect(maskSecrets(text)).toEqual({ text, masked: false });
    }
  });

  it("masks [[redaction]] patterns with their name, after the built-in ones", () => {
    const patterns = [{ name: "ticket", pattern: "ACME-[0-9]{4}" }];
    expect(maskSecrets("fix ACME-1234 for bob@example.com", patterns)).toEqual({
      text: "fix [redacted:ticket] for [redacted]",
      masked: true,
    });
  });

  it("ignores empty matches of a [[redaction]] pattern", () => {
    expect(maskSecrets("abc", [{ name: "any", pattern: "x*" }])).toEqual({
      text: "abc",
      masked: false,
    });
  });

  it("changes nothing the second time", () => {
    const patterns = [{ name: "ticket", pattern: "ACME-[0-9]{4}" }];
    const text = `TOKEN=${SECRETS[0]?.[1]} ref ACME-1234 secret: ACME-9999 by bob@example.com`;
    const once = maskSecrets(text, patterns);
    expect(once.masked).toBe(true);
    expect(maskSecrets(once.text, patterns)).toEqual({ text: once.text, masked: false });
  });
});

const KEY = fake("sk-ant-", "api03-", "FAKE".repeat(6));

function toolEvent(overrides: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    id: "01930c4e-2f1a-7b2c-8d3e-000000000001",
    schema: "selfhost.event/v1",
    ts: "2026-11-07T09:30:00.000Z",
    source: "hook",
    kind: "tool.called",
    actor: { kind: "person", id: "alice@example.com", name: "Alice" },
    tool: { name: "Bash", input_summary: `curl -d ${KEY} https://example.com` },
    target: { type: "command", value: `curl -d ${KEY} https://example.com` },
    data: {
      prompt: `use ${KEY}`,
      response: "done",
      prompt_chars: 10,
      note: "mail bob@example.com",
      nested: { list: ["ok", `key ${KEY}`] },
    },
    ...overrides,
  };
}

describe("redactEvent", () => {
  it("keeps person ids under data so alerts still reach their owner", () => {
    const event = redactEvent(
      toolEvent({ data: { owner: "alice@example.com", note: "ping alice@example.com" } }),
    );
    expect(event.data).toEqual({ owner: "alice@example.com", note: "ping [redacted]" });
    expect(event.redacted).not.toContain("data.owner");
  });

  it("drops prompt and response text and masks free-text fields, listing every path", () => {
    const event = redactEvent(toolEvent());
    expect(event.tool?.input_summary).toBe("curl -d [redacted] https://example.com");
    expect(event.target?.value).toBe("curl -d [redacted] https://example.com");
    expect(event.data).toEqual({
      prompt_chars: 10,
      note: "mail [redacted]",
      nested: { list: ["ok", "key [redacted]"] },
    });
    expect(event.redacted).toEqual([
      "tool.input_summary",
      "target.value",
      "data.prompt",
      "data.response",
      "data.note",
      "data.nested.list[1]",
    ]);
    expect(validateEvent(event).ok).toBe(true);
  });

  it("keeps prompt text, masked, when prompts are logged", () => {
    const event = redactEvent(toolEvent(), { logPrompts: true, patterns: [] });
    expect(event.data?.prompt).toBe("use [redacted]");
    expect(event.data?.response).toBe("done");
    expect(event.redacted).toContain("data.prompt");
    expect(event.redacted).not.toContain("data.response");
  });

  it("keeps who did it, ids and links", () => {
    const event = redactEvent(
      toolEvent({
        kind: "decision.recorded",
        decision: { verdict: "approve", by: "bob@example.com", reason: `rotated ${KEY}` },
        links: { pr_url: "https://github.com/acme/api/pull/1" },
      }),
    );
    expect(event.actor).toEqual({ kind: "person", id: "alice@example.com", name: "Alice" });
    expect(event.decision).toEqual({
      verdict: "approve",
      by: "bob@example.com",
      reason: "rotated [redacted]",
    });
    expect(event.links).toEqual({ pr_url: "https://github.com/acme/api/pull/1" });
  });

  it("keeps earlier redacted paths without repeating them", () => {
    const once = redactEvent(toolEvent({ redacted: ["tool.input_summary"] }));
    expect(redactEvent(once)).toEqual(once);
    expect(once.redacted?.filter((path) => path === "tool.input_summary")).toHaveLength(1);
  });

  it("applies log_prompts and [[redaction]] from selfhost.toml", () => {
    const parsed = parseConfig(`version = 1
[ledger]
log_prompts = true

[[redaction]]
name = "host"
pattern = "https://example\\\\.com"
`);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const event = redactEvent(toolEvent(), redactionSettings(parsed.config));
    expect(event.tool?.input_summary).toBe("curl -d [redacted] [redacted:host]");
    expect(event.data?.prompt).toBe("use [redacted]");
  });

  it("leaves every valid event fixture valid", () => {
    const dir = join(FIXTURES, "event", "valid");
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      const event = JSON.parse(readFileSync(join(dir, file), "utf8")) as LedgerEvent;
      expect(validateEvent(redactEvent(event)).ok, file).toBe(true);
    }
  });
});

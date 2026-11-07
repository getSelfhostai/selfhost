import { type LedgerEvent, validateEvent } from "@selfhost/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { plantedValues, readPlanted } from "../../../fixtures/redaction/planted.js";
import { connect, type Database, migrate } from "../src/db.js";
import { createLedger, type Ledger, type LedgerOptions } from "../src/ledger.js";
import {
  mapClaudeCodeHook,
  mapCodexHook,
  mapCodexNotify,
  mapGatewayLog,
  mapOtelLogs,
} from "../src/sources/index.js";
import { makeEvent, readJson } from "./helpers.js";

const planted = Object.fromEntries(plantedValues().map(({ kind, value }) => [kind, value]));
const KEY = planted.anthropic_api_key ?? "";
const EMAIL = planted.email ?? "";
const SECRET_TEXT = `Use ${KEY} and mail ${EMAIL}`;

// The mappers are told to keep prompts, so only the ledger stands between them and storage.
const ctx = { ts: "2026-11-07T09:30:00.000Z", person: "dev@example.com", logPrompts: true };

let db: Database;

async function open(options: LedgerOptions = {}): Promise<Ledger> {
  db = await connect({ dataDir: "memory://" });
  await migrate(db);
  return createLedger(db, options);
}

/** Every column of every stored row, as text. */
async function storedText(): Promise<string> {
  const rows = await db.query<{ row: string }>("SELECT row_to_json(e)::text AS row FROM events e");
  return rows.map((row) => row.row).join("\n");
}

async function stored(ledger: Ledger): Promise<LedgerEvent[]> {
  return (await ledger.query({ limit: 1000 })).events;
}

function expectNoPlanted(text: string) {
  for (const { kind, value } of plantedValues()) expect(text, kind).not.toContain(value);
}

function hookPayload(vendor: "claude-code" | "codex", file: string, fields: object) {
  return { ...(readJson("hooks", vendor, file) as object), ...fields };
}

function otlpPrompt(prompt: string) {
  const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
  return {
    resourceLogs: [
      {
        resource: { attributes: [attribute("service.name", "claude-code")] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1791502885118000000",
                body: { stringValue: "claude_code.user_prompt" },
                attributes: [
                  attribute("session.id", "665bce74-4bdc-4164-8bb1-cc4246de2400"),
                  attribute("prompt.id", "bcb88634-48d1-4de2-892b-360e49853c6b"),
                  attribute("prompt", prompt),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("ledger writes with default settings", () => {
  let ledger: Ledger;

  beforeEach(async () => {
    ledger = await open();
  });

  afterEach(async () => {
    await ledger.close();
  });

  it("stores no prompt text from any mapper, even when the mapper keeps it", async () => {
    const events = [
      ...mapClaudeCodeHook(
        hookPayload("claude-code", "UserPromptSubmit.json", { prompt: SECRET_TEXT }),
        ctx,
      ),
      ...mapCodexHook(hookPayload("codex", "UserPromptSubmit.json", { prompt: SECRET_TEXT }), ctx),
      ...mapCodexNotify(
        hookPayload("codex", "notify-agent-turn-complete.json", {
          "input-messages": [SECRET_TEXT],
        }),
        ctx,
      ),
      ...mapOtelLogs(otlpPrompt(SECRET_TEXT), ctx),
    ];
    expect(events.map((event) => event.data?.prompt)).toEqual(events.map(() => SECRET_TEXT));
    await ledger.append(events);
    const rows = await stored(ledger);
    expect(rows).toHaveLength(4);
    for (const event of rows) {
      expect(event.kind).toBe("prompt.submitted");
      expect(event.data).not.toHaveProperty("prompt");
      expect(event.data?.prompt_chars).toBeGreaterThan(0);
      expect(event.redacted).toContain("data.prompt");
    }
    expect(await storedText()).not.toContain("Use ");
    expectNoPlanted(await storedText());
  });

  it("masks secrets and emails in tool calls, gateway errors and API events", async () => {
    const command = `curl -H 'x-trace: ${KEY}' https://example.com && git config user.email ${EMAIL}`;
    const events = [
      ...mapClaudeCodeHook(JSON.parse(readPlanted("event-with-secrets.json")), ctx),
      ...mapClaudeCodeHook(
        hookPayload("claude-code", "PreToolUse.json", {
          tool_name: "Bash",
          tool_input: { command },
        }),
        ctx,
      ),
      ...mapGatewayLog(
        {
          id: "req-redaction-1",
          startTime: 1791502885.118,
          endTime: 1791502886.118,
          status: "failure",
          model: "claude-opus-5-5",
          error_str: `401 invalid x-api-key ${KEY} for ${EMAIL}`,
        },
        ctx,
      ),
      JSON.parse(readPlanted("ledger-event-with-secrets.json")) as LedgerEvent,
    ];
    await ledger.append(events);
    const rows = await stored(ledger);
    expect(rows).toHaveLength(4);
    for (const event of rows) expect(validateEvent(event).ok).toBe(true);
    const tool = rows.find((event) => event.kind === "tool.called" && event.source === "hook");
    expect(tool?.tool?.input_summary).toContain("[redacted]");
    const alert = rows.find((event) => event.kind === "alert.raised");
    expect(alert?.data?.error).toBe("401 invalid x-api-key [redacted] for [redacted]");
    expect(alert?.redacted).toEqual(["data.error"]);
    const api = rows.find((event) => event.id === "01930c4e-2f1a-7b2c-8d3e-00000000f003");
    expect(api?.tool?.input_summary).toBe(
      "echo [redacted] | gh secret set ANTHROPIC_API_KEY && git config user.email [redacted]",
    );
    expect(api?.redacted).toEqual([
      "tool.input_summary",
      "target.value",
      "data.description",
      "data.prompt",
    ]);
    expect(api?.actor.id).toBe("dev@example.com");
    expectNoPlanted(await storedText());
  });
});

describe("ledger writes with settings", () => {
  let ledger: Ledger;

  afterEach(async () => {
    await ledger.close();
  });

  it("keeps prompt text, masked, when prompts are logged", async () => {
    ledger = await open({
      redaction: { logPrompts: true, patterns: [{ name: "ticket", pattern: "ACME-[0-9]+" }] },
    });
    await ledger.append(
      mapClaudeCodeHook(
        hookPayload("claude-code", "UserPromptSubmit.json", { prompt: `${SECRET_TEXT} ACME-42` }),
        ctx,
      ),
    );
    const [event] = await stored(ledger);
    expect(event?.data?.prompt).toBe("Use [redacted] and mail [redacted] [redacted:ticket]");
    expect(event?.redacted).toEqual(["data.prompt"]);
  });

  it("applies a team's stored selfhost.toml to that team's events only", async () => {
    ledger = await open();
    await ledger.teams.createTeam({ id: "platform", name: "Platform" });
    await ledger.teams.setPolicy(
      "platform",
      'version = 1\n[ledger]\nlog_prompts = true\n[[redaction]]\nname = "ticket"\npattern = "ACME-[0-9]+"\n',
    );
    const prompt = (n: number, team?: string) =>
      makeEvent(n, {
        kind: "prompt.submitted",
        ...(team ? { team } : {}),
        data: { prompt: `fix ACME-${n} with ${KEY}` },
      });
    await ledger.append([prompt(1, "platform"), prompt(2, "unknown-team"), prompt(3)]);
    const byId = new Map((await stored(ledger)).map((event) => [event.id, event]));
    expect(byId.get(prompt(1).id)?.data).toEqual({
      prompt: "fix [redacted:ticket] with [redacted]",
    });
    expect(byId.get(prompt(2).id)?.data).toEqual({});
    expect(byId.get(prompt(3).id)?.data).toEqual({});

    // A new policy applies from the next write.
    await ledger.teams.setPolicy("platform", "version = 1\n");
    await ledger.append([prompt(4, "platform")]);
    expect((await stored(ledger)).find((e) => e.id === prompt(4).id)?.data).toEqual({});
  });
});

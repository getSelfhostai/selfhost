import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { type Ledger, openLedger } from "@selfhost/ledger";
import { type EventsPage, type LedgerEvent, redactionSettings } from "@selfhost/schema";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { plantedValues, readPlanted } from "../../../fixtures/redaction/planted.js";
import { blockNetwork } from "../../cli/test/network.js";
import { createApp } from "../src/app.js";
import { serverConfig, startRetentionJob } from "../src/retention.js";
import { TOKEN } from "./helpers.js";

const REPO = join(import.meta.dirname, "..", "..", "..");
const planted = Object.fromEntries(plantedValues().map(({ kind, value }) => [kind, value]));
const PROMPT = `Deploy with ${planted.openai_api_key} and send the report to ${planted.email}`;

const schemaFixtures = (): LedgerEvent[] => {
  const dir = join(REPO, "packages", "schema", "fixtures", "event", "valid");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as LedgerEvent);
};

const otlpPrompt = () => {
  const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
  return {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1791502885118000000",
                body: { stringValue: "claude_code.user_prompt" },
                attributes: [
                  attribute("session.id", "00000000-0000-4000-8000-00000000fa1e"),
                  attribute("user.email", "dev@example.com"),
                  attribute("prompt", PROMPT),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
};

const post = (body: unknown, token = TOKEN, contentType = "application/json") => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": contentType },
  body: JSON.stringify(body),
});

describe("a server with default settings", () => {
  let dir: string;
  let ledger: Ledger;
  let app: Hono;
  const output: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "selfhost-privacy-"));
    ledger = await openLedger({ dataDir: dir, redaction: redactionSettings(serverConfig({})) });
    app = createApp({ version: "1.2.3", ledger, token: TOKEN });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts with prompts off, retention at 90 days and no [[redaction]] of its own", () => {
    const config = serverConfig({});
    expect(config.ledger).toEqual({ retention_days: 90, log_prompts: false });
    expect(redactionSettings(config)).toEqual({ logPrompts: false, patterns: [] });
  });

  it("masks and drops before writing on every route, logs nothing raw and calls out nowhere", async () => {
    const attempts = blockNetwork();
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => {
        output.push(format(...args));
      });
    }
    const job = startRetentionJob(ledger, {
      days: serverConfig({}).ledger.retention_days,
      log: (line) => output.push(line),
    });
    expect(await job.run()).toMatchObject({ deleted: 0 });
    job.stop();

    // API: the redaction fixture and the schema's valid events, as the compose check sends them.
    const secretEvent = JSON.parse(readPlanted("ledger-event-with-secrets.json")) as LedgerEvent;
    const events = [secretEvent, ...schemaFixtures()];
    const ingest = await app.request("/v1/events", post({ events }));
    expect(await ingest.json()).toEqual({ accepted: events.length, duplicates: 0 });

    // A refused batch does not echo what it carried.
    const refused = await app.request(
      "/v1/events",
      post({ events: [{ ...secretEvent, id: "not-a-uuid", data: { prompt: PROMPT } }] }),
    );
    expect(refused.status).toBe(400);
    const refusedBody = await refused.text();
    for (const { value } of plantedValues()) expect(refusedBody).not.toContain(value);

    // OTLP from the collector: the fixture logs, a prompt with secrets, and metrics.
    const otlpLogs = JSON.parse(
      readFileSync(join(REPO, "fixtures", "sources", "otel", "claude-code-logs.json"), "utf8"),
    );
    for (const body of [otlpLogs, otlpPrompt()]) {
      const response = await app.request("/v1/otlp/v1/logs", post(body));
      expect(await response.json()).toEqual({});
    }
    const metrics = await app.request("/v1/otlp/v1/metrics", post({ resourceMetrics: [] }));
    expect(metrics.status).toBe(200);

    // A team member's laptop, before and after the team turns prompt logging on.
    const created = await app.request("/v1/teams", post({ name: "Acme" }));
    const { invite } = (await created.json()) as { invite: string };
    const joined = await app.request("/v1/join", post({ invite, person: "dev@example.com" }));
    const { token } = (await joined.json()) as { token: string };
    const teamPrompt = (n: number) => ({
      id: `01930c4e-2f1a-7b2c-8d3e-00000000a00${n}`,
      schema: "selfhost.event/v1",
      ts: "2026-11-07T09:30:00.000Z",
      source: "hook",
      kind: "prompt.submitted",
      data: { prompt: PROMPT },
    });
    await app.request("/v1/events", post({ events: [teamPrompt(1)] }, token));
    const policy = await app.request("/v1/policy", {
      ...post({ text: "version = 1\n[ledger]\nlog_prompts = true\n" }, token),
      method: "PUT",
    });
    expect(policy.status).toBe(200);
    await app.request("/v1/events", post({ events: [teamPrompt(2)] }, token));

    const listed = await app.request("/v1/events?limit=1000", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const stored = ((await listed.json()) as EventsPage).events;
    const byId = new Map(stored.map((event) => [event.id, event]));
    expect(byId.get(secretEvent.id)?.tool?.input_summary).toBe(
      "echo [redacted] | gh secret set ANTHROPIC_API_KEY && git config user.email [redacted]",
    );
    expect(byId.get(secretEvent.id)?.data).not.toHaveProperty("prompt");
    const otlp = stored.find(
      (event) => event.kind === "prompt.submitted" && event.source === "otel",
    );
    expect(otlp?.data).not.toHaveProperty("prompt");
    expect(byId.get(teamPrompt(1).id)?.team).toBe("acme");
    expect(byId.get(teamPrompt(1).id)?.data).toEqual({});
    expect(byId.get(teamPrompt(2).id)?.data).toEqual({
      prompt: "Deploy with [redacted] and send the report to [redacted]",
    });

    expect(attempts).toEqual([]);
    await ledger.close();

    // Every row of every table, read straight from the database files.
    const db = await PGlite.create(dir);
    try {
      const tables = await db.query<{ name: string }>(
        "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'",
      );
      expect(tables.rows.map((table) => table.name)).toContain("events");
      const rows: string[] = [];
      for (const { name } of tables.rows) {
        const result = await db.query<{ row: string }>(
          `SELECT row_to_json(t)::text AS row FROM "${name}" t`,
        );
        rows.push(...result.rows.map((row) => row.row));
      }
      const everything = rows.join("\n");
      expect(everything).toContain(secretEvent.id);
      for (const { kind, value } of plantedValues()) {
        expect(everything, kind).not.toContain(value);
        expect(output.join("\n"), kind).not.toContain(value);
      }
    } finally {
      await db.close();
    }
  });
});

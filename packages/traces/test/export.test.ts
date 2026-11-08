import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Ledger, openLedger } from "@selfhost/ledger";
import { EVENT_SCHEMA, type LedgerEvent } from "@selfhost/schema";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ExportOptions,
  exportTraces,
  otlpSender,
  type RunExportSettings,
  runExported,
  runSpans,
  spanIdOf,
  TracerConfigError,
  type TracerSettings,
  traceIdOf,
  tracerHeaders,
  tracesUrl,
} from "../src/index.js";
import { type FakeReceiver, startReceiver } from "./receiver.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");
const brief = JSON.parse(readFileSync(join(FIXTURES, "brief", "agent-pr.json"), "utf8"));
const fixture: LedgerEvent[] = brief.inputs.run.events;
const CLAUDE = "5f0c2b1e-7d4a-4c8e-9a51-3e2d1c0b9a87";
const CODEX = "0199f2a4-6c1d-7e3b-9f20-5b8c7d6e4a31";
const PROMPT = String(fixture.find((e) => e.kind === "prompt.submitted")?.data?.prompt);
const AUTH = "Basic dGVzdC1wazp0ZXN0LXNr";

let receiver: FakeReceiver;
let ledger: Ledger;

/** One pass a moment after the last write, as the server job runs it (lag 0 for tests). */
async function pass(target: Ledger, opts: ExportOptions) {
  await new Promise((resolve) => setTimeout(resolve, 5));
  return exportTraces(target, { ...opts, now: new Date() });
}

function options(tracer: Partial<TracerSettings> = {}, extra: Partial<ExportOptions> = {}) {
  const settings: RunExportSettings = {
    tracer: {
      tool: "langfuse",
      endpoint: `${receiver.url}/api/public/otel`,
      headers_env: { Authorization: "TEST_TRACER_AUTH" },
      ...tracer,
    },
    logPrompts: false,
    patterns: [],
  };
  return {
    settingsFor: async () => settings,
    sender: (t: TracerSettings) => otlpSender(t, { env: { TEST_TRACER_AUTH: AUTH } }),
    lagMs: 0,
    ...extra,
  } satisfies ExportOptions;
}

let n = 0;
const event = (fields: Partial<LedgerEvent> & Pick<LedgerEvent, "kind" | "ts">): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: EVENT_SCHEMA,
  source: "hook",
  actor: { kind: "person", id: "dev@example.com" },
  agent: { vendor: "claude_code" },
  ...fields,
});

beforeEach(async () => {
  receiver = await startReceiver();
  ledger = await openLedger({ dataDir: "memory://" });
  await ledger.append(fixture);
});

afterEach(async () => {
  await ledger.close();
  await receiver.close();
});

afterAll(() => {
  delete process.env.TEST_TRACER_AUTH;
});

describe("exportTraces to a local OTLP receiver", () => {
  it("sends each finished run as one trace over OTLP/HTTP protobuf", async () => {
    const result = await pass(ledger, options());
    expect(result.failed).toEqual([]);
    expect(result.sent.map((r) => r.run).sort()).toEqual([CODEX, CLAUDE].sort());
    expect(receiver.requests).toHaveLength(2);
    for (const request of receiver.requests) {
      expect(request.path).toBe("/api/public/otel/v1/traces");
      expect(request.contentType).toBe("application/x-protobuf");
      expect(request.headers.authorization).toBe(AUTH);
      expect(request.resource["service.name"]).toBe("selfhost");
    }

    const claude = receiver.requests
      .flatMap((r) => r.spans)
      .filter((s) => s.traceId === traceIdOf(CLAUDE));
    const expected = runSpans(
      CLAUDE,
      fixture.filter((e) => e.session_id === CLAUDE),
      { logPrompts: false, root: true, now: new Date(), tool: "langfuse" },
    );
    expect(claude.map((s) => s.spanId).sort()).toEqual(expected.map((s) => s.spanId).sort());
    const root = claude.find((s) => s.spanId === spanIdOf(CLAUDE, "root"));
    expect(root).toMatchObject({ name: "invoke_agent claude_code", parentSpanId: "" });
    expect(root?.startNanos).toBe(BigInt(Date.parse("2026-10-12T09:00:00Z")) * 1_000_000n);
    expect(root?.endNanos).toBe(BigInt(Date.parse("2026-10-12T09:18:00Z")) * 1_000_000n);
    expect(root?.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "claude_code",
      "gen_ai.conversation.id": CLAUDE,
      "langfuse.observation.type": "agent",
    });

    const chat = claude.find((s) => s.name.startsWith("chat "));
    expect(chat?.kind).toBe(3); // SPAN_KIND_CLIENT
    expect(chat?.parentSpanId).toBe(spanIdOf(CLAUDE, "root"));
    expect(chat?.attributes).toMatchObject({ "gen_ai.operation.name": "chat" });
    expect(chat?.attributes["gen_ai.usage.input_tokens"]).toBeTypeOf("number");
    expect(chat?.attributes["gen_ai.usage.cost"]).toBeTypeOf("number");

    const failed = claude.find((s) => s.attributes["gen_ai.tool.call.id"] === "toolu_05");
    expect(failed?.status).toEqual({ code: 2, message: "AssertionError: expected 429 to be 200" });

    // No prompt text by default: not in any attribute, not anywhere in the bytes sent.
    for (const request of receiver.requests) {
      expect(request.raw.toString("utf8")).not.toContain(PROMPT);
    }
    expect(claude.some((s) => "gen_ai.input.messages" in s.attributes)).toBe(false);
    expect(await runExported(ledger, CLAUDE)).toBe(true);
  });

  it("sends prompt text only when the ledger kept it and log_prompts is on", async () => {
    const keeping = await openLedger({
      dataDir: "memory://",
      redaction: { logPrompts: true, patterns: [] },
    });
    try {
      await keeping.append(fixture);
      const opts = options();
      const off = (await opts.settingsFor(null)) as RunExportSettings;
      const dry = await pass(keeping, { ...opts, dryRun: true });
      expect(JSON.stringify(dry.sent)).not.toContain(PROMPT);
      await pass(keeping, { ...opts, settingsFor: async () => ({ ...off, logPrompts: true }) });
      const all = receiver.requests.map((r) => r.raw.toString("utf8")).join("");
      expect(all).toContain(PROMPT);
    } finally {
      await keeping.close();
    }
  });

  it("sends nothing twice, and a late event as one more span of the same trace", async () => {
    await pass(ledger, options());
    const first = receiver.requests.length;
    const again = await pass(ledger, options());
    expect(again.sent).toEqual([]);
    expect(receiver.requests).toHaveLength(first);

    await ledger.append([
      event({
        kind: "pr.merged",
        source: "github",
        ts: "2026-10-13T10:00:00.000Z",
        session_id: CLAUDE,
        links: { pr_url: "https://github.com/acme/acme-api/pull/142" },
      }),
    ]);
    const late = await pass(ledger, options());
    expect(late.sent.map((r) => r.run)).toEqual([CLAUDE]);
    const spans = receiver.requests.slice(first).flatMap((r) => r.spans);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      name: "pr.merged",
      traceId: traceIdOf(CLAUDE),
      parentSpanId: spanIdOf(CLAUDE, "root"),
    });
    expect(spans[0]?.attributes["selfhost.pr.url"]).toBe(
      "https://github.com/acme/acme-api/pull/142",
    );
  });

  it("keeps a run the tracer refused and sends it on the next pass", async () => {
    receiver.failNext(400, 400);
    const refused = await pass(ledger, options());
    expect(refused.failed.map((f) => f.run).sort()).toEqual([CODEX, CLAUDE].sort());
    expect(await runExported(ledger, CLAUDE)).toBe(false);
    const retried = await pass(ledger, options());
    expect(retried.failed).toEqual([]);
    expect(retried.sent.map((r) => r.run).sort()).toEqual([CODEX, CLAUDE].sort());
    expect(await runExported(ledger, CLAUDE)).toBe(true);
  });

  it("waits for a run that is still going, then sends it once it ends", async () => {
    const now = new Date();
    const live = "live-session";
    await ledger.append([
      event({
        kind: "session.started",
        ts: new Date(now.getTime() - 60_000).toISOString(),
        session_id: live,
      }),
      event({
        kind: "tool.called",
        ts: new Date(now.getTime() - 30_000).toISOString(),
        session_id: live,
        tool: { name: "Read", input_summary: "src/app.ts" },
      }),
    ]);
    const first = await pass(ledger, options());
    expect(first.pending).toEqual([live]);
    expect(first.sent.map((r) => r.run)).not.toContain(live);

    await ledger.append([
      event({ kind: "session.ended", ts: now.toISOString(), session_id: live }),
    ]);
    const second = await pass(ledger, options());
    expect(second.sent.map((r) => r.run)).toEqual([live]);
    const names = receiver.requests
      .at(-1)
      ?.spans.map((s) => s.name)
      .sort();
    expect(names).toEqual(["execute_tool Read", "invoke_agent claude_code"]);
  });

  it("skips runs whose team has no tracer, and writes nothing on a dry run", async () => {
    const skipped = await pass(ledger, { ...options(), settingsFor: async () => undefined });
    expect(skipped.skipped.sort()).toEqual([CODEX, CLAUDE].sort());

    const fresh = await openLedger({ dataDir: "memory://" });
    try {
      await fresh.append(fixture);
      const dry = await pass(fresh, { ...options(), dryRun: true });
      expect(dry.sent).toHaveLength(2);
      expect(dry.sent.every((r) => r.spans.length > 0)).toBe(true);
      expect(await runExported(fresh, CLAUDE)).toBe(false);
      expect(receiver.requests).toEqual([]);
    } finally {
      await fresh.close();
    }
  });

  it("adds Datadog's LLM Observability header and resource attribute", async () => {
    await pass(
      ledger,
      options({ tool: "datadog", endpoint: `${receiver.url}/v1/traces`, headers_env: {} }),
    );
    const [request] = receiver.requests;
    expect(request?.path).toBe("/v1/traces");
    expect(request?.headers["dd-otlp-source"]).toBe("llmobs");
    expect(request?.headers["dd-llmobs-enabled"]).toBe("true");
    expect(request?.resource.dd_llmobs_enabled).toBe(true);
  });

  it("refuses to send without the header variables, naming them and no value", async () => {
    const result = await pass(ledger, {
      ...options(),
      sender: (t) => otlpSender(t, { env: {} }),
    });
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0]?.error).toContain("TEST_TRACER_AUTH (header Authorization)");
    expect(() =>
      tracerHeaders({ tool: "otlp", endpoint: "http://x", headers_env: { a: "MISSING" } }, {}),
    ).toThrow(TracerConfigError);
  });
});

describe("tracesUrl", () => {
  it("appends /v1/traces unless the endpoint already ends in it", () => {
    expect(tracesUrl("https://cloud.langfuse.com/api/public/otel")).toBe(
      "https://cloud.langfuse.com/api/public/otel/v1/traces",
    );
    expect(tracesUrl("http://localhost:6006/")).toBe("http://localhost:6006/v1/traces");
    expect(tracesUrl("https://otlp.example.com/v1/traces")).toBe(
      "https://otlp.example.com/v1/traces",
    );
  });
});

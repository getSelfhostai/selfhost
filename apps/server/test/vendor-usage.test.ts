import { anthropicImporter, cursorImporter } from "@selfhost/importers";
import { databaseOf, type Ledger, openLedger } from "@selfhost/ledger";
import {
  type BreakEvenResponse,
  BreakEvenResponseSchema,
  createValidator,
  type LedgerEvent,
  type UsageResponse,
  type VendorImportsResponse,
  VendorImportsResponseSchema,
} from "@selfhost/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { importVendorNow, vendorImportersFromEnv } from "../src/vendor-usage.js";
import { caller, TOKEN } from "./helpers.js";

/**
 * Vendor usage imports against fake admin APIs: what lands in the ledger, where each run starts,
 * the status of a key without access, and how /v1/usage and the break-even count a day that a
 * laptop's logs also reported.
 */

const NOW = new Date("2026-11-12T08:00:00.000Z");
const now = () => NOW;

interface Call {
  url: URL;
}

/** Claude Code Analytics with one record per person per day, for the days in `spend` (cents). */
function anthropicFake(spend: Record<string, Record<string, number>>) {
  const calls: Call[] = [];
  const send = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push({ url });
    const day = url.searchParams.get("starting_at") ?? "";
    const data = Object.entries(spend[day] ?? {}).map(([email, cents]) => ({
      date: `${day}T00:00:00Z`,
      actor: { type: "user_actor", email_address: email },
      customer_type: "api",
      core_metrics: { num_sessions: 1, lines_of_code: { added: 10, removed: 1 } },
      model_breakdown: [
        {
          model: "claude-sonnet-4-5",
          tokens: { input: 1000, output: 100, cache_read: 0, cache_creation: 0 },
          estimated_cost: { currency: "USD", amount: cents },
        },
      ],
    }));
    return Response.json({ data, has_more: false, next_page: null });
  }) as typeof fetch;
  return { send, calls };
}

let ledger: Ledger;

beforeEach(async () => {
  ledger = await openLedger({ dataDir: "memory://" });
  const created = await ledger.teams.createTeam({ id: "web", name: "Web" });
  if (!created) throw new Error("team");
  await ledger.teams.join(created.invite, { id: "Ada@example.com" });
});

afterEach(async () => {
  await ledger.close();
});

async function vendorEvents(): Promise<LedgerEvent[]> {
  const page = await ledger.query({ kind: "cost.recorded", limit: 1000 });
  return page.events.filter((event) => event.source === "vendor_api");
}

describe("vendor usage import", () => {
  it("imports the closed days of the last 30, maps emails to people, and moves on", async () => {
    const { send, calls } = anthropicFake({
      "2026-11-10": { "ada@example.com": 1250, "zed@example.com": 300 },
      "2026-10-13": { "ada@example.com": 100 },
    });
    const importer = anthropicImporter({ adminKey: "sk-ant-admin01-secret", fetch: send });
    const row = await importVendorNow(ledger, importer, now);
    // 08:00 on the 12th: the 11th ended 8 hours ago, more than the settle time.
    expect(row).toMatchObject({ state: "ok", through_day: "2026-11-11", events: 3 });
    expect(row.detail).toContain("30 days through 2026-11-11, 2 people");
    expect(row.detail).toContain("1 not on this server");
    const days = calls.map((call) => call.url.searchParams.get("starting_at"));
    expect(days[0]).toBe("2026-10-13");
    expect(days.at(-1)).toBe("2026-11-11");
    expect(days).toHaveLength(30);

    const events = await vendorEvents();
    const ada = events.find(
      (e) => e.ts.startsWith("2026-11-10") && e.actor.id !== "zed@example.com",
    );
    expect(ada).toMatchObject({
      actor: { kind: "person", id: "Ada@example.com" },
      team: "web",
      cost: { usd: 12.5, estimated: true },
      data: { rollup: "day", vendor_api: "anthropic", lines_added: 10 },
    });
    const zed = events.find((e) => e.actor.id === "zed@example.com");
    expect(zed?.team).toBeUndefined();

    // The next run starts after the 11th: nothing to read until the 12th has settled.
    calls.length = 0;
    expect(await importVendorNow(ledger, importer, now)).toMatchObject({
      through_day: "2026-11-11",
    });
    expect(calls).toHaveLength(0);
    const later = () => new Date("2026-11-13T04:00:00.000Z");
    expect(await importVendorNow(ledger, importer, later)).toMatchObject({
      state: "ok",
      through_day: "2026-11-12",
      events: 0,
    });
    expect(calls.map((call) => call.url.searchParams.get("starting_at"))).toEqual(["2026-11-12"]);
  });

  it("stores nothing new when the same days are read again", async () => {
    const { send } = anthropicFake({ "2026-11-10": { "ada@example.com": 500 } });
    const importer = anthropicImporter({ adminKey: "k", fetch: send });
    await importVendorNow(ledger, importer, now);
    await databaseOf(ledger).query("DELETE FROM vendor_imports");
    expect(await importVendorNow(ledger, importer, now)).toMatchObject({ state: "ok", events: 0 });
    expect(await vendorEvents()).toHaveLength(1);
  });

  it("shows a key without access as not available, keeps its place, and never shows the key", async () => {
    const send = (async () =>
      Response.json({ error: "Forbidden" }, { status: 403 })) as unknown as typeof fetch;
    const app = createApp({
      version: "1",
      ledger,
      token: TOKEN,
      now,
      vendorImporters: [cursorImporter({ adminKey: "key_cursor_secret", fetch: send })],
    });
    const call = caller(app, TOKEN);
    const before = (await (await call("/v1/vendor-imports")).json()) as VendorImportsResponse;
    expect(before.importers).toEqual([
      expect.objectContaining({ importer: "cursor", state: "pending", through_day: null }),
    ]);
    const res = await call("/v1/vendor-imports/run", "POST");
    expect(res.status).toBe(200);
    const body = (await res.json()) as VendorImportsResponse;
    expect(createValidator(VendorImportsResponseSchema).validate(body).ok).toBe(true);
    expect(body.importers[0]).toMatchObject({
      importer: "cursor",
      state: "not_available",
      through_day: null,
    });
    expect(body.importers[0]?.detail).toContain("403");
    expect(JSON.stringify(body)).not.toContain("key_cursor_secret");
    expect(await vendorEvents()).toHaveLength(0);
  });

  it("builds importers only for the keys set", () => {
    expect(vendorImportersFromEnv({}).map((i) => i.id)).toEqual([]);
    expect(
      vendorImportersFromEnv({
        SELFHOST_ANTHROPIC_ADMIN_KEY: "a",
        SELFHOST_OPENAI_ADMIN_KEY: " ",
        SELFHOST_CURSOR_ADMIN_KEY: "c",
      }).map((i) => i.id),
    ).toEqual(["anthropic", "cursor"]);
  });
});

describe("vendor-reported spend in the usage views", () => {
  const local = (usd: number, ts: string): LedgerEvent => ({
    id: `01930c4e-2f1a-7b2c-9d3e-${Math.round(usd * 100)
      .toString(16)
      .padStart(12, "0")}`,
    schema: "selfhost.event/v1",
    ts,
    source: "local_log",
    kind: "cost.recorded",
    actor: { kind: "person", id: "Ada@example.com" },
    agent: { vendor: "claude_code" },
    model: "claude-sonnet-4-5",
    session_id: "s1",
    cost: {
      input_tokens: 10,
      output_tokens: 10,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      usd,
      estimated: true,
    },
  });

  it("counts a person-day once: from the logs where they reported it, else from the vendor", async () => {
    // Vendor: 40 on the 9th, 300 on the 10th. Logs: 7 on the 10th only.
    const { send } = anthropicFake({
      "2026-11-09": { "ada@example.com": 4000 },
      "2026-11-10": { "ada@example.com": 30000 },
    });
    await importVendorNow(ledger, anthropicImporter({ adminKey: "k", fetch: send }), now);
    await ledger.append([local(7, "2026-11-10T15:00:00.000Z")], { team: "web" });

    const app = createApp({ version: "1", ledger, token: TOKEN, now });
    const call = caller(app, TOKEN);
    const range = "from=2026-10-13T00:00:00.000Z&to=2026-11-12T00:00:00.000Z";
    const usage = (await (await call(`/v1/usage?${range}&group_by=day`)).json()) as UsageResponse;
    expect(usage.rows.map((row) => [row.group.day, row.usd])).toEqual([
      ["2026-11-09", 40],
      ["2026-11-10", 7],
    ]);
    expect(usage.total.usd).toBe(47);

    const res = await call(`/v1/usage/break-even?${range}`);
    expect(res.status).toBe(200);
    const report = (await res.json()) as BreakEvenResponse;
    expect(createValidator(BreakEvenResponseSchema).validate(report).ok).toBe(true);
    expect(report).toMatchObject({ days: 30, prices_as_of: expect.any(String) });
    expect(report.rows).toEqual([
      expect.objectContaining({
        person: "Ada@example.com",
        agent: "claude_code",
        api_usd: 47,
        monthly_api_usd: 47,
        verdict: "seat",
        tier: "pro",
        seat_usd: 20,
        saving_usd: 27,
      }),
    ]);
  });
});

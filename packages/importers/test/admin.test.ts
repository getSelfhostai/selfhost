import { validateEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import {
  anthropicImporter,
  cursorImporter,
  openAiImporter,
  readVendorEvents,
  VendorApiError,
  VendorNotAvailableError,
} from "../src/index.js";

/** A fake vendor: answers from `route`, records each request, and never touches the network. */
function fakeFetch(route: (url: URL, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const send = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const { status = 200, body } = route(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { send, calls };
}

const ANTHROPIC_DAY = {
  "2026-11-10": [
    {
      date: "2026-11-10T00:00:00Z",
      actor: { type: "user_actor", email_address: "Ada@Example.com" },
      organization_id: "org",
      customer_type: "api",
      terminal_type: "vscode",
      subscription_type: null,
      is_remote: false,
      core_metrics: {
        num_sessions: 3,
        lines_of_code: { added: 120, removed: 20 },
        commits_by_claude_code: 2,
        pull_requests_by_claude_code: 1,
      },
      model_breakdown: [
        {
          model: "claude-sonnet-4-5",
          tokens: { input: 1000, output: 500, cache_read: 4000, cache_creation: 200 },
          estimated_cost: { currency: "USD", amount: 250 },
        },
        {
          model: "claude-opus-4-1",
          tokens: { input: 100, output: 50, cache_read: 0, cache_creation: 0 },
          estimated_cost: { currency: "USD", amount: 75 },
        },
      ],
    },
    {
      date: "2026-11-10T00:00:00Z",
      actor: { type: "user_actor", email_address: "ada@example.com" },
      terminal_type: "iTerm.app",
      core_metrics: { num_sessions: 1, lines_of_code: { added: 5, removed: 0 } },
      model_breakdown: [
        {
          model: "claude-sonnet-4-5",
          tokens: { input: 10, output: 5, cache_read: 0, cache_creation: 0 },
          estimated_cost: { currency: "USD", amount: 50 },
        },
      ],
    },
    {
      date: "2026-11-10T00:00:00Z",
      actor: { type: "api_actor", api_key_name: "gateway" },
      model_breakdown: [
        {
          model: "claude-sonnet-4-5",
          tokens: { input: 9, output: 9, cache_read: 0, cache_creation: 0 },
          estimated_cost: { currency: "USD", amount: 9999 },
        },
      ],
    },
  ],
  "2026-11-11": [],
} as Record<string, unknown[]>;

describe("Anthropic Claude Code Analytics importer", () => {
  const fake = () =>
    fakeFetch((url) => {
      const day = url.searchParams.get("starting_at") ?? "";
      const records = ANTHROPIC_DAY[day] ?? [];
      // Two pages: the first record, then the rest.
      if (!url.searchParams.get("page")) {
        return {
          body: { data: records.slice(0, 1), has_more: records.length > 1, next_page: "p2" },
        };
      }
      return { body: { data: records.slice(1), has_more: false, next_page: null } };
    });

  it("adds up a person's records per model, in dollars, and leaves out API keys", async () => {
    const { send, calls } = fake();
    const importer = anthropicImporter({ adminKey: "sk-ant-admin01-secret", fetch: send });
    const read = await importer.read("2026-11-10", "2026-11-11");
    expect(read.skipped).toEqual({ api_key: 1 });
    expect(read.usage).toEqual([
      {
        day: "2026-11-10",
        email: "ada@example.com",
        agent: "claude_code",
        model: "claude-opus-4-1",
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        usd: 0.75,
        estimated: true,
        extra: { sessions: 4, lines_added: 125, lines_removed: 20, commits: 2, pull_requests: 1 },
      },
      {
        day: "2026-11-10",
        email: "ada@example.com",
        agent: "claude_code",
        model: "claude-sonnet-4-5",
        input_tokens: 1010,
        output_tokens: 505,
        cache_read_tokens: 4000,
        cache_write_tokens: 200,
        usd: 3,
        estimated: true,
      },
    ]);
    const urls = calls.map(({ url }) => `${url.pathname}?${url.searchParams}`);
    expect(urls).toEqual([
      "/v1/organizations/usage_report/claude_code?starting_at=2026-11-10&limit=1000",
      "/v1/organizations/usage_report/claude_code?starting_at=2026-11-10&limit=1000&page=p2",
      "/v1/organizations/usage_report/claude_code?starting_at=2026-11-11&limit=1000",
    ]);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-admin01-secret");
    expect(headers["anthropic-version"]).toBeDefined();
  });

  it("maps to vendor-reported cost events with stable ids", async () => {
    const importer = anthropicImporter({ adminKey: "k", fetch: fake().send });
    const people = (email: string) =>
      email === "ada@example.com" ? { id: "Ada@example.com", team: "web" } : undefined;
    const first = await readVendorEvents(importer, "2026-11-10", "2026-11-10", people);
    const again = await readVendorEvents(importer, "2026-11-10", "2026-11-10", people);
    expect(first.events.map((e) => e.id)).toEqual(again.events.map((e) => e.id));
    expect(first).toMatchObject({ people: 1, unmatched: 0 });
    for (const event of first.events) {
      expect(validateEvent(event).ok).toBe(true);
      expect(event).toMatchObject({
        source: "vendor_api",
        kind: "cost.recorded",
        ts: "2026-11-10T00:00:00.000Z",
        actor: { kind: "person", id: "Ada@example.com" },
        team: "web",
        agent: { vendor: "claude_code" },
        data: { vendor_api: "anthropic", rollup: "day", vendor_reported: true },
      });
      expect(event.session_id).toBeUndefined();
    }
    expect(first.events.reduce((sum, e) => sum + (e.cost?.usd ?? 0), 0)).toBeCloseTo(3.75);
  });

  it("reports a key without admin access as not available", async () => {
    const { send } = fakeFetch(() => ({ status: 403, body: { error: { type: "permission" } } }));
    const importer = anthropicImporter({ adminKey: "k", fetch: send });
    await expect(importer.read("2026-11-10", "2026-11-10")).rejects.toBeInstanceOf(
      VendorNotAvailableError,
    );
  });

  it("reports other failures without the key", async () => {
    const { send } = fakeFetch(() => ({ status: 500, body: { error: "boom" } }));
    const importer = anthropicImporter({ adminKey: "sk-ant-admin01-secret", fetch: send });
    const error = await importer.read("2026-11-10", "2026-11-10").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VendorApiError);
    expect(String((error as Error).message)).not.toContain("secret");
  });
});

describe("OpenAI usage importer", () => {
  const route = (url: URL) => {
    if (url.pathname === "/v1/organization/users") {
      const after = url.searchParams.get("after");
      return after
        ? {
            body: {
              object: "list",
              data: [{ object: "organization.user", id: "user-ben", email: "Ben@example.com" }],
              has_more: false,
              last_id: "user-ben",
            },
          }
        : {
            body: {
              object: "list",
              data: [{ object: "organization.user", id: "user-ada", email: "ada@example.com" }],
              has_more: true,
              last_id: "user-ada",
            },
          };
    }
    const result = (overrides: Record<string, unknown>) => ({
      object: "organization.usage.completions.result",
      input_tokens: 1_000_000,
      input_cached_tokens: 400_000,
      output_tokens: 100_000,
      num_model_requests: 10,
      model: "gpt-5",
      ...overrides,
    });
    return {
      body: {
        object: "page",
        data: [
          {
            object: "bucket",
            start_time: Date.parse("2026-11-10T00:00:00Z") / 1000,
            end_time: Date.parse("2026-11-11T00:00:00Z") / 1000,
            results: [
              result({ user_id: "user-ada", api_key_id: "key-ada" }),
              result({ user_id: "user-ada", api_key_id: "key-gateway" }),
              result({ user_id: "user-ben", api_key_id: "key-ben", model: "no-such-model" }),
              result({ user_id: null, api_key_id: "key-project" }),
            ],
          },
        ],
        has_more: false,
        next_page: null,
      },
    };
  };

  it("reads usage by user, skips the gateway's keys, and prices tokens", async () => {
    const { send, calls } = fakeFetch(route);
    const importer = openAiImporter({
      adminKey: "sk-admin-secret",
      skipKeyIds: ["key-gateway"],
      fetch: send,
    });
    const read = await importer.read("2026-11-10", "2026-11-10");
    expect(read.skipped).toEqual({ gateway_key: 1, no_person: 1 });
    const ada = read.usage.find((row) => row.email === "ada@example.com");
    expect(ada).toMatchObject({
      day: "2026-11-10",
      agent: "codex",
      model: "gpt-5",
      input_tokens: 600_000,
      cache_read_tokens: 400_000,
      output_tokens: 100_000,
      estimated: true,
      extra: { requests: 10 },
    });
    expect(ada?.usd).toBeGreaterThan(0);
    expect(read.usage.find((row) => row.email === "ben@example.com")).toMatchObject({
      usd: 0,
      extra: { unpriced: true },
    });
    const usage = calls.find((call) => call.url.pathname.endsWith("/completions"));
    expect(usage?.url.searchParams.getAll("group_by")).toEqual(["user_id", "model", "api_key_id"]);
    expect(usage?.url.searchParams.get("start_time")).toBe(
      String(Date.parse("2026-11-10T00:00:00Z") / 1000),
    );
    expect(usage?.url.searchParams.get("end_time")).toBe(
      String(Date.parse("2026-11-11T00:00:00Z") / 1000),
    );
    expect(((usage?.init.headers ?? {}) as Record<string, string>).authorization).toBe(
      "Bearer sk-admin-secret",
    );
  });
});

describe("Cursor usage importer", () => {
  const at = (iso: string) => String(Date.parse(iso));
  const usageEvent = (overrides: Record<string, unknown>) => ({
    timestamp: at("2026-11-10T15:00:00Z"),
    userEmail: "ada@example.com",
    model: "claude-4.5-sonnet",
    kind: "Included in Business",
    isTokenBasedCall: true,
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheWriteTokens: 10,
      cacheReadTokens: 1000,
      totalCents: 12.5,
    },
    chargedCents: 0,
    ...overrides,
  });

  it("adds up usage events per person, day and model at API rates, across pages", async () => {
    const pages: Record<number, unknown> = {
      1: {
        usageEvents: [
          usageEvent({}),
          usageEvent({ chargedCents: 20, tokenUsage: { totalCents: 20 } }),
        ],
        pagination: { hasNextPage: true, currentPage: 1 },
      },
      2: {
        usageEvents: [usageEvent({ timestamp: at("2026-11-11T01:00:00Z") })],
        pagination: { hasNextPage: false, currentPage: 2 },
      },
    };
    const { send, calls } = fakeFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { page: number };
      return { body: pages[body.page] };
    });
    const importer = cursorImporter({ adminKey: "key_secret", fetch: send });
    const read = await importer.read("2026-11-10", "2026-11-11");
    expect(read.usage).toEqual([
      {
        day: "2026-11-10",
        email: "ada@example.com",
        agent: "cursor",
        model: "claude-4.5-sonnet",
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 1000,
        cache_write_tokens: 10,
        usd: 0.325,
        estimated: false,
        extra: { requests: 2, charged_usd: 0.2 },
      },
      expect.objectContaining({ day: "2026-11-11", usd: 0.125 }),
    ]);
    const sent = JSON.parse(String(calls[0]?.init.body));
    expect(sent).toEqual({
      startDate: Date.parse("2026-11-10T00:00:00Z"),
      endDate: Date.parse("2026-11-12T00:00:00Z") - 1,
      page: 1,
      pageSize: 1000,
    });
    expect(((calls[0]?.init.headers ?? {}) as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("key_secret:").toString("base64")}`,
    );
  });

  it("reports a team without Admin API access as not available", async () => {
    const { send } = fakeFetch(() => ({ status: 401, body: { error: "Unauthorized" } }));
    const importer = cursorImporter({ adminKey: "k", fetch: send });
    await expect(importer.read("2026-11-10", "2026-11-10")).rejects.toBeInstanceOf(
      VendorNotAvailableError,
    );
  });
});

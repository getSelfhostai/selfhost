import { EVENT_SCHEMA, type LedgerEvent, validateEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import {
  CACHE_HIT_ALERT,
  cacheAlert,
  cacheByGroup,
  cacheDrops,
  cacheStats,
  cacheTips,
  cacheTipText,
  sessionCaches,
} from "../src/index.js";

let counter = 0;

interface Request {
  session?: string;
  vendor?: "claude_code" | "codex" | "cursor";
  person?: string;
  model?: string;
  input: number;
  read?: number;
  write?: number;
  usd?: number;
  minute?: number;
}

function request(input: Request): LedgerEvent {
  counter++;
  const minute = input.minute ?? counter;
  return {
    id: `01930c4e-2f1a-7b2c-8d3e-${counter.toString(16).padStart(12, "0")}`,
    schema: EVENT_SCHEMA,
    ts: new Date(Date.UTC(2026, 10, 9, 10, 0) + minute * 60_000).toISOString(),
    source: "local_log",
    kind: "cost.recorded",
    actor: { kind: "person", id: input.person ?? "ada@example.com" },
    agent: { vendor: input.vendor ?? "claude_code" },
    model: input.model ?? "claude-sonnet-4-5",
    ...(input.session ? { session_id: input.session } : {}),
    cost: {
      input_tokens: input.input,
      output_tokens: 100,
      cache_read_tokens: input.read ?? 0,
      cache_write_tokens: input.write ?? 0,
      usd: input.usd ?? 0.1,
      estimated: true,
    },
  };
}

/** A session that writes the cache once, then reads it on every request. */
const warm = (session: string, n: number, extra: Partial<Request> = {}) => [
  request({ session, input: 100, write: 9000, ...extra }),
  ...Array.from({ length: n - 1 }, () => request({ session, input: 100, read: 9000, ...extra })),
];

describe("cache hit rate", () => {
  it("is cache reads over reads, uncached input and cache writes", () => {
    const stats = cacheStats([
      request({ session: "a", input: 1000, write: 3000 }),
      request({ session: "a", input: 1000, read: 5000 }),
    ]);
    expect(stats).toEqual({
      read_tokens: 5000,
      fresh_tokens: 5000,
      hit_rate: 0.5,
      requests: 2,
      unknown_requests: 0,
    });
  });

  it("calls a session with no cache read or write unknown, not 0, and leaves it out", () => {
    const events = [
      ...warm("claude", 4),
      request({ session: "cursor", vendor: "cursor", input: 50_000 }),
      request({ session: "cursor", vendor: "cursor", input: 50_000 }),
    ];
    const { total, groups } = cacheByGroup(events, ["agent"]);
    expect(total.requests).toBe(4);
    expect(total.unknown_requests).toBe(2);
    expect(total.hit_rate).toBeCloseTo(27_000 / (27_000 + 400 + 9000));
    expect(groups.get("cursor")?.hit_rate).toBeNull();
    expect(groups.get("cursor")?.unknown_requests).toBe(2);
    expect(groups.get("claude_code")?.hit_rate).toBe(total.hit_rate);
    expect(cacheStats([]).hit_rate).toBeNull();
  });

  it("knows a session that wrote the cache and never read it: 0, the case worth flagging", () => {
    const stats = cacheStats([
      request({ session: "churn", input: 100, write: 9000 }),
      request({ session: "churn", input: 100, write: 9000 }),
    ]);
    expect(stats.hit_rate).toBe(0);
  });

  it("groups by person and model the same way", () => {
    const events = [
      ...warm("a", 3, { person: "ada@example.com" }),
      ...warm("b", 2, { person: "bo@example.com", model: "claude-opus-4-1" }),
    ];
    const { groups } = cacheByGroup(events, ["person", "model"]);
    expect([...groups.values()].map((g) => [g.group, g.requests])).toEqual([
      [{ person: "ada@example.com", model: "claude-sonnet-4-5" }, 3],
      [{ person: "bo@example.com", model: "claude-opus-4-1" }, 2],
    ]);
  });
});

describe("sessionCaches", () => {
  it("tracks the recent hit rate, so a collapse shows while the session runs", () => {
    const events = [
      ...warm("s", 20),
      ...Array.from({ length: 10 }, () => request({ session: "s", input: 100, write: 9000 })),
    ];
    const [session] = sessionCaches(events);
    expect(session?.requests).toBe(30);
    expect(session?.hit_rate).toBeCloseTo((19 * 9000) / (19 * 9000 + 30 * 100 + 11 * 9000));
    expect(session?.recent_hit_rate).toBe(0);
    expect(session?.model_switches).toBe(0);
  });

  it("counts model switches", () => {
    const events = [
      request({ session: "m", input: 100, write: 9000 }),
      request({ session: "m", input: 100, read: 9000, model: "claude-opus-4-1" }),
      request({ session: "m", input: 100, write: 9000 }),
    ];
    expect(sessionCaches(events)[0]?.model_switches).toBe(2);
  });
});

describe("cacheDrops and cacheTips", () => {
  const collapsed = [
    ...warm("long", 20, { usd: 0.5 }),
    ...Array.from({ length: 10 }, () =>
      request({ session: "long", input: 100, write: 9000, usd: 0.5 }),
    ),
  ];

  it("raises a drop only for a long session whose recent rate is under the floor", () => {
    const sessions = sessionCaches([
      ...collapsed,
      ...Array.from({ length: 5 }, () => request({ session: "short", input: 100, write: 9000 })),
      ...warm("healthy", 30),
      ...Array.from({ length: 30 }, () =>
        request({ session: "nocache", vendor: "cursor", input: 9 }),
      ),
    ]);
    const drops = cacheDrops(sessions, { floor: 0.5, minRequests: 20 });
    expect(drops.map((s) => s.session_id)).toEqual(["long"]);
    const later = new Date(Date.parse(drops[0]?.last_ts ?? "") + 1);
    expect(cacheDrops(sessions, { floor: 0.5, minRequests: 20, since: later })).toEqual([]);
  });

  it("tips sessions that cost enough at a low overall rate, in one line naming the causes", () => {
    const sessions = sessionCaches([
      ...Array.from({ length: 4 }, () =>
        request({ session: "pricey-session-id", input: 100, write: 9000, usd: 3 }),
      ),
      ...Array.from({ length: 4 }, () => request({ session: "cheap", input: 100, write: 9000 })),
    ]);
    const tips = cacheTips(sessions, { floor: 0.5, minUsd: 5 });
    expect(tips.map((s) => s.session_id)).toEqual(["pricey-session-id"]);
    const text = cacheTipText(tips[0] as never);
    expect(text).toBe(
      "Session pricey-s (claude_code, ada@example.com) cost $12.00 at 0% cache hits: usually a value that changes early in the prompt (such as a timestamp), tool lists that reorder, or a model switch.",
    );
    expect(text).not.toContain("\n");
  });

  it("builds one valid alert event per session, with a stable id", () => {
    const [session] = cacheDrops(sessionCaches(collapsed), { floor: 0.5, minRequests: 20 });
    if (!session) throw new Error("expected a drop");
    const id = (ts: string, key: string) =>
      `0193${Buffer.from(key).toString("hex").slice(0, 4)}-0000-7000-8000-${Date.parse(ts).toString(16).padStart(12, "0").slice(-12)}`;
    const first = cacheAlert(session, 0.5, new Date("2026-11-09T12:00:00Z"), id, "cli");
    const again = cacheAlert(session, 0.5, new Date("2026-11-09T12:05:00Z"), id, "cli");
    expect(first.id).toBe(again.id);
    expect(validateEvent(first).ok).toBe(true);
    expect(first.data).toMatchObject({
      alert: CACHE_HIT_ALERT,
      owner: "ada@example.com",
      recent_hit_rate: 0,
      floor: 0.5,
      requests: 30,
    });
    expect(String(first.data?.message)).toContain("such as a timestamp");
  });
});

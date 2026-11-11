import { HANDOFF_SCHEMA, type Handoff } from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HandoffStore } from "../src/handoffs.js";
import { BACKENDS, type Store } from "./helpers.js";

const id = (n: number) => `01930c4e-2f1a-7b2c-8d3e-${n.toString(16).padStart(12, "0")}`;

const handoff = (n: number, extra: Partial<Handoff> = {}): Handoff => ({
  schema: HANDOFF_SCHEMA,
  id: id(n),
  run_id: "session-1",
  team: "platform",
  repo: "acme/api",
  agent: { vendor: "claude_code" },
  from: "ana@example.com",
  to: "Ben@example.com",
  by: "ana@example.com",
  created_at: `2026-11-11T10:0${n}:00.000Z`,
  note: null,
  branch: "agent/rate-limits",
  commit: null,
  pushed: true,
  uncommitted: [],
  files: [],
  open_items: [],
  cost_usd: 1.5,
  tokens: 1000,
  turns: [],
  transcript: null,
  state: "pending",
  taken_at: null,
  event_id: id(100 + n),
  run_url: "https://selfhost.example.com/?screen=run&run=session-1",
  ...extra,
});

describe.each(BACKENDS)("handoff store on $name", (backend) => {
  let store: Store;
  let handoffs: HandoffStore;

  beforeAll(async () => {
    if (backend.skip) return;
    store = await backend.open();
    handoffs = store.ledger.handoffs;
  });

  afterAll(async () => {
    await store?.close();
  });

  it.skipIf(backend.skip)(
    "supersedes the run's pending handoff and gives the transcript once",
    async () => {
      await handoffs.create(handoff(1), '{"type":"user"}');
      await handoffs.create(handoff(2, { from: "ben@example.com", to: "cy@example.com" }), "line");
      await handoffs.create(handoff(3, { run_id: "session-2", team: "web" }));

      const first = await handoffs.get(id(1));
      expect(first?.state).toBe("superseded");
      expect(await handoffs.take(id(1), new Date("2026-11-11T11:00:00Z"))).toBeUndefined();

      expect((await handoffs.ofRun("session-1")).map((h) => h.id)).toEqual([id(1), id(2)]);
      expect(
        (await handoffs.list({ to: "CY@example.com", state: "pending" })).map((h) => h.id),
      ).toEqual([id(2)]);
      expect((await handoffs.list({ teams: ["web"] })).map((h) => h.id)).toEqual([id(3)]);
      expect((await handoffs.list({ to: "ben@example.com" })).map((h) => h.id)).toEqual([
        id(3),
        id(1),
      ]);

      const taken = await handoffs.take(id(2), new Date("2026-11-11T11:00:00Z"));
      expect(taken?.transcript).toBe("line");
      expect(taken?.handoff).toMatchObject({
        state: "taken",
        taken_at: "2026-11-11T11:00:00.000Z",
      });
      expect(await handoffs.take(id(2), new Date("2026-11-11T11:01:00Z"))).toBeUndefined();
      expect((await handoffs.get(id(2)))?.state).toBe("taken");
      expect(await handoffs.get("not-a-uuid")).toBeUndefined();
    },
  );
});

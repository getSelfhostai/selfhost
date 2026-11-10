import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importAll } from "@selfhost/importers";
import { databaseOf, type Ledger, mapBifrostLog, openLedger } from "@selfhost/ledger";
import { EVENT_SCHEMA, type LedgerEvent } from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  costPerMergedPr,
  countedCostsSql,
  oneSourcePerSession,
  pairGatewayCosts,
  readRoiInput,
  roiInputFromEvents,
} from "../src/index.js";
import { cost } from "./helpers.js";

/**
 * A real laptop day (fixtures/dogfood): bob's two Claude Code 2.1.83 sessions went through the
 * Bifrost gateway, so each request is in his transcript and in Bifrost's request log; alice's
 * two sessions went straight to the vendor and are only in her transcripts.
 */
const DOGFOOD = join(import.meta.dirname, "..", "..", "..", "fixtures", "dogfood");
const BOB = ["915dc8f5-6c69-4388-8b5b-2998a83d4e4d", "fd281561-c586-42ca-8bf5-caeaa48b5b19"];
const ALICE = ["e47b0f2d-1c53-402b-a447-f6d3eb628c4d", "1e4bd4cd-c12d-4937-b679-d9a8041f63e2"];
const usd = (events: LedgerEvent[]) =>
  Math.round(events.reduce((sum, e) => sum + (e.cost?.usd ?? 0), 0) * 1e8) / 1e8;

async function transcripts(): Promise<LedgerEvent[]> {
  const events: LedgerEvent[] = [];
  await importAll(
    {
      append: async (batch) => {
        events.push(...batch);
        return { accepted: batch.map((e) => e.id), duplicates: [] };
      },
    },
    {
      claudeDir: join(DOGFOOD, "claude-code"),
      vendor: "claude_code",
      since: new Date("2026-11-01"),
      actorId: "bob@example.com",
    },
  );
  return events.filter((e) => e.kind === "cost.recorded");
}

function gateway(): LedgerEvent[] {
  const { logs } = JSON.parse(readFileSync(join(DOGFOOD, "bifrost-logs.json"), "utf8")) as {
    logs: unknown[];
  };
  return logs.flatMap((log) => mapBifrostLog(log)).filter((e) => e.kind === "cost.recorded");
}

let logs: LedgerEvent[];
let requests: LedgerEvent[];

beforeAll(async () => {
  logs = await transcripts();
  requests = gateway();
});

describe("a request the gateway and the session log both report", () => {
  it("is in both sources, with no session on the gateway's copy", () => {
    expect(requests).toHaveLength(7);
    expect(requests.every((e) => e.session_id === undefined)).toBe(true);
    const bob = logs.filter((e) => BOB.includes(e.session_id ?? ""));
    expect(bob).toHaveLength(7);
    // Naive sum: every request counted twice.
    expect(usd([...logs, ...requests])).toBeCloseTo(usd(logs) + usd(requests), 8);
  });

  it("counts once, as the gateway's event, under the session of its log copy", () => {
    const counted = oneSourcePerSession([...logs, ...requests]);
    const bob = counted.filter((e) => BOB.includes(e.session_id ?? ""));
    expect(bob.map((e) => e.source)).toEqual(Array(7).fill("gateway"));
    expect(new Set(bob.map((e) => e.session_id))).toEqual(new Set(BOB));
    // The log knew which part of the agent sent each request; the gateway did not.
    expect(bob.every((e) => e.data?.request_type === "main")).toBe(true);
    // Sessions that did not go through the gateway keep their log.
    const alice = counted.filter((e) => ALICE.includes(e.session_id ?? ""));
    expect(alice.length).toBeGreaterThan(0);
    expect(alice.every((e) => e.source === "local_log")).toBe(true);
    expect(usd(counted)).toBeCloseTo(
      usd(requests) + usd(logs.filter((e) => ALICE.includes(e.session_id ?? ""))),
      8,
    );
    // The gateway and Claude Code price these the same way.
    expect(usd(requests)).toBeCloseTo(usd(logs.filter((e) => BOB.includes(e.session_id ?? ""))), 6);
  });

  it("joins requests of the same size in order, and only close in time", () => {
    const ts = "2026-11-10T10:00:00.000Z";
    const later = "2026-11-10T10:30:00.000Z";
    const a = cost({ ts, usd: 1, tokens: 500, session: "s1", source: "local_log" });
    const b = cost({ ts: later, usd: 1, tokens: 500, session: "s1", source: "local_log" });
    const g = cost({ ts, usd: 1.1, tokens: 500, source: "gateway" });
    const far = cost({ ts, usd: 2, tokens: 900, source: "gateway" });
    const late = cost({ ts: later, usd: 2, tokens: 900, session: "s2", source: "local_log" });
    const pairs = pairGatewayCosts([a, b, g, far, late]);
    expect([...pairs.copies]).toEqual([a.id]);
    expect(oneSourcePerSession([a, b, g, far, late]).map((e) => [e.id, e.session_id])).toEqual([
      [b.id, "s1"],
      [g.id, "s1"],
      [far.id, undefined],
      [late.id, "s2"],
    ]);
  });
  it("never joins tiny requests or two people's requests", () => {
    const ts = "2026-11-10T10:00:00.000Z";
    const tiny = cost({ ts, usd: 0.001, tokens: 9, session: "s1", source: "local_log" });
    const tinyGateway = cost({ ts, usd: 0.001, tokens: 9, source: "gateway" });
    const ada = cost({ ts, usd: 1, tokens: 700, person: "ada@example.com", session: "s3" });
    const ben = cost({ ts, usd: 1, tokens: 700, person: "ben@example.com", source: "gateway" });
    const pairs = pairGatewayCosts([tiny, tinyGateway, ada, ben]);
    expect(pairs.copies.size).toBe(0);
    expect(oneSourcePerSession([tiny, tinyGateway, ada, ben])).toHaveLength(4);
  });
});

describe("the same rule in SQL", () => {
  let ledger: Ledger;

  beforeAll(async () => {
    ledger = await openLedger({ dataDir: "memory://" });
    await ledger.append([...logs, ...requests]);
  });
  afterAll(() => ledger.close());

  it("drops the same copies and gives the gateway rows the same sessions", async () => {
    const rows = await databaseOf(ledger).query<{
      id: string;
      paired: boolean;
      counted_session: string | null;
    }>(
      `WITH cost_rows AS (
         SELECT id, ts, source, session_id, body FROM events WHERE kind = 'cost.recorded'
       ),
       ${countedCostsSql("cost_rows", "t")}
       SELECT id::text AS id, paired, counted_session FROM t_counted`,
    );
    const { copies, twins } = pairGatewayCosts([...logs, ...requests]);
    const expected = [...logs, ...requests]
      .filter((e) => !copies.has(e.id))
      .map((e) => ({
        id: e.id,
        paired: twins.has(e.id),
        counted_session: e.session_id ?? twins.get(e.id)?.session_id ?? null,
      }))
      .sort((x, y) => x.id.localeCompare(y.id));
    expect(rows.sort((x, y) => x.id.localeCompare(y.id))).toEqual(expected);
    expect(copies.size).toBe(7);
  });

  it("gives a merged pull request its gateway spend, read from the ledger or from events", async () => {
    const merged: LedgerEvent = {
      id: "019a6d00-0000-7000-8000-00000000d001",
      schema: EVENT_SCHEMA,
      ts: "2026-11-10T08:00:00.000Z",
      source: "github",
      kind: "pr.merged",
      actor: { kind: "person", id: "bob@example.com" },
      agent: { vendor: "claude_code" },
      session_id: BOB[1],
      repo: "acme/web-site",
      links: { pr_url: "https://github.com/acme/web-site/pull/1" },
    };
    await ledger.append([merged]);
    const range = { team: null, from: new Date("2026-11-10"), to: new Date("2026-11-11") };
    const fromEvents = costPerMergedPr(roiInputFromEvents([...logs, ...requests, merged], range));
    const fromLedger = costPerMergedPr(await readRoiInput(databaseOf(ledger), range));
    expect(fromLedger).toEqual(fromEvents);
    const session = oneSourcePerSession([...logs, ...requests]).filter(
      (e) => e.session_id === BOB[1],
    );
    // fd281561's three priced requests, all through the gateway.
    expect(session.map((e) => e.source)).toEqual(["gateway", "gateway", "gateway"]);
    expect(fromLedger.attributed_usd).toBeCloseTo(usd(session), 6);
    // Every request of the day counted once: alice's logs, and bob's requests as the gateway's.
    expect(fromLedger.attributed_usd + fromLedger.unattributed_usd).toBeCloseTo(
      usd(oneSourcePerSession([...logs, ...requests])),
      6,
    );
  });
});

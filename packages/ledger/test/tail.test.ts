import { EVENT_SCHEMA, type LedgerEvent } from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseOf, type Ledger, LedgerQueryError, openLedger, tailEvents } from "../src/index.js";

let n = 0;
const event = (fields: Partial<LedgerEvent> & Pick<LedgerEvent, "kind">): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: EVENT_SCHEMA,
  ts: "2026-11-09T10:00:00.000Z",
  source: "hook",
  actor: { kind: "person", id: "ada@example.com" },
  agent: { vendor: "claude_code" },
  session_id: "s1",
  ...fields,
});

const FROM = "2026-11-09T00:00:00.000Z";

describe("tailEvents", () => {
  let ledger: Ledger;
  const db = () => databaseOf(ledger);

  beforeAll(async () => {
    ledger = await openLedger({ dataDir: "memory://" });
  });

  afterAll(async () => {
    await ledger.close();
  });

  it("starts now, then reads each batch once, in the order it landed", async () => {
    const start = await tailEvents(db(), { from: FROM });
    expect(start.rows).toEqual([]);

    // Written second but happened first: the tail goes by arrival, not by ts.
    const first = [
      event({ kind: "session.started", repo: "acme/api", ts: "2026-11-09T10:00:05.000Z" }),
      event({ kind: "tool.called", tool: { name: "Bash", input_summary: "npm test" } }),
    ];
    await ledger.append(first);
    const page1 = await tailEvents(db(), { from: FROM, after: start.cursor });
    expect(page1.rows.map((row) => row.event.id)).toEqual(first.map((e) => e.id).sort());
    // The run's repo, from its session.started, for events that carry none.
    expect(page1.rows.map((row) => row.repo)).toEqual(["acme/api", "acme/api"]);

    const second = [event({ kind: "session.ended", ts: "2026-11-09T09:00:00.000Z" })];
    await ledger.append(second);
    const page2 = await tailEvents(db(), { from: FROM, after: page1.cursor });
    expect(page2.rows.map((row) => row.event.id)).toEqual([second[0]?.id]);
    const page3 = await tailEvents(db(), { from: FROM, after: page2.cursor });
    expect(page3.rows).toEqual([]);
    expect(page3.cursor).toBe(page2.cursor);
  });

  it("backfills from `from` and filters by kind group, person, agent, repo and session", async () => {
    await ledger.append([
      event({
        kind: "cost.recorded",
        session_id: "s2",
        agent: { vendor: "codex" },
        cost: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          usd: 0.01,
          estimated: true,
        },
      }),
      event({
        kind: "tool.result",
        tool: { name: "Bash" },
        actor: { kind: "person", id: "bo@example.com" },
      }),
      event({ kind: "tool.called", tool: { name: "Read" }, ts: "2026-11-08T23:00:00.000Z" }),
    ]);
    const all = await tailEvents(db(), { from: FROM, backfill: true });
    expect(all.rows.map((row) => row.event.kind)).toEqual([
      "session.started",
      "tool.called",
      "session.ended",
      "cost.recorded",
      "tool.result",
    ]);
    const kinds = (rows: { event: LedgerEvent }[]) => rows.map((row) => row.event.kind);
    expect(
      kinds((await tailEvents(db(), { from: FROM, backfill: true, kinds: ["tool"] })).rows),
    ).toEqual(["tool.called", "tool.result"]);
    expect(
      kinds(
        (await tailEvents(db(), { from: FROM, backfill: true, kinds: ["tool.result", "session"] }))
          .rows,
      ),
    ).toEqual(["session.started", "session.ended", "tool.result"]);
    expect(
      kinds(
        (await tailEvents(db(), { from: FROM, backfill: true, person: "bo@example.com" })).rows,
      ),
    ).toEqual(["tool.result"]);
    expect(
      kinds((await tailEvents(db(), { from: FROM, backfill: true, agent: "codex" })).rows),
    ).toEqual(["cost.recorded"]);
    expect(
      (await tailEvents(db(), { from: FROM, backfill: true, repo: "ACME/api" })).rows,
    ).toHaveLength(4);
    expect(
      (await tailEvents(db(), { from: FROM, backfill: true, session: "s2" })).rows,
    ).toHaveLength(1);
    const limited = await tailEvents(db(), { from: FROM, backfill: true, limit: 2 });
    expect(limited.rows).toHaveLength(2);
    const rest = await tailEvents(db(), { from: FROM, after: limited.cursor });
    expect(rest.rows).toHaveLength(3);
  });

  it("gives the person of a session to its policy and log events, and filters on it", async () => {
    const start = await tailEvents(db(), { from: FROM });
    await ledger.append([
      event({
        kind: "session.started",
        session_id: "s-cy",
        actor: { kind: "person", id: "cy@example.com" },
      }),
      event({
        kind: "policy.evaluated",
        session_id: "s-cy",
        actor: { kind: "system", id: "selfhost-policy" },
        decision: { verdict: "block", by: "selfhost-policy", rule_id: "r", mode: "enforce" },
      }),
      event({
        kind: "tool.called",
        session_id: "s-cy",
        source: "local_log",
        actor: { kind: "agent", id: "claude_code:session:s-cy" },
        tool: { name: "Bash" },
      }),
      event({
        kind: "policy.evaluated",
        session_id: "s-other",
        actor: { kind: "system", id: "selfhost-policy" },
        decision: { verdict: "block", by: "selfhost-policy", rule_id: "r", mode: "enforce" },
        data: { sent_by: "cy@example.com" },
      }),
    ]);
    const page = await tailEvents(db(), { from: FROM, after: start.cursor });
    expect(page.rows.map((row) => row.person)).toEqual([
      "cy@example.com",
      "cy@example.com",
      "cy@example.com",
      "cy@example.com",
    ]);
    const policy = await tailEvents(db(), {
      from: FROM,
      backfill: true,
      person: "cy@example.com",
      kinds: ["policy"],
    });
    expect(policy.rows.map((row) => row.event.session_id)).toEqual(["s-cy", "s-other"]);
  });

  it("reads only the teams given", async () => {
    await ledger.append([event({ kind: "prompt.submitted", session_id: "s-web" })], {
      team: "web",
    });
    const rows = (teams: string[] | null) =>
      tailEvents(db(), { from: FROM, backfill: true, teams }).then((page) =>
        page.rows.map((row) => row.team),
      );
    expect(await rows(["web"])).toEqual(["web"]);
    expect(await rows(["data"])).toEqual([]);
    expect((await rows(null)).length).toBeGreaterThan(1);
  });

  it("refuses unknown kinds, bad limits and bad cursors", async () => {
    await expect(tailEvents(db(), { from: FROM, kinds: ["tools"] })).rejects.toThrow(
      LedgerQueryError,
    );
    await expect(tailEvents(db(), { from: FROM, limit: 0 })).rejects.toThrow(/limit/);
    await expect(tailEvents(db(), { from: FROM, after: "nope" })).rejects.toThrow(/cursor/);
  });
});

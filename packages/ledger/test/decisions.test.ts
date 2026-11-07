import type { CreateDecisionRequest, LedgerEvent } from "@selfhost/schema";
import { validateEvent } from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatDecision } from "../src/decisions/chat.js";
import { DecisionInputError, recordDecision } from "../src/decisions/record.js";
import { normalizeDecisionPath } from "../src/decisions/store.js";
import { renderDecision, renderDecisions } from "../src/decisions/text.js";
import { LedgerQueryError } from "../src/errors.js";
import type { Ledger } from "../src/ledger.js";
import { BACKENDS, makeEvent, type Store } from "./helpers.js";

const ITEM = "01930c4e-2f1a-7b2c-8d3e-4f5a6b7c8d40";

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

const fieldsOf = async (promise: Promise<unknown>) => {
  const error = await rejected(promise);
  expect(error).toBeInstanceOf(DecisionInputError);
  return (error as DecisionInputError).errors.map((e) => e.field);
};

describe.each(BACKENDS)("decisions on $name", (backend) => {
  let store: Store;
  let ledger: Ledger;
  let minute = 0;
  /** A distinct, increasing time for each decision, so newest-first order is predictable. */
  const at = () => {
    minute += 1;
    return `2026-11-07T10:${String(minute).padStart(2, "0")}:00.000Z`;
  };
  const decide = (input: Partial<CreateDecisionRequest>) =>
    recordDecision(ledger, {
      verdict: "approve",
      by: "alice@example.com",
      ts: at(),
      ...input,
    } as CreateDecisionRequest);
  const decisionsBy = async (person: string) =>
    (await ledger.query({ kind: "decision.recorded", person, limit: 1000 })).events;

  beforeAll(async () => {
    if (backend.skip) return;
    store = await backend.open();
    ledger = store.ledger;
  });

  afterAll(async () => {
    await store?.close();
  });

  describe.skipIf(backend.skip)("recordDecision", () => {
    it("writes one valid decision.recorded event with who, what, why and links", async () => {
      const { event, duplicate } = await decide({
        by: "  alice@example.com ",
        name: "Alice",
        verdict: "deny",
        reason: "  Keep the old index until the backfill finishes. ",
        question: "Drop the users_email index?",
        item_id: ITEM,
        run_id: "run-42",
        rule_id: "protect-migrations",
        repo: "acme/api",
        paths: ["./db/migrations/0007_drop_index.sql"],
        pr_url: "https://github.com/acme/api/pull/7",
        run_url: "https://ci.example.com/runs/42",
        commit_sha: "5786c5c9d81ca4218b7e44bf0007f5580f66c489",
        surface: "cli",
      });
      expect(duplicate).toBe(false);
      expect(validateEvent(event).ok).toBe(true);
      expect(event).toMatchObject({
        schema: "selfhost.event/v1",
        kind: "decision.recorded",
        source: "server",
        actor: { kind: "person", id: "alice@example.com", name: "Alice" },
        repo: "acme/api",
        run_id: "run-42",
        target: { type: "file", value: "db/migrations/0007_drop_index.sql" },
        decision: {
          verdict: "deny",
          by: "alice@example.com",
          reason: "Keep the old index until the backfill finishes.",
          rule_id: "protect-migrations",
          item_id: ITEM,
        },
        links: {
          pr_url: "https://github.com/acme/api/pull/7",
          run_url: "https://ci.example.com/runs/42",
          commit_sha: "5786c5c9d81ca4218b7e44bf0007f5580f66c489",
          item_id: ITEM,
        },
        data: { surface: "cli", question: "Drop the users_email index?" },
      });
      expect(await decisionsBy("alice@example.com")).toEqual([event]);
    });

    it("keeps several paths in data.paths and a lone pull request as the target", async () => {
      const { event } = await decide({
        by: "paths@example.com",
        pr_url: "https://github.com/acme/api/pull/8",
        paths: ["src/b.ts", "src/a.ts", "src/b.ts"],
      });
      expect(event.target).toEqual({ type: "pr", value: "https://github.com/acme/api/pull/8" });
      expect(event.data).toEqual({ surface: "api", paths: ["src/a.ts", "src/b.ts"] });
    });

    it("stores a retried action once when it carries the same key and time", async () => {
      const input = {
        by: "retry@example.com",
        run_id: "run-retry",
        surface: "slack" as const,
        key: "action-1",
        ts: "2026-11-07T11:00:00.000Z",
      };
      const first = await decide(input);
      const again = await decide({ ...input, reason: "different text on the retry" });
      expect(first.duplicate).toBe(false);
      expect(again).toEqual({ event: first.event, duplicate: true });
      const other = await decide({ ...input, surface: "telegram" });
      expect(other.duplicate).toBe(false);
      expect(await decisionsBy("retry@example.com")).toHaveLength(2);
    });

    it("records a new decision on each call without a key", async () => {
      const input = { by: "nokey@example.com", run_id: "run-1", ts: "2026-11-07T11:00:00.000Z" };
      await decide(input);
      await decide(input);
      expect(await decisionsBy("nokey@example.com")).toHaveLength(2);
    });

    it("refuses invalid decisions and writes nothing", async () => {
      expect(await fieldsOf(decide({ verdict: "block" as "deny", run_id: "r" }))).toEqual([
        "verdict",
      ]);
      expect(await fieldsOf(decide({ by: "   ", run_id: "r" }))).toEqual(["by"]);
      expect(await fieldsOf(decide({ by: "bad@example.com" }))).toEqual(["item_id"]);
      expect(await fieldsOf(decide({ run_id: "r", key: "k", ts: undefined }))).toEqual(["ts"]);
      expect(await fieldsOf(decide({ run_id: "r", paths: ["./"] }))).toEqual(["paths[0]"]);
      expect(await fieldsOf(decide({ run_id: "r", extra: 1 } as never))).toEqual(["extra"]);
      expect(
        await fieldsOf(decide({ by: "bad@example.com", replaces_event_id: ITEM, verdict: "deny" })),
      ).toEqual(["replaces_event_id"]);
      expect(await decisionsBy("bad@example.com")).toEqual([]);
    });
  });

  describe.skipIf(backend.skip)("corrections", () => {
    it("never edits a decision: a correction is a new event linked to the old one", async () => {
      const original = await decide({
        by: "chain@example.com",
        reason: "Looks safe",
        question: "Allow the agent to run the seed script?",
        rule_id: "ask-before-seed",
        paths: ["scripts/seed.ts"],
        item_id: ITEM,
      });
      const overturn = await decide({
        by: "lead@example.com",
        verdict: "override",
        reason: "The seed script wipes staging",
        replaces_event_id: original.event.id,
      });
      const fixed = await decide({
        by: "chain@example.com",
        verdict: "deny",
        reason: "Agreed, denied",
        replaces_event_id: overturn.event.id,
      });

      // The original is stored exactly as it was written.
      expect(await ledger.decisions.get(original.event.id)).toEqual(original.event);
      // Fields the correction leaves out come from the decision it replaces.
      expect(overturn.event).toMatchObject({
        target: { type: "file", value: "scripts/seed.ts" },
        decision: {
          verdict: "override",
          by: "lead@example.com",
          rule_id: "ask-before-seed",
          item_id: ITEM,
          replaces_event_id: original.event.id,
        },
        data: { question: "Allow the agent to run the seed script?" },
      });
      expect(fixed.event.decision?.replaces_event_id).toBe(overturn.event.id);

      const page = await ledger.decisions.search({ path: "scripts/seed.ts" });
      expect(page.events.map((e) => e.id)).toEqual([
        fixed.event.id,
        overturn.event.id,
        original.event.id,
      ]);
      expect(page.replacedBy).toEqual({
        [original.event.id]: [overturn.event.id],
        [overturn.event.id]: [fixed.event.id],
      });
    });

    it("can overturn a rule verdict", async () => {
      const verdict = makeEvent(900, {
        ts: "2026-11-07T08:00:00.000Z",
        source: "cli",
        kind: "policy.evaluated",
        actor: { kind: "system", id: "selfhost-policy" },
        tool: { name: "Bash", input_summary: "git push --force" },
        target: { type: "command", value: "git push --force" },
        decision: { verdict: "block", by: "selfhost-policy", rule_id: "no-force-push" },
      });
      await ledger.append([verdict]);
      const { event } = await decide({
        by: "rules@example.com",
        verdict: "override",
        reason: "Rewriting my own branch",
        replaces_event_id: verdict.id,
      });
      expect(event.decision).toMatchObject({ rule_id: "no-force-push" });
    });
  });

  describe.skipIf(backend.skip)("search", () => {
    const ids = (events: LedgerEvent[]) => events.map((e) => e.id);
    const seeded: Record<string, LedgerEvent> = {};

    beforeAll(async () => {
      if (backend.skip) return;
      const add = async (name: string, input: Partial<CreateDecisionRequest>) => {
        seeded[name] = (
          await decide({ by: "search@example.com", repo: "acme/search", ...input })
        ).event;
      };
      await add("migration", {
        run_id: "run-m",
        question: "Run the users migration on staging?",
        reason: "Backfill is done, go ahead",
        paths: ["db/migrations/0003_users.sql"],
      });
      await add("folder", {
        rule_id: "protect-migrations",
        verdict: "override",
        question: "Promote rule protect-migrations from observe to enforce",
        paths: ["db/migrations"],
      });
      await add("several", {
        pr_url: "https://github.com/acme/search/pull/3",
        verdict: "deny",
        reason: "Split the RATE limiter change from the cache change",
        paths: ["src/cache.ts", "src/rate/limit.ts"],
      });
      await add("lookalike", { run_id: "run-l", paths: ["dbx/migrations.sql"] });
      await ledger.append([
        makeEvent(901, {
          ts: "2026-11-07T12:00:00.000Z",
          kind: "policy.evaluated",
          actor: { kind: "system", id: "selfhost-policy" },
          repo: "acme/search",
          target: { type: "file", value: "/home/dev/acme-search/src/rate/limit.ts" },
          decision: {
            verdict: "ask",
            by: "selfhost-policy",
            reason: "Rate limits need a second look",
            rule_id: "ask-rate",
            mode: "observe",
          },
        }),
        // Not a decision: never returned.
        makeEvent(902, {
          ts: "2026-11-07T12:01:00.000Z",
          kind: "tool.called",
          repo: "acme/search",
          tool: { name: "Edit" },
          target: { type: "file", value: "src/rate/limit.ts" },
        }),
      ]);
    });

    const search = async (query: Parameters<Ledger["decisions"]["search"]>[0]) =>
      ids((await ledger.decisions.search({ repo: "acme/search", ...query })).events);

    it("finds decisions by file, by folder and by a folder that holds the file", async () => {
      const { migration, folder, several } = seeded;
      expect(await search({ path: "db/migrations/0003_users.sql" })).toEqual([
        folder?.id,
        migration?.id,
      ]);
      expect(await search({ path: "./db/migrations/" })).toEqual([folder?.id, migration?.id]);
      expect(await search({ path: "db" })).toEqual([folder?.id, migration?.id]);
      expect(await search({ path: "0003_users.sql" })).toEqual([migration?.id]);
      // Rule verdicts on absolute paths match the same file; tool calls never come back.
      expect(await search({ path: "src/rate/limit.ts" })).toEqual([
        "01930c4e-2f1a-7b2c-8d3e-000000000385",
        several?.id,
      ]);
      expect(await search({ path: "src\\cache.ts" })).toEqual([several?.id]);
      expect(await search({ path: "src/rate/limit" })).toEqual([]);
    });

    it("finds decisions by topic in the question and reason, ignoring case", async () => {
      const { migration, folder, several } = seeded;
      expect(await search({ topic: "migration" })).toEqual([folder?.id, migration?.id]);
      expect(await search({ topic: "users  STAGING" })).toEqual([migration?.id]);
      expect(await search({ topic: "rate limit" })).toEqual([
        "01930c4e-2f1a-7b2c-8d3e-000000000385",
        several?.id,
      ]);
      expect(await search({ topic: "rate", path: "src/cache.ts" })).toEqual([several?.id]);
      expect(await search({ text: "staging" })).toEqual([]);
      expect(await search({ text: "backfill" })).toEqual([migration?.id]);
    });

    it("filters by rule, verdict, person, item and target", async () => {
      const { folder, several } = seeded;
      expect(await search({ rule_id: "protect-migrations" })).toEqual([folder?.id]);
      expect(await search({ verdict: "deny" })).toEqual([several?.id]);
      expect(await search({ person: "selfhost-policy" })).toEqual([
        "01930c4e-2f1a-7b2c-8d3e-000000000385",
      ]);
      expect(await search({ target: "pull/3" })).toEqual([several?.id]);
      expect(await ledger.decisions.search({ item_id: ITEM.toUpperCase() })).toMatchObject({
        events: expect.arrayContaining([expect.objectContaining({ kind: "decision.recorded" })]),
      });
    });

    it("pages newest first with a cursor", async () => {
      const all = await search({});
      expect(all).toHaveLength(5);
      const first = await ledger.decisions.search({ repo: "acme/search", limit: 2 });
      expect(ids(first.events)).toEqual(all.slice(0, 2));
      const second = await ledger.decisions.search({
        repo: "acme/search",
        limit: 2,
        cursor: first.nextCursor,
      });
      expect(ids(second.events)).toEqual(all.slice(2, 4));
    });

    it.each([
      [{ path: "." }, "path"],
      [{ topic: "   " }, "topic"],
      [{ verdict: "maybe" }, "verdict"],
      [{ cursor: "nope" }, "cursor"],
      [{ limit: 0 }, "limit"],
    ])("rejects %j naming %s", async (query, field) => {
      const error = await rejected(ledger.decisions.search(query as never));
      expect(error).toBeInstanceOf(LedgerQueryError);
      expect((error as LedgerQueryError).field).toBe(field);
    });

    it("looks up decisions and rule verdicts by id, and nothing else", async () => {
      expect(await ledger.decisions.get(seeded.migration?.id ?? "")).toEqual(seeded.migration);
      expect(await ledger.decisions.get("01930c4e-2f1a-7b2c-8d3e-000000000386")).toBeUndefined();
      expect(await ledger.decisions.get("not-a-uuid")).toBeUndefined();
    });
  });
});

describe("normalizeDecisionPath", () => {
  it.each([
    ["./src/a.ts", "src/a.ts"],
    ["src\\a.ts", "src/a.ts"],
    ["src//b/../a.ts", "src/a.ts"],
    ["db/migrations/", "db/migrations"],
    [" /abs/path ", "/abs/path"],
  ])("%s becomes %s", (input, output) => {
    expect(normalizeDecisionPath(input)).toBe(output);
  });
});

describe("chatDecision", () => {
  it("keeps the reason to one line and keys the decision on the press", () => {
    expect(
      chatDecision({
        surface: "telegram",
        actionId: "cbq-77",
        at: "2026-11-07T09:00:00.000Z",
        person: "dana@example.com",
        verdict: "approve",
        itemId: ITEM,
        question: "Deploy\nto staging?",
        reason: "  fine by me,\n ship it  ",
      }),
    ).toEqual({
      verdict: "approve",
      by: "dana@example.com",
      reason: "fine by me, ship it",
      question: "Deploy to staging?",
      item_id: ITEM,
      surface: "telegram",
      key: "cbq-77",
      ts: "2026-11-07T09:00:00.000Z",
    });
  });
});

describe("renderDecisions", () => {
  const decision: LedgerEvent = {
    id: "01930c4e-2f1a-7b2c-8d3e-4f5a6b7c8d08",
    schema: "selfhost.event/v1",
    ts: "2026-11-07T09:30:00.000Z",
    source: "cli",
    kind: "decision.recorded",
    actor: { kind: "person", id: "alice@example.com" },
    repo: "acme/api",
    run_id: "run-9",
    target: { type: "file", value: "db/migrations/0001.sql" },
    decision: {
      verdict: "override",
      by: "alice@example.com",
      reason: "Approved by mistake.\nReverting.",
      rule_id: "protect-migrations",
      item_id: ITEM,
      replaces_event_id: "01930c4e-2f1a-7b2c-8d3e-4f5a6b7c8d04",
    },
    links: { pr_url: "https://github.com/acme/api/pull/9", item_id: ITEM },
    data: { surface: "cli", question: "Apply migration 0001?" },
  };

  it("prints the id, who, verdict, reason and links as plain text", () => {
    expect(
      renderDecisions({
        events: [decision],
        nextCursor: "abc",
        replacedBy: { [decision.id]: ["01930c4e-2f1a-7b2c-8d3e-4f5a6b7c8d09"] },
      }),
    ).toBe(
      [
        "1 decision, newest first.",
        "",
        "01930c4e-2f1a-7b2c-8d3e-4f5a6b7c8d08  2026-11-07T09:30:00.000Z  override by alice@example.com",
        "  question: Apply migration 0001?",
        "  reason: Approved by mistake.",
        "    Reverting.",
        "  rule: protect-migrations",
        `  item: ${ITEM}`,
        "  run: run-9",
        "  repo: acme/api",
        "  files: db/migrations/0001.sql",
        "  pr: https://github.com/acme/api/pull/9",
        "  replaces: 01930c4e-2f1a-7b2c-8d3e-4f5a6b7c8d04",
        "  replaced by: 01930c4e-2f1a-7b2c-8d3e-4f5a6b7c8d09",
        "",
        "next_cursor: abc",
      ].join("\n"),
    );
  });

  it("prints rule verdicts with the rule, mode and target", () => {
    const verdict: LedgerEvent = {
      ...decision,
      kind: "policy.evaluated",
      run_id: undefined,
      target: { type: "command", value: "git push --force" },
      decision: {
        verdict: "block",
        by: "selfhost-policy",
        reason: "No force pushes.",
        rule_id: "no-force-push",
        mode: "observe",
      },
      links: undefined,
      data: undefined,
    };
    expect(renderDecision(verdict)).toBe(
      [
        "01930c4e-2f1a-7b2c-8d3e-4f5a6b7c8d08  2026-11-07T09:30:00.000Z  block by rule no-force-push (observe)",
        "  reason: No force pushes.",
        "  repo: acme/api",
        "  command: git push --force",
      ].join("\n"),
    );
  });

  it("says so when nothing matches", () => {
    expect(renderDecisions({ events: [], replacedBy: {} })).toBe("No decisions match.");
  });
});

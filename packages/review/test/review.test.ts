import {
  databaseOf,
  type Ledger,
  mapClaudeCodeHook,
  mapCodexHook,
  recordDecision,
  stableEventId,
} from "@selfhost/ledger";
import { policyEvent } from "@selfhost/policy";
import {
  type LedgerEvent,
  REVIEW_ITEM_KINDS,
  type ReviewItem,
  validateReviewItem,
} from "@selfhost/schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  AlreadyAnsweredError,
  compareItems,
  openReviewList,
  ReviewInputError,
  ReviewItemNotFoundError,
  type ReviewList,
  refreshReviewList,
} from "../src/index.js";
import { at, BACKENDS, config, event, readFixture } from "./helpers.js";

/** A Tuesday, so the week before (Monday 2 to Monday 9 November) has ended. */
const NOW = "2026-11-10T10:00:00.000Z";
const PERSON = "dev@example.com";
const CLAUDE_SESSION = "665bce74-4bdc-4164-8bb1-cc4246de2400";
const CODEX_SESSION = "01a10ca6-8deb-75c0-92f6-bb789b300b1a";
const PR_URL = "https://github.com/acme/api/pull/42";
const HASH = "a".repeat(64);

const notification = readFixture("hooks", "claude-code", "Notification.json");
const prompt = readFixture("hooks", "claude-code", "UserPromptSubmit.json");
const preToolUse = readFixture("hooks", "claude-code", "PreToolUse.json");
const permissionRequest = readFixture("hooks", "codex", "PermissionRequest.json");
const codexToolResult = readFixture("hooks", "codex", "PostToolUse.json");

const claude = (
  payload: Record<string, unknown>,
  ts: string,
  extra: Record<string, unknown> = {},
) => mapClaudeCodeHook({ ...payload, ...extra }, { ts, person: PERSON, repo: "acme/api" });

const codex = (payload: Record<string, unknown>, ts: string, extra: Record<string, unknown> = {}) =>
  mapCodexHook({ ...payload, ...extra }, { ts, person: "cx@example.com", repo: "acme/api" });

/** Claude Code is idle and waits for input: a question. */
const idle = (ts: string, session = "q-session") =>
  claude(notification, ts, {
    session_id: session,
    notification_type: "idle_prompt",
    message: "Claude is waiting for your input",
  });

/** A rule verdict on a fixture tool call, as the policy evaluator writes it. */
function verdict(
  ts: string,
  hit: { rule_id: string; verdict: "block" | "ask"; mode?: "observe" | "enforce" },
  extra: Partial<LedgerEvent> = {},
): LedgerEvent {
  const [tool] = claude(preToolUse, ts);
  if (!tool) throw new Error("PreToolUse maps to a tool.called event");
  const evaluated = policyEvent(
    tool,
    {
      rule_id: hit.rule_id,
      mode: hit.mode ?? "enforce",
      verdict: hit.verdict,
      message: `Rule ${hit.rule_id} fired`,
      irreversible: hit.rule_id.startsWith("irreversible"),
    },
    { hash: HASH },
    { evaluatedAt: ts },
  );
  return { ...evaluated, ...extra };
}

/**
 * A pre-tool hook's block as the spool drain writes it: the verdict with the one-time exception
 * request (the item id the hook named and the call's fingerprint) and the rule's alternative.
 */
function exceptionBlock(
  ts: string,
  request: { id: string; fingerprint: string; rule_id?: string },
  extra: Partial<LedgerEvent> = {},
): LedgerEvent {
  const blocked = verdict(ts, { rule_id: request.rule_id ?? "guard.force_push", verdict: "block" });
  return {
    ...blocked,
    source: "hook",
    links: { item_id: request.id },
    data: {
      ...blocked.data,
      answer: "deny",
      alternative: "Push to a new branch and open a pull request.",
      exception: {
        id: request.id,
        fingerprint: request.fingerprint,
        rules: [request.rule_id ?? "guard.force_push"],
      },
    },
    ...extra,
  };
}

const requestId = (ts: string, n: number) => stableEventId(ts, `exception-request:${n}`);

const alert = (ts: string, data: Record<string, unknown>, extra: Partial<LedgerEvent> = {}) =>
  event({
    kind: "alert.raised",
    ts,
    source: "cli",
    actor: { kind: "system", id: "selfhost" },
    agent: { vendor: "claude_code" },
    data,
    ...extra,
  });

/** A person's context item proposed to the team, as the team server records it. */
const contextProposal = (ts: string, id: string) =>
  event({
    kind: "approval.requested",
    ts,
    source: "server",
    links: { item_id: id },
    data: {
      request: "context_promotion",
      item: "rule:no-secrets",
      summary: "Never print secrets.",
    },
  });

/** pr.opened as PR attribution writes it, with the risk score as an input. */
const pullRequest = (ts: string, risk: number, url = PR_URL) =>
  event({
    kind: "pr.opened",
    ts,
    source: "github",
    actor: { kind: "agent", id: "github:claude[bot]" },
    repo: "acme/api",
    agent: { vendor: "claude_code" },
    target: { type: "pr", value: url },
    links: { pr_url: url },
    data: {
      signal: "co_author_trailer",
      number: Number(url.split("/").at(-1)),
      head_ref: "agent/migration",
      risk: { score: risk, reasons: ["Touches db/migrations"] },
      files: ["db/migrations/0042_orders.sql"],
    },
  });

describe.each(BACKENDS)("review list on $name", (backend) => {
  const opened: { close(): Promise<void> }[] = [];

  afterEach(async () => {
    for (const store of opened.splice(0)) await store.close();
  });

  async function setup(toml = "") {
    const store = await backend.open();
    opened.push(store);
    let clock = new Date(NOW);
    const list = openReviewList(store.ledger, { config: config(toml), now: () => clock });
    return {
      ledger: store.ledger,
      list,
      refresh: () => refreshReviewList(store.ledger, list),
      setNow(time: string) {
        clock = new Date(time);
      },
      append: (...events: LedgerEvent[][]) => store.ledger.append(events.flat()),
    };
  }

  async function all(list: ReviewList, state?: ReviewItem["state"]): Promise<ReviewItem[]> {
    return (await list.list({ ...(state ? { state } : {}), limit: 1000 })).items;
  }

  const decisions = async (ledger: Ledger) =>
    (await ledger.query({ kind: "decision.recorded", limit: 1000 })).events;

  describe.skipIf(backend.skip)("signals", () => {
    it("builds every kind of item from a fixture signal, each valid and complete", async () => {
      const t = at(NOW, -20);
      const { list, refresh, append } = await setup();
      await append(
        claude(notification, t),
        codex(permissionRequest, t),
        idle(t),
        [verdict(t, { rule_id: "irreversible-rm", verdict: "block" }, { run_id: "run-7" })],
        [alert(t, { alert: "api_error", error: "overloaded" }, { session_id: "s-err" })],
        [alert(t, { alert: "limit_forecast", owner: PERSON, plan: "claude", window: "weekly" })],
        [
          alert(t, {
            alert: "spend_spike",
            series: { person: "ops" },
            usd: 42,
            message: "Spend spike: $42",
          }),
        ],
        [alert(t, { alert: "quality_alarm", metric: "test_pass_rate", message: "Pass rate fell" })],
        [pullRequest(t, 82)],
        [exceptionBlock(t, { id: requestId(t, 1), fingerprint: "f".repeat(64) })],
        [contextProposal(t, requestId(t, 2))],
        [
          verdict("2026-11-04T09:00:00.000Z", {
            rule_id: "no-force-push",
            verdict: "block",
            mode: "observe",
          }),
        ],
      );
      const result = await refresh();
      const items = await all(list);
      expect(new Set(items.map((item) => item.kind))).toEqual(new Set(REVIEW_ITEM_KINDS));
      expect(result).toEqual({ created: items.length, updated: 0 });
      for (const item of items) {
        const valid = validateReviewItem(item);
        expect(valid.ok ? [] : valid.errors).toEqual([]);
        expect(item.why?.signal).toBeTruthy();
        expect(item.actions).toContain("snooze");
        expect(item.delivery).toMatch(/^(instant|digest)$/);
        expect(item.route).toBeDefined();
        expect(item.source_event_ids.length).toBeGreaterThan(0);
      }
      const byKind = (kind: string) => items.filter((item) => item.kind === kind);
      expect(
        byKind("approval")
          .map((item) => item.title)
          .sort(),
      ).toEqual([
        "Claude needs your permission to use Bash",
        'Codex asks to use Bash: git add -A && git commit -m "Add request logging middleware"',
      ]);
      const [approval] = byKind("approval").filter((item) => item.agent?.vendor === "claude_code");
      expect(approval).toMatchObject({
        blocking: true,
        owners: [PERSON],
        route: { step: "owner", from: "the session's person" },
        deadline: at(t, 30),
        delivery: "instant",
        actions: ["approve", "deny", "snooze"],
        group: `session:${CLAUDE_SESSION}`,
      });
      expect(byKind("question")[0]).toMatchObject({
        blocking: true,
        actions: ["answer", "snooze"],
        title: "Claude is waiting for your input",
      });
      expect(byKind("question")[0]?.deadline).toBeUndefined();
      expect(byKind("blocked_action")[0]).toMatchObject({
        blocking: false,
        group: "run:run-7",
        owners: [PERSON],
        why: { signal: "policy.evaluated", rule_id: "irreversible-rm" },
        risk: { score: 70 },
      });
      expect(byKind("exception")[0]?.deadline).toBeUndefined();
      expect(byKind("exception")[0]).toMatchObject({
        id: requestId(t, 1),
        title:
          'Allow once: Bash: git add src/app.ts test/health.test.ts && git commit -m "Add GET /health endpoint"',
        blocking: false,
        actions: ["approve", "deny", "snooze"],
        why: {
          signal: "policy.evaluated",
          rule_id: "guard.force_push",
          text: "Rule guard.force_push fired Instead: Push to a new branch and open a pull request.",
        },
        risk: { score: 50 },
      });
      expect(byKind("stuck_run")[0]?.why?.signal).toBe("alert.raised:api_error");
      expect(byKind("budget")[0]?.why?.signal).toBe("alert.raised:limit_forecast");
      expect(byKind("spend_spike")[0]).toMatchObject({ owners: ["ops"], delivery: "instant" });
      expect(byKind("pr")[0]).toMatchObject({
        url: PR_URL,
        risk: { score: 82, reasons: ["Touches db/migrations"] },
        actions: ["approve", "deny", "snooze", "open"],
        delivery: "instant",
      });
      expect(byKind("policy_report")[0]).toMatchObject({
        title: "Observed rules would have stopped 1 tool call (2026-11-02 to 2026-11-08)",
        blocking: false,
      });
      // Not routed to the person who proposed it: an owner or admin answers it.
      expect(byKind("context_promotion")[0]).toMatchObject({
        id: requestId(t, 2),
        title: "Add rule:no-secrets to the team's context",
        blocking: false,
        owners: [],
        brief: "Never print secrets.",
        actions: ["approve", "deny", "snooze"],
      });
    });

    it("makes one item of duplicate signals and reads each signal once", async () => {
      const t = at(NOW, -10);
      const { list, refresh, append } = await setup();
      const first = claude(notification, t);
      const again = claude(notification, at(t, 1));
      const blocks = [
        verdict(t, { rule_id: "no-rm", verdict: "block" }),
        verdict(at(t, 2), { rule_id: "no-rm", verdict: "block" }),
      ];
      await append(first, again, blocks);
      expect(await refresh()).toEqual({ created: 2, updated: 2 });
      const items = await all(list);
      expect(items.map((item) => item.kind).sort()).toEqual(["approval", "blocked_action"]);
      const approval = items.find((item) => item.kind === "approval");
      expect(approval?.source_event_ids).toEqual([...first, ...again].map((e) => e.id));
      expect(approval?.deadline).toBe(at(t, 30));
      expect(await refresh()).toEqual({ created: 0, updated: 0 });
      expect(await all(list)).toEqual(items);
    });

    it("opens an exception under the id the hook named, replaced by a retry, answered once", async () => {
      const t = at(NOW, -10);
      const { ledger, list, refresh, append } = await setup();
      const first = requestId(t, 1);
      const retry = requestId(at(t, 1), 2);
      const other = requestId(at(t, 2), 3);
      await append([exceptionBlock(t, { id: first, fingerprint: "a".repeat(64) })]);
      expect(await refresh()).toEqual({ created: 1, updated: 0 });
      expect((await list.get(first))?.state).toBe("open");

      // The agent retried the same call: the hook named a new id, which replaces the open one.
      await append(
        [exceptionBlock(at(t, 1), { id: retry, fingerprint: "a".repeat(64) })],
        [
          exceptionBlock(at(t, 2), {
            id: other,
            fingerprint: "b".repeat(64),
            rule_id: "guard.secret_read",
          }),
        ],
      );
      expect(await refresh()).toEqual({ created: 2, updated: 1 });
      expect((await list.get(first))?.state).toBe("dismissed");
      expect((await all(list)).map((item) => item.id).sort()).toEqual([retry, other].sort());

      const answered = await list.decide(retry, { verdict: "approve", by: PERSON });
      expect(answered.item).toMatchObject({ kind: "exception", state: "answered" });
      expect(answered.decision_event.decision).toMatchObject({
        verdict: "approve",
        rule_id: "guard.force_push",
        item_id: retry,
      });

      // The call the exception let through is an allow: no new item.
      const used = exceptionBlock(at(t, 3), { id: retry, fingerprint: "a".repeat(64) });
      await append([
        {
          ...used,
          decision: {
            ...(used.decision as NonNullable<LedgerEvent["decision"]>),
            verdict: "allow",
          },
          data: { ...used.data, exception: { id: retry, rules: ["guard.force_push"], used: true } },
        },
      ]);
      expect(await refresh()).toEqual({ created: 0, updated: 0 });
      expect((await decisions(ledger)).map((event) => event.decision?.item_id)).toEqual([retry]);
    });

    it("groups items from the same run, else the same session", async () => {
      const t = at(NOW, -5);
      const { list, refresh, append } = await setup();
      await append(
        [verdict(t, { rule_id: "no-rm", verdict: "block" }, { run_id: "run-9" })],
        [alert(t, { alert: "run_failed", error: "exit 1" }, { run_id: "run-9" })],
        idle(t, "solo-session"),
      );
      await refresh();
      const groups = (await all(list)).map((item) => [item.kind, item.group]);
      expect(groups.sort()).toEqual([
        ["blocked_action", "run:run-9"],
        ["question", "session:solo-session"],
        ["stuck_run", "run:run-9"],
      ]);
    });

    it("blocks on a rule's ask only when it was given while the agent waited", async () => {
      const t = at(NOW, -5);
      const { list, refresh, append } = await setup();
      const live = {
        ...verdict(t, { rule_id: "ask-push", verdict: "ask" }),
        source: "hook" as const,
      };
      const later = verdict(
        at(t, 2),
        { rule_id: "ask-push", verdict: "ask" },
        { session_id: "other" },
      );
      await append(claude(notification, at(t, 1)), [live, later]);
      await refresh();
      const items = await all(list);
      expect(items.map((item) => [item.kind, item.blocking, item.deadline])).toEqual([
        ["approval", true, at(t, 30)],
        ["approval", false, undefined],
      ]);
      expect(items[0]).toMatchObject({
        title:
          'Approve Bash: git add src/app.ts test/health.test.ts && git commit -m "Add GET /health endpoint"',
        why: { signal: "policy.evaluated", rule_id: "ask-push" },
      });
      expect(items[0]?.source_event_ids).toHaveLength(2);
    });

    it("ignores PRs no agent opened and alerts that need nobody", async () => {
      const t = at(NOW, -5);
      const { list, refresh, append } = await setup();
      const { agent: _agent, ...human } = pullRequest(t, 10, "https://github.com/acme/api/pull/7");
      await append(
        [{ ...human, data: { unattributed: true } }],
        [alert(t, { alert: "usage_note" })],
      );
      expect(await refresh()).toEqual({ created: 0, updated: 0 });
      expect(await all(list)).toEqual([]);
    });
  });

  describe.skipIf(backend.skip)("waits and timeouts", () => {
    it("closes an approval or question when the session moves on before the deadline", async () => {
      const t = at(NOW, -20);
      const { ledger, list, refresh, append } = await setup();
      const answered = claude(prompt, at(t, 3));
      const ran = codex(codexToolResult, at(t, 4), {
        tool_name: "Bash",
        tool_input: { command: "git commit" },
      });
      await append(
        claude(notification, t),
        idle(t, CLAUDE_SESSION),
        codex(permissionRequest, t),
        answered,
        ran,
      );
      await refresh();
      expect(await all(list)).toEqual([]);
      const closed = await all(list, "dismissed");
      expect(closed.map((item) => item.kind).sort()).toEqual(["approval", "approval", "question"]);
      for (const item of closed) {
        expect(item.source_event_ids.at(-1)).toBe(
          item.agent?.vendor === "codex" ? ran[0]?.id : answered[0]?.id,
        );
      }
      expect(await decisions(ledger)).toEqual([]);
    });

    it("denies a blocking approval nobody answered after 30 minutes, with one decision event", async () => {
      const t = NOW;
      const { ledger, list, refresh, append, setNow } = await setup();
      await append(claude(notification, t));
      await refresh();
      const [open] = await all(list);
      expect(open?.deadline).toBe(at(t, 30));
      setNow(at(t, 29));
      await refresh();
      expect((await all(list)).map((item) => item.state)).toEqual(["open"]);

      setNow(at(t, 31));
      expect(await refresh()).toEqual({ created: 0, updated: 1 });
      const [expired] = await all(list, "expired");
      expect(expired).toMatchObject({
        id: open?.id,
        state: "expired",
        answer: { by: "selfhost", verdict: "deny", at: at(t, 30) },
      });
      const logged = await decisions(ledger);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        id: expired?.answer?.decision_event_id,
        ts: at(t, 30),
        actor: { kind: "system", id: "selfhost" },
        decision: { verdict: "deny", by: "selfhost", item_id: open?.id },
        data: { surface: "timeout", question: "Claude needs your permission to use Bash" },
      });
      expect(await refresh()).toEqual({ created: 0, updated: 0 });
      expect(await decisions(ledger)).toHaveLength(1);
      const late = await list
        .decide(open?.id ?? "", { verdict: "approve", by: PERSON })
        .catch((e) => e);
      expect(late).toBeInstanceOf(AlreadyAnsweredError);
      expect((late as AlreadyAnsweredError).item.state).toBe("expired");
      expect(await decisions(ledger)).toHaveLength(1);
    });

    it("takes the timeout from [review] approval_timeout_minutes", async () => {
      const { ledger, list, refresh, append, setNow } = await setup(
        "[review]\napproval_timeout_minutes = 5\n",
      );
      await append(codex(permissionRequest, NOW));
      await refresh();
      expect((await all(list))[0]?.deadline).toBe(at(NOW, 5));
      setNow(at(NOW, 6));
      await refresh();
      expect((await all(list, "expired"))[0]?.answer?.reason).toBe(
        "Nobody answered within 5 minutes, so the approval timed out and was denied.",
      );
      expect(await decisions(ledger)).toHaveLength(1);
    });

    it("still times out an approval whose session moved on only after the deadline", async () => {
      const { ledger, list, refresh, append, setNow } = await setup();
      await append(claude(notification, NOW), claude(prompt, at(NOW, 40)));
      setNow(at(NOW, 45));
      await refresh();
      // The prompt came after the deadline, so the agent was still waiting at 30 minutes.
      expect((await all(list, "expired")).map((item) => item.kind)).toEqual(["approval"]);
      expect(await decisions(ledger)).toHaveLength(1);
    });

    it("starts a new wait for a signal that comes after the last one ended", async () => {
      const { list, refresh, append } = await setup();
      await append(claude(notification, NOW), claude(prompt, at(NOW, 2)));
      await append(claude(notification, at(NOW, 3)));
      await refresh();
      expect((await all(list)).map((item) => item.created_at)).toEqual([at(NOW, 3)]);
      expect((await all(list, "dismissed")).map((item) => item.created_at)).toEqual([NOW]);
    });
  });

  describe.skipIf(backend.skip)("ranking", () => {
    const signals = () => {
      const t = at(NOW, -20);
      return [
        [pullRequest(at(t, 1), 82)],
        [alert(at(t, 2), { alert: "quality_alarm", metric: "a", message: "Quality a" })],
        [alert(at(t, 3), { alert: "quality_alarm", metric: "b", message: "Quality b" })],
        idle(at(t, 4)),
        claude(notification, at(t, 5)),
        [alert(at(t, 6), { alert: "spend_spike", series: { key: "k" }, message: "Spike" })],
        [verdict(at(t, 7), { rule_id: "no-rm", verdict: "block" })],
      ];
    };

    it("puts blocking items first, then higher risk, then older, then by id", async () => {
      const { list, refresh, append } = await setup();
      await append(...signals());
      await refresh();
      const items = await all(list);
      expect(items.map((item) => [item.kind, item.blocking, item.risk.score])).toEqual([
        ["approval", true, 50],
        ["question", true, 30],
        ["spend_spike", false, 90],
        ["pr", false, 82],
        ["quality", false, 60],
        ["quality", false, 60],
        ["blocked_action", false, 40],
      ]);
      expect(items.map((item) => item.title).slice(4, 6)).toEqual(["Quality a", "Quality b"]);
      const now = new Date(NOW);
      expect([...items].reverse().sort((a, b) => compareItems(a, b, now))).toEqual(items);
    });

    it("gives the same order whatever order the signals arrived in, page by page", async () => {
      const batches = signals();
      const first = await setup();
      await first.append(...batches);
      await first.refresh();
      const second = await setup();
      for (const batch of [...batches].reverse()) {
        await second.append(batch);
        await second.refresh();
      }
      const expected = (await all(first.list)).map((item) => item.id);
      expect((await all(second.list)).map((item) => item.id)).toEqual(expected);
      const paged: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await second.list.list({ limit: 2, ...(cursor ? { cursor } : {}) });
        paged.push(...page.items.map((item) => item.id));
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
      expect(paged).toEqual(expected);
    });

    it("ranks a snoozed item after the rest until the snooze ends", async () => {
      const { list, refresh, append, setNow } = await setup();
      await append(...signals());
      await refresh();
      const [top] = await all(list);
      const snoozed = await list.snooze(top?.id ?? "", { by: PERSON, until: at(NOW, 10) });
      expect(snoozed).toMatchObject({ snoozed_until: at(NOW, 10), snoozed_by: PERSON });
      expect((await all(list)).at(-1)?.id).toBe(top?.id);
      setNow(at(NOW, 11));
      expect((await all(list))[0]?.id).toBe(top?.id);
      const cleared = await list.snooze(top?.id ?? "", { by: PERSON, until: at(NOW, 1) });
      expect(cleared.snoozed_until).toBeUndefined();
    });

    it("rejects a cursor it did not hand out", async () => {
      const { list } = await setup();
      await expect(list.list({ cursor: "nope" })).rejects.toBeInstanceOf(ReviewInputError);
    });
  });

  describe.skipIf(backend.skip)("actions", () => {
    it("shows an answer from one surface on every other surface's next read", async () => {
      const { ledger, list, refresh, append } = await setup();
      await append([pullRequest(at(NOW, -5), 40)], idle(at(NOW, -5)));
      await refresh();
      const other = openReviewList(ledger, { now: () => new Date(NOW) });
      const pr = (await all(other)).find((item) => item.kind === "pr");
      if (!pr) throw new Error("expected a PR item");

      const { item, decision_event } = await list.decide(pr.id, {
        verdict: "approve",
        by: "alice@example.com",
        reason: "Migration is additive",
        surface: "cli",
      });
      expect(item).toMatchObject({
        state: "answered",
        answer: {
          by: "alice@example.com",
          verdict: "approve",
          reason: "Migration is additive",
          decision_event_id: decision_event.id,
        },
      });
      expect(decision_event).toMatchObject({
        source: "cli",
        decision: { verdict: "approve", item_id: pr.id },
        links: { pr_url: PR_URL },
        target: { type: "file", value: "db/migrations/0042_orders.sql" },
        data: { surface: "cli", question: pr.title },
      });
      expect(await other.get(pr.id)).toEqual(item);
      expect((await all(other, "answered")).map((i) => i.id)).toEqual([pr.id]);

      const second = await other
        .decide(pr.id, { verdict: "deny", by: "bob@example.com" })
        .catch((e) => e);
      expect(second).toBeInstanceOf(AlreadyAnsweredError);
      expect((second as AlreadyAnsweredError).item).toEqual(item);
      expect(await decisions(ledger)).toHaveLength(1);
    });

    it("applies a decision recorded on another path on the next refresh", async () => {
      const { ledger, list, refresh, append } = await setup();
      await append(idle(at(NOW, -5)));
      await refresh();
      const [question] = await all(list);
      const { event: decided } = await recordDecision(ledger, {
        verdict: "answer",
        by: PERSON,
        reason: "Use the staging database",
        item_id: question?.id,
        surface: "slack",
      });
      expect(await refresh()).toEqual({ created: 0, updated: 1 });
      expect(await list.get(question?.id ?? "")).toMatchObject({
        state: "answered",
        answer: {
          verdict: "answer",
          reason: "Use the staging database",
          decision_event_id: decided.id,
        },
      });
    });

    it("closes a PR item when the PR merges, and answers it from a GitHub review", async () => {
      const { list, refresh, append, ledger } = await setup();
      const merged = "https://github.com/acme/api/pull/43";
      await append([pullRequest(at(NOW, -9), 30, merged)], [pullRequest(at(NOW, -9), 30)]);
      await refresh();
      await append([
        event({
          kind: "pr.merged",
          ts: at(NOW, -2),
          source: "github",
          actor: { kind: "agent", id: "github:claude[bot]" },
          links: { pr_url: merged },
        }),
      ]);
      await recordDecision(ledger, {
        verdict: "approve",
        by: "rev@example.com",
        pr_url: PR_URL,
        surface: "github_review",
        key: "review-1",
        ts: at(NOW, -1),
      });
      await refresh();
      expect((await all(list, "dismissed")).map((item) => item.url)).toEqual([merged]);
      expect((await all(list, "answered")).map((item) => item.answer?.by)).toEqual([
        "rev@example.com",
      ]);

      // The item for a pull request: the open one, else the one opened last.
      expect((await list.pullRequest(merged))?.state).toBe("dismissed");
      const answered = await list.pullRequest(PR_URL);
      expect(answered?.state).toBe("answered");
      await append([pullRequest(at(NOW, -1), 30)]);
      await refresh();
      const reopened = await list.pullRequest(PR_URL);
      expect(reopened?.state).toBe("open");
      expect(reopened?.id).not.toBe(answered?.id);
      expect(await list.pullRequest("https://github.com/acme/api/pull/999")).toBeUndefined();
    });

    it("checks what it is given", async () => {
      const { list, refresh, append } = await setup();
      await append(idle(NOW));
      await refresh();
      const [item] = await all(list);
      const id = item?.id ?? "";
      const missing = stableEventId(NOW, "missing");
      await expect(list.decide(missing, { verdict: "approve", by: PERSON })).rejects.toBeInstanceOf(
        ReviewItemNotFoundError,
      );
      await expect(list.decide(id, { verdict: "allow" as "approve", by: PERSON })).rejects.toThrow(
        "verdict",
      );
      await expect(list.decide(id, { verdict: "approve", by: " " })).rejects.toThrow("by");
      await expect(list.snooze(id, { by: PERSON, until: "tomorrow" })).rejects.toThrow("until");
      await expect(list.snooze(missing, { by: PERSON, until: at(NOW, 5) })).rejects.toBeInstanceOf(
        ReviewItemNotFoundError,
      );
      expect(await list.get("not-a-uuid")).toBeUndefined();
    });
  });

  describe.skipIf(backend.skip)("routing and delivery", () => {
    it("routes by [review.owners], else the session's person, else the team, else the fallback", async () => {
      const { list, refresh, append } = await setup(`
[review]
fallback = ["lead@example.com"]
[review.owners]
"db/**" = ["dba@example.com"]
[teams.platform]
members = ["pat@example.com"]
`);
      const t = at(NOW, -5);
      await append(
        [pullRequest(t, 20)],
        claude(notification, t),
        [alert(t, { alert: "quality_alarm", metric: "m1" }, { team: "platform" })],
        [alert(t, { alert: "quality_alarm", metric: "m2" })],
      );
      await refresh();
      const routes = (await all(list)).map((item) => [item.kind, item.route?.step, item.owners]);
      expect(routes.sort()).toEqual([
        ["approval", "owner", [PERSON]],
        ["pr", "owner", ["dba@example.com"]],
        ["quality", "fallback", ["lead@example.com"]],
        ["quality", "team", ["pat@example.com"]],
      ]);
    });

    it("pushes instantly only when an agent is blocked or risk is high", async () => {
      const { list, refresh, append } = await setup(`
[review]
high_risk_paths = ["db/**"]
`);
      const t = at(NOW, -5);
      const onMigration = verdict(
        t,
        { rule_id: "no-db", verdict: "block" },
        {
          target: { type: "file", value: "db/migrations/0042.sql" },
          session_id: "other",
        },
      );
      await append(
        claude(notification, t),
        [alert(t, { alert: "quality_alarm", metric: "m" })],
        [verdict(t, { rule_id: "no-rm", verdict: "block" })],
        [onMigration],
      );
      await refresh();
      const delivery = (await all(list)).map((item) => [item.kind, item.risk.score, item.delivery]);
      expect(delivery).toEqual([
        ["approval", 50, "instant"],
        ["blocked_action", 70, "instant"],
        ["quality", 60, "digest"],
        ["blocked_action", 40, "digest"],
      ]);
    });

    it("escalates an item nobody answered on its route, on the clock, once per step", async () => {
      const toml = `[review]
fallback = ["lead@example.com"]
[[review.routes]]
id = "db"
kinds = ["pr"]
paths = ["db/**"]
to = ["dba@example.com"]
escalate_after_minutes = 30
[[review.routes]]
id = "db-backup"
paths = ["db/**"]
to = ["backup-dba@example.com"]
escalate_after_minutes = 60
`;
      const { list, refresh, append, setNow } = await setup(toml);
      await append([pullRequest(NOW, 40)]);
      await refresh();
      const [first] = await all(list);
      expect(first).toMatchObject({
        owners: ["dba@example.com"],
        route: {
          step: "route",
          id: "db",
          why: "kind pr, path db/migrations/0042_orders.sql",
          escalates_at: at(NOW, 30),
        },
      });

      setNow(at(NOW, 29));
      expect(await refresh()).toEqual({ created: 0, updated: 0 });
      // A later signal for the same pull request keeps the clock running.
      await append([pullRequest(at(NOW, 20), 45)]);
      setNow(at(NOW, 29.5));
      await refresh();
      expect((await all(list))[0]?.route?.escalates_at).toBe(at(NOW, 30));

      setNow(at(NOW, 31));
      expect(await refresh()).toEqual({ created: 0, updated: 1 });
      const [second] = await all(list);
      expect(second?.owners).toEqual(["backup-dba@example.com", "dba@example.com"]);
      expect(second?.route).toMatchObject({
        id: "db-backup",
        escalated_from: ["db"],
        escalates_at: at(NOW, 91),
      });
      expect(await refresh()).toEqual({ created: 0, updated: 0 });

      // A new signal does not undo an escalation.
      await append([pullRequest(at(NOW, 40), 50)]);
      setNow(at(NOW, 41));
      await refresh();
      expect((await all(list))[0]?.route?.id).toBe("db-backup");

      setNow(at(NOW, 92));
      expect(await refresh()).toEqual({ created: 0, updated: 1 });
      const [third] = await all(list);
      expect(third?.owners).toEqual([
        "lead@example.com",
        "backup-dba@example.com",
        "dba@example.com",
      ]);
      expect(third?.route).toEqual({
        step: "fallback",
        from: "[review] fallback",
        why: 'nobody answered on [[review.routes]] "db-backup"',
        escalated_from: ["db", "db-backup"],
      });
      setNow(at(NOW, 500));
      expect(await refresh()).toEqual({ created: 0, updated: 0 });
      expect(validateReviewItem(third).ok).toBe(true);
    });

    it("routes by role on a team server, and an exception only to people who may approve it", async () => {
      const { ledger, refresh } = await setup();
      await ledger.teams.createTeam({ id: "red", name: "Red" });
      await ledger.teams.setPolicy(
        "red",
        `version = 1
[[review.routes]]
id = "guards"
rule_ids = ["guard.*"]
to = ["role:member", "role:admin", "dev@example.com"]
`,
      );
      const db = databaseOf(ledger);
      for (const [id, role] of [
        ["olga@example.com", "owner"],
        ["adam@example.com", "admin"],
        ["dev@example.com", "member"],
        ["mia@example.com", "member"],
      ]) {
        await db.query("INSERT INTO people (team_id, id, role) VALUES ('red', $1, $2)", [id, role]);
      }
      const t = at(NOW, -5);
      const id = requestId(t, 1);
      await ledger.append(
        [
          exceptionBlock(
            t,
            { id, fingerprint: "f1" },
            { team: "red", actor: { kind: "person", id: PERSON } },
          ),
        ],
        { team: "red" },
      );
      await ledger.append(
        [verdict(t, { rule_id: "guard.secret_read", verdict: "block" }, { team: "red" })],
        {
          team: "red",
        },
      );
      await refresh();
      const red = openReviewList(ledger, { team: "red", now: () => new Date(NOW) });
      const items = await all(red);
      const exception = items.find((item) => item.kind === "exception");
      const blocked = items.find((item) => item.kind === "blocked_action");
      // Members may not approve another person's exception, and dev asked for it.
      expect(exception?.owners).toEqual(["adam@example.com"]);
      expect(exception?.route).toMatchObject({ step: "route", id: "guards" });
      expect(blocked?.owners).toEqual(["dev@example.com", "mia@example.com", "adam@example.com"]);
    });

    it("applies a synced decision only from someone the team lets give it", async () => {
      const { ledger } = await setup();
      await ledger.teams.createTeam({ id: "red", name: "Red" });
      const db = databaseOf(ledger);
      for (const [id, role] of [
        ["olga@example.com", "owner"],
        [PERSON, "member"],
        ["mia@example.com", "member"],
      ]) {
        await db.query("INSERT INTO people (team_id, id, role) VALUES ('red', $1, $2)", [id, role]);
      }
      const lines: string[] = [];
      const list = openReviewList(ledger, { now: () => new Date(NOW) });
      const refresh = () => refreshReviewList(ledger, list, { log: (line) => lines.push(line) });
      const t = at(NOW, -5);
      const exceptionId = requestId(t, 1);
      await ledger.append(
        [
          exceptionBlock(
            t,
            { id: exceptionId, fingerprint: "f1" },
            { team: "red", actor: { kind: "person", id: PERSON } },
          ),
          contextProposal(t, requestId(t, 2)),
        ],
        { team: "red" },
      );
      await refresh();
      /** A decision as a laptop syncs it: written with the person's token, in their team. */
      let minute = 0;
      const synced = async (actor: string, item: string, by = actor, verdict = "approve") => {
        minute += 1;
        const decided = event({
          kind: "decision.recorded",
          ts: at(NOW, minute),
          source: "cli",
          actor: { kind: "person", id: actor },
          decision: { verdict: verdict as "approve", by, item_id: item },
          links: { item_id: item },
          data: { surface: "cli" },
        });
        await ledger.append([decided], { team: "red" });
        return decided.id;
      };
      const red = openReviewList(ledger, { team: "red", now: () => new Date(NOW) });
      const state = async (id: string) => (await red.get(id))?.state;

      // The requester approves their own exception: refused, the item stays open.
      const own = await synced(PERSON, exceptionId);
      // A member writes a decision in the owner's name: refused.
      await synced(PERSON, exceptionId, "olga@example.com");
      // Another member approves it: refused, members do not approve exceptions.
      await synced("mia@example.com", exceptionId);
      // A member answers the context proposal: refused.
      await synced("mia@example.com", requestId(t, 2));
      const result = await refresh();
      expect(result.refused?.map((r) => [r.by, r.item_id])).toEqual([
        [PERSON, exceptionId],
        ["olga@example.com", exceptionId],
        ["mia@example.com", exceptionId],
        ["mia@example.com", requestId(t, 2)],
      ]);
      expect(result.refused?.[0]?.event_id).toBe(own);
      expect(result.refused?.[0]?.reason).toMatch(/your own agent asked for/);
      expect(result.refused?.[1]?.reason).toMatch(/a person decides only as themselves/);
      expect(result.refused?.[2]?.reason).toMatch(/owner or admin role in team red/);
      expect(lines).toHaveLength(4);
      expect(await state(exceptionId)).toBe("open");
      expect(await state(requestId(t, 2))).toBe("open");

      // The owner approves both.
      await synced("olga@example.com", exceptionId);
      await synced("olga@example.com", requestId(t, 2));
      const after = await refresh();
      expect(after.refused).toBeUndefined();
      expect((await red.get(exceptionId))?.answer).toMatchObject({
        by: "olga@example.com",
        verdict: "approve",
      });
      expect(await state(requestId(t, 2))).toBe("answered");
    });

    it("lets the requester approve their own exception when the team allows it", async () => {
      const { ledger } = await setup();
      await ledger.teams.createTeam({ id: "red", name: "Red" });
      await ledger.teams.setPolicy(
        "red",
        "version = 1\n[review]\nself_approve_exceptions = true\n",
      );
      await databaseOf(ledger).query(
        "INSERT INTO people (team_id, id, role) VALUES ('red', $1, 'member')",
        [PERSON],
      );
      const list = openReviewList(ledger, { now: () => new Date(NOW) });
      const t = at(NOW, -5);
      const id = requestId(t, 1);
      await ledger.append(
        [
          exceptionBlock(
            t,
            { id, fingerprint: "f1" },
            { team: "red", actor: { kind: "person", id: PERSON } },
          ),
        ],
        { team: "red" },
      );
      await refreshReviewList(ledger, list);
      const decided = event({
        kind: "decision.recorded",
        ts: at(NOW, 1),
        source: "cli",
        decision: { verdict: "approve", by: PERSON, item_id: id },
        links: { item_id: id },
      });
      await ledger.append([decided], { team: "red" });
      expect((await refreshReviewList(ledger, list)).refused).toBeUndefined();
      expect((await list.get(id))?.state).toBe("answered");
    });

    it("keeps each team's items to its own list and uses the team's stored policy", async () => {
      const { ledger, refresh } = await setup();
      await ledger.teams.createTeam({ id: "red", name: "Red" });
      await ledger.teams.setPolicy(
        "red",
        'version = 1\n[teams.red]\nmembers = ["rita@example.com"]\n',
      );
      const t = at(NOW, -5);
      await ledger.append([alert(t, { alert: "quality_alarm", metric: "r" }, { team: "red" })], {
        team: "red",
      });
      await ledger.append([alert(t, { alert: "quality_alarm", metric: "b" }, { team: "blue" })], {
        team: "blue",
      });
      await refresh();
      const red = openReviewList(ledger, { team: "red", now: () => new Date(NOW) });
      const blue = openReviewList(ledger, { team: "blue", now: () => new Date(NOW) });
      const [redItem] = await all(red);
      const [blueItem] = await all(blue);
      expect((await all(red)).map((item) => item.owners)).toEqual([["rita@example.com"]]);
      expect((await all(blue)).map((item) => item.route?.step)).toEqual(["none"]);
      expect(await red.get(blueItem?.id ?? "")).toBeUndefined();
      await expect(
        red.decide(blueItem?.id ?? "", { verdict: "approve", by: "rita@example.com" }),
      ).rejects.toBeInstanceOf(ReviewItemNotFoundError);
      expect(
        (await red.decide(redItem?.id ?? "", { verdict: "approve", by: "rita@example.com" })).item
          .state,
      ).toBe("answered");
    });
  });
});

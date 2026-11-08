import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Ledger } from "@selfhost/ledger";
import { openReviewList, refreshReviewList } from "@selfhost/review";
import {
  type ActiveOnFileResponse,
  type DecisionResponse,
  type DecisionsPage,
  EVENT_SCHEMA,
  type EventsPage,
  type FileRunsResponse,
  type LedgerEvent,
  MCP_LIMIT_DEFAULT,
  MCP_RESPONSE_TOKEN_BUDGET,
  type McpItemStatus,
  type PolicyResponse,
  type ReviewItemsPage,
} from "@selfhost/schema";
import contract from "@selfhost/schema/mcp-tools.json" with { type: "json" };
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "../src/index.js";
import {
  call,
  connect,
  ME,
  memoryLedger,
  OTHER,
  soloData,
  strictPolicy,
  T0,
  toolCall,
} from "./helpers.js";

/**
 * The MCP tools over the protocol: an SDK client against the server on an in-memory transport,
 * on a laptop's ledger. The team server's permissions are covered in apps/server, stdio in
 * apps/cli.
 */

let ledger: Ledger;
let client: Client;

beforeEach(async () => {
  ledger = await memoryLedger();
  client = await connect(soloData(ledger));
});

afterEach(async () => {
  await client.close();
  await ledger.close();
});

/** A policy.evaluated block carrying a one-time exception request, as the hook spool maps it. */
function blocked(id: string, fingerprint = "f".repeat(64)): LedgerEvent {
  const ts = new Date(T0.getTime() - 60_000).toISOString();
  return {
    id: uuidv7(new Date(ts)),
    schema: EVENT_SCHEMA,
    ts,
    source: "hook",
    kind: "policy.evaluated",
    actor: { kind: "system", id: "selfhost-policy" },
    agent: { vendor: "claude_code" },
    session_id: "sess-1",
    tool: { name: "Bash", input_summary: "git push --force origin main" },
    target: { type: "command", value: "git push --force origin main" },
    decision: {
      verdict: "block",
      by: "selfhost-policy",
      rule_id: "no-force-push",
      mode: "enforce",
    },
    links: { item_id: id },
    data: { exception: { id, fingerprint, rules: ["no-force-push"] } },
  };
}

function pullRequest(): LedgerEvent {
  const ts = new Date(T0.getTime() - 30_000);
  return {
    id: uuidv7(ts),
    schema: EVENT_SCHEMA,
    ts: ts.toISOString(),
    source: "github",
    kind: "pr.opened",
    actor: { kind: "agent", id: "claude" },
    agent: { vendor: "claude_code" },
    repo: "acme/api",
    links: { pr_url: "https://github.com/acme/api/pull/7" },
    data: { title: "Add rate limits", risk_score: 20 },
  };
}

async function refresh() {
  await refreshReviewList(ledger, openReviewList(ledger, { now: () => T0 }));
}

describe("tools/list", () => {
  it("serves the tools of mcp-tools.json with their schemas and read-only hints", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(contract.tools.map((tool) => tool.name));
    const ask = tools.find((tool) => tool.name === "ask_human");
    expect(ask?.annotations?.readOnlyHint).toBe(false);
    expect(ask?.inputSchema.required).toEqual(["question"]);
    expect(tools.find((tool) => tool.name === "get_policy")?.annotations?.readOnlyHint).toBe(true);
  });

  it("answers an unknown tool with a protocol error", async () => {
    await expect(client.callTool({ name: "drop_ledger", arguments: {} })).rejects.toThrow(
      /Unknown tool/,
    );
  });

  it("answers a bad input with invalid_request and no data", async () => {
    const { error } = await call(client, "search_events", { limit: 5000 });
    expect(error?.code).toBe("invalid_request");
    const missing = await call(client, "list_file_runs", {});
    expect(missing.error?.code).toBe("invalid_request");
    expect(missing.error?.message).toMatch(/path/);
  });
});

describe("get_policy", () => {
  it("leaves out the text and config.rules unless full is set", async () => {
    const { result } = await call<PolicyResponse>(client, "get_policy");
    expect(result.text).toBeUndefined();
    expect(result.config.rules).toBeUndefined();
    expect(result.effective_rules.length).toBe(strictPolicy().effective_rules.length);
    const full = await call<PolicyResponse>(client, "get_policy", { full: true });
    expect(full.result.text).toContain("[[rules]]");
    expect(full.result.config.rules?.length).toBeGreaterThan(0);
  });
});

describe("get_budget", () => {
  it("returns what is left", async () => {
    const { result } = await call(client, "get_budget", { period: "month" });
    expect(result).toMatchObject({ remaining_usd: 379.5, limit_usd: 500 });
  });
});

describe("file history", () => {
  beforeEach(async () => {
    await ledger.append([
      toolCall({ path: "src/app.ts", session: "a", minutesAgo: 300, tool: "Read" }),
      toolCall({ path: "src/app.ts", session: "a", minutesAgo: 290 }),
      toolCall({ path: "/Users/dev/acme/src/app.ts", session: "b", minutesAgo: 30 }),
      toolCall({ path: "src/app.ts", session: "c", person: OTHER, minutesAgo: 5 }),
      toolCall({ path: "src/other.ts", session: "c", person: OTHER, minutesAgo: 4 }),
    ]);
  });

  it("list_file_runs groups the calls on a file by run, newest first", async () => {
    const { result } = await call<FileRunsResponse>(client, "list_file_runs", {
      path: "src/app.ts",
    });
    expect(result.runs.map((run) => [run.session_id, run.person, run.calls])).toEqual([
      ["c", OTHER, 1],
      ["b", ME, 1],
      ["a", ME, 2],
    ]);
    expect(result.runs[2]?.tools).toEqual(["Edit", "Read"]);
    expect(result.more).toBe(false);
  });

  it("matches a folder and narrows by time", async () => {
    const { result } = await call<FileRunsResponse>(client, "list_file_runs", {
      path: "src",
      since: new Date(T0.getTime() - 60 * 60_000).toISOString(),
    });
    expect(result.runs.map((run) => run.session_id)).toEqual(["c", "b"]);
  });

  it("list_active_on_file shows who else works on it now, and marks your own sessions", async () => {
    const { result } = await call<ActiveOnFileResponse>(client, "list_active_on_file", {
      path: "src/app.ts",
    });
    expect(result.since).toBe(new Date(T0.getTime() - 120 * 60_000).toISOString());
    expect(result.sessions.map((s) => [s.person, s.you, s.session_id])).toEqual([
      [OTHER, false, "c"],
      [ME, true, "b"],
    ]);
  });
});

describe("ask_human and get_answer", () => {
  it("opens a question at once and returns the person's answer", async () => {
    const asked = await call<McpItemStatus>(client, "ask_human", {
      question: "Should the retry limit be 3 or 5?",
      context: "3 is the old default; 5 matches the gateway.",
      paths: ["src/retry.ts"],
    });
    expect(asked.result).toMatchObject({
      kind: "question",
      state: "open",
      blocking: true,
      owners: [ME],
      title: "Should the retry limit be 3 or 5?",
    });
    const id = asked.result.item_id;
    const item = await openReviewList(ledger).get(id);
    expect(item?.brief).toBe("3 is the old default; 5 matches the gateway.");
    expect(item?.agent?.vendor).toBe("claude_code");

    const open = await call<McpItemStatus>(client, "get_answer", { item_id: id });
    expect(open.result.state).toBe("open");
    expect(open.result.next).toMatch(/wait_seconds/);

    await openReviewList(ledger, { now: () => T0 }).decide(id, {
      verdict: "answer",
      by: ME,
      reason: "5, to match the gateway.",
    });
    const answered = await call<McpItemStatus>(client, "get_answer", { item_id: id });
    expect(answered.result).toMatchObject({
      state: "answered",
      answer: { verdict: "answer", by: ME, reason: "5, to match the gateway." },
    });

    // The answer is precedent: by topic and by path.
    const byTopic = await call<DecisionsPage>(client, "search_decisions", { topic: "retry limit" });
    expect(byTopic.result.decisions.map((event) => event.decision?.reason)).toEqual([
      "5, to match the gateway.",
    ]);
    const byPath = await call<DecisionsPage>(client, "search_decisions", { path: "src" });
    expect(byPath.result.decisions).toHaveLength(1);
  });

  it("waits with wait_seconds, polling until the answer comes", async () => {
    let polls = 0;
    const data = soloData(ledger);
    const waiting = await connect({
      ...data,
      async item(id) {
        polls += 1;
        if (polls === 3) {
          await openReviewList(ledger, { now: () => T0 }).decide(id, {
            verdict: "answer",
            by: ME,
            reason: "yes",
          });
        }
        return data.item(id);
      },
    });
    const asked = await call<McpItemStatus>(waiting, "ask_human", { question: "Ship it?" });
    const { result } = await call<McpItemStatus>(waiting, "get_answer", {
      item_id: asked.result.item_id,
      wait_seconds: 30,
    });
    expect(result.state).toBe("answered");
    expect(polls).toBe(3);
    await waiting.close();
  });

  it("refuses wait_seconds past the limit", async () => {
    const { error } = await call(client, "get_answer", { item_id: uuidv7(T0), wait_seconds: 600 });
    expect(error?.code).toBe("invalid_request");
  });

  it("answers not_found for an item that does not exist", async () => {
    const { error } = await call(client, "get_answer", { item_id: uuidv7(T0) });
    expect(error?.code).toBe("not_found");
  });
});

describe("request_exception", () => {
  it("adds the agent's reason to the item the block opened and marks it blocking", async () => {
    const id = uuidv7(T0);
    await ledger.append([blocked(id)]);
    await refresh();
    const { result } = await call<McpItemStatus>(client, "request_exception", {
      exception_id: id,
      reason: "The branch is mine alone and the rebase must replace it.",
    });
    expect(result).toMatchObject({ item_id: id, kind: "exception", state: "open", blocking: true });
    const item = await openReviewList(ledger).get(id);
    expect(item?.brief).toBe(
      "Claude Code asks for this exception: The branch is mine alone and the rebase must replace it.",
    );
    expect(item?.title).toMatch(/^Allow once: Bash: git push --force/);

    await openReviewList(ledger, { now: () => T0 }).decide(id, { verdict: "approve", by: ME });
    const approved = await call<McpItemStatus>(client, "get_answer", { item_id: id });
    expect(approved.result.answer?.verdict).toBe("approve");
    // No grant on this data: the next step says where it comes from.
    expect(approved.result.next).toMatch(/next selfhost sync/);
  });

  it("refuses an id that names no exception", async () => {
    const missing = await call(client, "request_exception", {
      exception_id: uuidv7(T0),
      reason: "needed",
    });
    expect(missing.error?.code).toBe("not_found");
    const asked = await call<McpItemStatus>(client, "ask_human", { question: "Which port?" });
    const question = await call(client, "request_exception", {
      exception_id: asked.result.item_id,
      reason: "needed",
    });
    expect(question.error?.code).toBe("invalid_request");
  });
});

describe("record_decision", () => {
  it("records the person's decision on a pull request item", async () => {
    await ledger.append([pullRequest()]);
    await refresh();
    const page = await call<ReviewItemsPage>(client, "list_review_items", { mine: false });
    const pr = page.result.items.find((item) => item.kind === "pr");
    expect(pr).toBeDefined();
    const { result } = await call<DecisionResponse>(client, "record_decision", {
      item_id: pr?.id,
      verdict: "approve",
      reason: "Read it with them.",
    });
    expect(result.item.state).toBe("answered");
    expect(result.decision_event.data?.surface).toBe("mcp");
  });

  it("refuses items an agent waits on, so an agent never approves its own request", async () => {
    const id = uuidv7(T0);
    await ledger.append([blocked(id)]);
    await refresh();
    const exception = await call(client, "record_decision", { item_id: id, verdict: "approve" });
    expect(exception.error?.code).toBe("forbidden");
    const asked = await call<McpItemStatus>(client, "ask_human", { question: "Deploy now?" });
    const question = await call(client, "record_decision", {
      item_id: asked.result.item_id,
      verdict: "answer",
      reason: "yes",
    });
    expect(question.error?.code).toBe("forbidden");
    const item = await openReviewList(ledger).get(asked.result.item_id);
    expect(item?.state).toBe("open");
  });
});

describe("list_review_items", () => {
  it("lists your own items by default, every item with mine false", async () => {
    await call(client, "ask_human", { question: "Mine?" });
    await ledger.append([pullRequest()]);
    await refresh();
    const mine = await call<ReviewItemsPage>(client, "list_review_items");
    expect(mine.result.items.map((item) => item.title)).toEqual(["Mine?"]);
    const all = await call<ReviewItemsPage>(client, "list_review_items", { mine: false });
    expect(all.result.items.map((item) => item.kind).sort()).toEqual(["pr", "question"]);
  });
});

describe("token budget", () => {
  const long = (n: number) => "lorem ipsum dolor sit amet ".repeat(n).trim();

  /** A busy ledger: big events, many items with long briefs, long decisions. */
  async function seed() {
    const events: LedgerEvent[] = [];
    for (let i = 0; i < 300; i++) {
      events.push(
        toolCall({
          path: `src/module-${i % 7}/file.ts`,
          session: `sess-${i % 40}`,
          person: i % 3 ? ME : OTHER,
          minutesAgo: i,
          summary: long(20),
          repo: "acme/api",
        }),
      );
    }
    await ledger.append(events);
    for (let i = 0; i < 25; i++) {
      await call(client, "ask_human", {
        question: `Question ${i}: ${long(15)}`,
        context: long(140),
        paths: [`src/module-${i % 7}/file.ts`],
      });
    }
    const list = openReviewList(ledger, { now: () => T0 });
    const page = await list.list({ limit: 20 });
    for (const item of page.items) {
      await list.decide(item.id, { verdict: "answer", by: ME, reason: long(60) });
    }
  }

  it(`keeps every read tool's default answer under ${MCP_RESPONSE_TOKEN_BUDGET} tokens`, async () => {
    await seed();
    const defaults: [string, Record<string, unknown>][] = [
      ["get_policy", {}],
      ["get_budget", {}],
      ["list_review_items", {}],
      ["list_review_items", { mine: false, state: "answered" }],
      ["search_events", {}],
      ["search_decisions", {}],
      ["list_file_runs", { path: "src" }],
      ["list_active_on_file", { path: "src" }],
    ];
    for (const [name, args] of defaults) {
      const { tokens, error } = await call(client, name, args);
      expect(error, name).toBeUndefined();
      expect(tokens, `${name} ${JSON.stringify(args)}`).toBeLessThanOrEqual(
        MCP_RESPONSE_TOKEN_BUDGET,
      );
    }
    const calls = await call<EventsPage>(client, "search_events", { kind: "tool.called" });
    expect(calls.result.events).toHaveLength(MCP_LIMIT_DEFAULT);
    expect(calls.result.next_cursor).not.toBeNull();
    // The newest events carry 4,000-character questions: fewer of them fit, with a cursor on.
    const events = await call<EventsPage>(client, "search_events");
    expect(events.result.events.length).toBeLessThan(MCP_LIMIT_DEFAULT);
    expect(events.result.next_cursor).not.toBeNull();
    const runs = await call<FileRunsResponse>(client, "list_file_runs", { path: "src" });
    expect(runs.result.runs).toHaveLength(MCP_LIMIT_DEFAULT);
  });

  it("returns a shorter page with a cursor when the asked-for page would go over", async () => {
    await seed();
    const { result, tokens } = await call<ReviewItemsPage>(client, "list_review_items", {
      mine: false,
      state: "answered",
      full: true,
      limit: 50,
    });
    expect(tokens).toBeLessThanOrEqual(MCP_RESPONSE_TOKEN_BUDGET);
    expect(result.items.length).toBeLessThan(20);
    expect(result.next_cursor).not.toBeNull();
  });
});

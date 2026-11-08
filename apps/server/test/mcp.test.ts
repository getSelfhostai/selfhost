import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Ledger } from "@selfhost/ledger";
import { CLIENT_HEADER, uuidv7 } from "@selfhost/mcp";
import { openReviewList, refreshReviewList } from "@selfhost/review";
import {
  type BudgetResponse,
  type CreateTeamResponse,
  type DecisionsPage,
  EVENT_SCHEMA,
  type FileRunsResponse,
  type JoinResponse,
  type LedgerEvent,
  MCP_RESPONSE_TOKEN_BUDGET,
  type McpItemStatus,
  type PolicyResponse,
  type ReviewItemsPage,
} from "@selfhost/schema";
import contract from "@selfhost/schema/mcp-tools.json" with { type: "json" };
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { BACKENDS, caller, TOKEN } from "./helpers.js";

/**
 * The agent MCP server over Streamable HTTP at /v1/mcp: an SDK client against the app, with
 * person tokens of two teams of one org. Every call acts as the token's person; a team, repo or
 * item outside their teams answers forbidden with no data.
 */

const ADA = "ada@example.com";
const DAN = "dan@example.com";

const WEB_POLICY = `version = 1

[budget]
monthly_usd = 200

[[rules]]
id = "no-curl"
mode = "enforce"
match = { command = '\\bcurl\\b' }
action = "block"
message = "Agents do not call curl."
alternative = "Use src/http.ts."
`;

/** An SDK client on /v1/mcp; it names its agent the way `selfhost mcp` does in team mode. */
async function connect(app: Hono, token: string, name = "claude-code"): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("http://selfhost.test/v1/mcp"), {
    requestInit: {
      headers: { authorization: `Bearer ${token}`, [CLIENT_HEADER]: `${name}/2.1.0` },
    },
    fetch: async (url, init) => app.request(String(url), init),
  });
  const client = new Client({ name, version: "2.1.0" });
  await client.connect(transport);
  return client;
}

async function call<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ result: T; error?: { code: string; message: string }; text: string }> {
  const response = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const [first] = response.content;
  const text = first?.type === "text" ? first.text : "";
  if (response.isError) return { result: {} as T, error: JSON.parse(text).error, text };
  return { result: response.structuredContent as T, text };
}

function toolCall(person: string, path: string, session: string): LedgerEvent {
  const ts = new Date(Date.now() - 60_000);
  return {
    id: uuidv7(ts),
    schema: EVENT_SCHEMA,
    ts: ts.toISOString(),
    source: "hook",
    kind: "tool.called",
    actor: { kind: "person", id: person },
    agent: { vendor: "codex" },
    session_id: session,
    tool: { name: "apply_patch", input_summary: path },
    target: { type: "file", value: path },
  };
}

function blocked(id: string): LedgerEvent {
  const ts = new Date(Date.now() - 30_000);
  return {
    id: uuidv7(ts),
    schema: EVENT_SCHEMA,
    ts: ts.toISOString(),
    source: "hook",
    kind: "policy.evaluated",
    actor: { kind: "system", id: "selfhost-policy" },
    session_id: "dan-1",
    tool: { name: "Bash", input_summary: "curl https://example.com" },
    target: { type: "command", value: "curl https://example.com" },
    decision: { verdict: "block", by: "selfhost-policy", rule_id: "no-curl", mode: "enforce" },
    links: { item_id: id },
    data: { exception: { id, fingerprint: "a".repeat(64), rules: ["no-curl"] } },
  };
}

describe.each(BACKENDS)("MCP over HTTP on $name", (backend) => {
  let store: { ledger: Ledger; close(): Promise<void> };
  let app: Hono;
  let ada: Client;
  let dan: Client;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    if (backend.skip) return;
    store = await backend.open();
    app = createApp({ version: "test", ledger: store.ledger, token: TOKEN });
    const admin = caller(app, TOKEN);
    expect((await admin("/v1/orgs", "POST", { name: "Acme" })).status).toBe(201);
    for (const [team, person] of [
      ["Web", ADA],
      ["Data", DAN],
    ] as const) {
      const created = (await (
        await admin("/v1/teams", "POST", { name: team, org: "acme" })
      ).json()) as CreateTeamResponse;
      const joined = await app.request("/v1/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invite: created.invite, person }),
      });
      tokens[person] = ((await joined.json()) as JoinResponse).token;
    }
    expect((await admin("/v1/policy?team=web", "PUT", { text: WEB_POLICY })).status).toBe(200);
    expect((await admin("/v1/policy?team=data", "PUT", { text: "version = 1\n" })).status).toBe(
      200,
    );
    expect((await admin("/v1/teams/web/repos", "POST", { remote: "acme/web-app" })).status).toBe(
      201,
    );
    expect((await admin("/v1/teams/data/repos", "POST", { remote: "acme/pipe" })).status).toBe(201);
    // Both teams worked on the same path; each person sees only their own team's runs.
    for (const [person, session] of [
      [ADA, "ada-1"],
      [DAN, "dan-1"],
    ] as const) {
      const push = caller(app, tokens[person] ?? "");
      const res = await push("/v1/events", "POST", {
        events: [toolCall(person, "src/app.ts", session)],
      });
      expect(res.status).toBe(200);
    }
    ada = await connect(app, tokens[ADA] ?? "");
    dan = await connect(app, tokens[DAN] ?? "", "codex-mcp-client");
  });

  afterAll(async () => {
    await ada?.close();
    await dan?.close();
    await store?.close();
  });

  it.skipIf(backend.skip)("needs a token, and a person token rather than the admin's", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = { "content-type": "application/json", accept: "application/json" };
    const none = await app.request("/v1/mcp", { method: "POST", headers, body });
    expect(none.status).toBe(401);
    const asAdmin = await app.request("/v1/mcp", {
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${TOKEN}` },
      body,
    });
    expect(asAdmin.status).toBe(403);
    expect(await asAdmin.text()).toMatch(/person token/);
    const get = await caller(app, tokens[ADA] ?? "")("/v1/mcp");
    expect(get.status).toBe(405);
  });

  it.skipIf(backend.skip)("lists the contract's tools", async () => {
    const { tools } = await ada.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(contract.tools.map((tool) => tool.name));
  });

  it.skipIf(backend.skip)("reads the policy and budget of the person's own team", async () => {
    const policy = await call<PolicyResponse>(ada, "get_policy");
    expect(policy.result.team).toBe("web");
    expect(policy.result.effective_rules.map((rule) => rule.id)).toEqual(["no-curl"]);
    const byRepo = await call<PolicyResponse>(ada, "get_policy", { repo: "acme/web-app" });
    expect(byRepo.result).toMatchObject({ team: "web", repo: "acme/web-app" });
    const budget = await call<BudgetResponse>(ada, "get_budget");
    expect(budget.result).toMatchObject({ limit_usd: 200, remaining_usd: 200 });
  });

  it.skipIf(backend.skip)(
    "answers forbidden with no data for a team or repo outside the person's",
    async () => {
      const refusals: [string, Record<string, unknown>][] = [
        ["get_policy", { repo: "acme/pipe" }],
        ["get_policy", { repo: "acme/nobody" }],
        ["get_policy", { team: "data" }],
        ["get_budget", { team: "data" }],
        ["list_review_items", { team: "data" }],
        ["search_events", { team: "data" }],
        ["search_decisions", { team: "data" }],
        ["list_file_runs", { path: "src/app.ts", team: "data" }],
        ["list_active_on_file", { path: "src/app.ts", team: "data" }],
      ];
      for (const [name, args] of refusals) {
        const { error, text } = await call(ada, name, args);
        expect(error?.code, `${name} ${JSON.stringify(args)}`).toBe("forbidden");
        expect(text).not.toContain(DAN);
      }
    },
  );

  it.skipIf(backend.skip)("limits file history to the person's teams", async () => {
    const own = await call<FileRunsResponse>(ada, "list_file_runs", { path: "src/app.ts" });
    expect(own.result.runs.map((run) => [run.person, run.session_id])).toEqual([[ADA, "ada-1"]]);
    const theirs = await call<FileRunsResponse>(dan, "list_file_runs", { path: "src/app.ts" });
    expect(theirs.result.runs.map((run) => run.person)).toEqual([DAN]);
  });

  it.skipIf(backend.skip)(
    "asks a person, keeps the item from other teams, and returns the answer",
    async () => {
      const asked = await call<McpItemStatus>(ada, "ask_human", {
        question: "May the cache TTL drop to 30 seconds?",
        repo: "acme/web-app",
      });
      expect(asked.result).toMatchObject({ kind: "question", state: "open", owners: [ADA] });
      const id = asked.result.item_id;

      const peek = await call(dan, "get_answer", { item_id: id });
      expect(peek.error?.code).toBe("forbidden");
      expect(peek.text).not.toContain("cache TTL");
      const theirs = await call<ReviewItemsPage>(dan, "list_review_items", { mine: false });
      expect(theirs.result.items).toEqual([]);
      const mine = await call<ReviewItemsPage>(ada, "list_review_items");
      expect(mine.result.items.map((item) => item.id)).toEqual([id]);

      // An agent cannot answer it for the person.
      const self = await call(ada, "record_decision", {
        item_id: id,
        verdict: "answer",
        reason: "yes",
      });
      expect(self.error?.code).toBe("forbidden");

      const answered = await caller(app, tokens[ADA] ?? "")(
        `/v1/review-items/${id}/decision`,
        "POST",
        { verdict: "answer", reason: "Yes, 30 seconds is fine." },
      );
      expect(answered.status).toBe(200);
      const { result } = await call<McpItemStatus>(ada, "get_answer", { item_id: id });
      expect(result).toMatchObject({
        state: "answered",
        answer: { verdict: "answer", by: ADA, reason: "Yes, 30 seconds is fine." },
      });

      const decisions = await call<DecisionsPage>(ada, "search_decisions", { topic: "cache ttl" });
      expect(decisions.result.decisions).toHaveLength(1);
      const elsewhere = await call<DecisionsPage>(dan, "search_decisions", { topic: "cache ttl" });
      expect(elsewhere.result.decisions).toEqual([]);
    },
  );

  it.skipIf(backend.skip)(
    "takes an exception request only from the blocked call's team",
    async () => {
      const id = uuidv7(new Date());
      await store.ledger.append([blocked(id)], { team: "data" });
      await refreshReviewList(store.ledger, openReviewList(store.ledger));

      const outsider = await call(ada, "request_exception", { exception_id: id, reason: "please" });
      expect(outsider.error?.code).toBe("forbidden");

      const { result } = await call<McpItemStatus>(dan, "request_exception", {
        exception_id: id,
        reason: "The health check must reach the vendor's status page.",
      });
      expect(result).toMatchObject({ item_id: id, kind: "exception", blocking: true });
      const item = await openReviewList(store.ledger, { team: "data" }).get(id);
      expect(item?.brief).toBe(
        "Codex asks for this exception: The health check must reach the vendor's status page.",
      );
      expect(result.next).toMatch(/get_answer/);
    },
  );

  it.skipIf(backend.skip)("keeps default answers under the token budget", async () => {
    for (const [name, args] of [
      ["get_policy", {}],
      ["get_budget", {}],
      ["list_review_items", {}],
      ["search_events", {}],
      ["search_decisions", {}],
      ["list_file_runs", { path: "src" }],
      ["list_active_on_file", { path: "src" }],
    ] as const) {
      const { text, error } = await call(ada, name, args);
      expect(error, name).toBeUndefined();
      expect(text.length / 3, name).toBeLessThanOrEqual(MCP_RESPONSE_TOKEN_BUDGET);
    }
  });
});

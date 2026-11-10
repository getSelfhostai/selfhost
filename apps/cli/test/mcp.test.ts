import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { openLedger } from "@selfhost/ledger";
import { uuidv7 } from "@selfhost/mcp";
import { openReviewList, refreshReviewList } from "@selfhost/review";
import {
  type BudgetResponse,
  type CreateTeamResponse,
  EVENT_SCHEMA,
  type JoinResponse,
  type McpItemStatus,
  type PolicyResponse,
  type ReviewItemsPage,
} from "@selfhost/schema";
import contract from "@selfhost/schema/mcp-tools.json" with { type: "json" };
import { createApp } from "@selfhost/server/app";
import { afterEach, describe, expect, it } from "vitest";
import { checkPreToolCall } from "../src/hooks/pretool.js";
import { runHook } from "../src/hooks/receive.js";
import { runImport } from "../src/import.js";
import { inboxPaths, writeInboxCache } from "../src/inbox/store.js";
import { mcpServer } from "../src/mcp/commands.js";
import { spendSnapshotPath, writeSpendSnapshot } from "../src/mcp/spend.js";
import { saveMembership } from "../src/team/config.js";
import { run, tempDir } from "./run.js";

/**
 * `selfhost mcp` from an agent's side: an SDK client on stdio against the real command, solo on
 * this machine's ledger, and in team mode through the proxy to a team server. Every machine is a
 * temporary HOME; nothing here reads or writes the real ~/.selfhost or any agent's config.
 */

const PERSON = "dev@example.com";
const POLICY = `version = 1

[budget]
monthly_usd = 50

[[rules]]
id = "no-curl"
mode = "enforce"
match = { command = '\\bcurl\\b' }
action = "block"
message = "Agents do not call curl."
alternative = "Use the HTTP client in src/http.ts."
`;
const CLI = join(import.meta.dirname, "..");
const ID = /selfhost inbox approve ([0-9a-f-]{36})/;

function machine() {
  const workspace = tempDir("mcp-ws");
  workspace.write(".git/HEAD", "ref: refs/heads/main\n");
  workspace.write("selfhost.toml", POLICY);
  const home = tempDir("mcp-home");
  return {
    workspace,
    home,
    dataDir: home.path(".selfhost", "data"),
    configPath: home.path(".selfhost", "config.json"),
  };
}

type Machine = ReturnType<typeof machine>;

/** The hook blocks a curl call in the workspace; returns the exception id it names. */
async function blockCurl(m: Machine): Promise<string> {
  let stdout = "";
  await runHook(["claude"], {
    env: { HOME: m.home.root },
    readStdin: async () =>
      JSON.stringify({
        session_id: "sess-1",
        cwd: m.workspace.root,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "curl https://example.com/status" },
        tool_use_id: "toolu_1",
      }),
    writeOutput: (text) => {
      stdout += text;
    },
    writeError: () => {},
    checkPreTool: (name, body, io) => checkPreToolCall(name, body, io, { checkers: [] }),
  });
  const id = ID.exec(stdout)?.[1];
  if (!id) throw new Error(`the hook named no exception: ${stdout}`);
  return id;
}

const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

/** The real `selfhost mcp` on stdio, started in the workspace as an agent starts it. */
async function stdio(m: Machine): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", import.meta.resolve("tsx"), join(CLI, "src", "main.ts"), "mcp"],
    cwd: m.workspace.root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: m.home.root,
      SELFHOST_DATA_DIR: m.dataDir,
      SELFHOST_PERSON: PERSON,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "claude-code", version: "2.1.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const [first] = response.content;
  const text = first?.type === "text" ? first.text : "";
  if (response.isError) {
    return { result: {} as T, error: JSON.parse(text).error as { code: string; message: string } };
  }
  return { result: response.structuredContent as T, error: undefined };
}

/** Opens the machine's embedded ledger between two tool calls, as `selfhost inbox` does. */
async function withLedger<T>(
  m: Machine,
  fn: (ledger: Awaited<ReturnType<typeof openLedger>>) => Promise<T>,
) {
  const ledger = await openLedger({ dataDir: m.dataDir });
  try {
    return await fn(ledger);
  } finally {
    await ledger.close();
  }
}

describe("selfhost mcp on stdio, solo", () => {
  it("serves the tools on this machine's ledger and policy", async () => {
    const m = machine();
    const client = await stdio(m);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(contract.tools.map((tool) => tool.name));

    const policy = await call<PolicyResponse>(client, "get_policy");
    expect(policy.result.effective_rules.map((rule) => rule.id)).toEqual(["no-curl"]);
    expect(policy.result.text).toBeUndefined();
    const budget = await call<BudgetResponse>(client, "get_budget");
    expect(budget.result).toMatchObject({ limit_usd: 50, spent_usd: 0, remaining_usd: 50 });
    const elsewhere = await call(client, "get_policy", { repo: "acme/other" });
    expect(elsewhere.error?.code).toBe("not_found");
  }, 60_000);

  it("asks a person and returns the answer", async () => {
    const m = machine();
    const client = await stdio(m);
    const asked = await call<McpItemStatus>(client, "ask_human", {
      question: "Keep the v1 endpoint for one more release?",
    });
    expect(asked.result).toMatchObject({ kind: "question", state: "open", owners: [PERSON] });
    await withLedger(m, (ledger) =>
      openReviewList(ledger).decide(asked.result.item_id, {
        verdict: "answer",
        by: PERSON,
        reason: "Yes, until December.",
      }),
    );
    const { result } = await call<McpItemStatus>(client, "get_answer", {
      item_id: asked.result.item_id,
    });
    expect(result.answer).toMatchObject({ verdict: "answer", reason: "Yes, until December." });
  }, 60_000);

  it("turns a blocked call into an exception request, and an approval into a grant here", async () => {
    const m = machine();
    const id = await blockCurl(m);
    const client = await stdio(m);
    // The block is still on the spool: the request brings it in and adds the agent's reason.
    const requested = await call<McpItemStatus>(client, "request_exception", {
      exception_id: id,
      reason: "The status page has no client in src/http.ts yet.",
    });
    expect(requested.result).toMatchObject({
      item_id: id,
      kind: "exception",
      state: "open",
      blocking: true,
    });
    expect(requested.result.title).toMatch(/curl/);

    await withLedger(m, async (ledger) => {
      const list = openReviewList(ledger);
      expect((await list.get(id))?.brief).toMatch(/status page has no client/);
      await list.decide(id, { verdict: "approve", by: PERSON });
    });
    const { result } = await call<McpItemStatus>(client, "get_answer", { item_id: id });
    expect(result.state).toBe("answered");
    expect(result.grant?.expires_at).toBeDefined();
    expect(result.next).toMatch(/identical call again now/);
    const grant = JSON.parse(
      readFileSync(m.home.path(".selfhost", "exceptions", "grants", `${id}.json`), "utf8"),
    );
    expect(grant.expires_at).toBe(result.grant?.expires_at);

    const stranger = await call(client, "request_exception", {
      exception_id: uuidv7(new Date()),
      reason: "please",
    });
    expect(stranger.error?.code).toBe("not_found");
  }, 60_000);

  it("says so when selfhost import --watch holds the embedded ledger", async () => {
    const m = machine();
    const client = await stdio(m);
    const cache = m.home.write(
      ".selfhost/statusline.json",
      JSON.stringify({
        schema: "selfhost.statusline/v1",
        written_at: new Date().toISOString(),
        pid: process.pid,
        person: PERSON,
        today: { day: "2026-11-08", usd: 0 },
        warnings: [],
        alarms: [],
      }),
    );
    const held = await call(client, "search_events");
    expect(held.error?.code).toBe("unavailable");
    expect(held.error?.message).toMatch(/import --watch/);
    // The policy needs no ledger.
    expect((await call(client, "get_policy")).error).toBeUndefined();
    rmSync(cache);
    expect((await call(client, "search_events")).error).toBeUndefined();
  }, 60_000);
});

describe("selfhost mcp while selfhost import --watch runs, solo", () => {
  it("answers get_budget and list_review_items from what the watcher saves", async () => {
    const m = machine();
    const client = await stdio(m);
    // What a running watcher keeps: the statusline cache with its pid, the spend and the inbox.
    m.home.write(
      ".selfhost/statusline.json",
      JSON.stringify({
        schema: "selfhost.statusline/v1",
        written_at: new Date().toISOString(),
        pid: process.pid,
        person: PERSON,
        today: { day: new Date().toISOString().slice(0, 10), usd: 0 },
        warnings: [],
        alarms: [],
      }),
    );
    const watcher = await openLedger({ dataDir: "memory://" });
    try {
      const now = new Date();
      await watcher.append([
        {
          id: uuidv7(now),
          schema: EVENT_SCHEMA,
          ts: now.toISOString(),
          source: "local_log",
          kind: "cost.recorded",
          actor: { kind: "person", id: PERSON },
          session_id: "sess-cost",
          agent: { vendor: "claude_code" },
          cost: {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            usd: 12.5,
            estimated: true,
          },
        },
        {
          id: uuidv7(now),
          schema: EVENT_SCHEMA,
          ts: now.toISOString(),
          source: "hook",
          kind: "approval.requested",
          actor: { kind: "person", id: PERSON },
          session_id: "sess-wait",
          agent: { vendor: "claude_code" },
          data: { message: "Claude needs your permission to use Bash" },
        },
      ]);
      await writeSpendSnapshot(watcher, PERSON, spendSnapshotPath({}, m.configPath), now);
      const list = openReviewList(watcher, { now: () => now });
      await refreshReviewList(watcher, list);
      const { items } = await list.list({ state: "open" });
      expect(items).toHaveLength(1);
      writeInboxCache(inboxPaths(m.configPath).cache, {
        schema: "selfhost.inbox_cache/v1",
        written_at: now.toISOString(),
        pid: process.pid,
        server: null,
        team: null,
        person: PERSON,
        all: false,
        items,
        snoozed: {},
      });
    } finally {
      await watcher.close();
    }

    const budget = await call<BudgetResponse>(client, "get_budget");
    expect(budget.error).toBeUndefined();
    expect(budget.result).toMatchObject({ limit_usd: 50, spent_usd: 12.5, remaining_usd: 37.5 });
    expect(budget.result.budgets).toEqual([
      expect.objectContaining({
        scope: "person",
        period: "month",
        enforcement: "alert",
        cut_off: false,
      }),
    ]);
    const open = await call<ReviewItemsPage>(client, "list_review_items");
    expect(open.error).toBeUndefined();
    expect(open.result.items.map((item) => item.title)).toEqual([
      "Claude needs your permission to use Bash",
    ]);
    const answered = await call(client, "list_review_items", { state: "answered" });
    expect(answered.error?.code).toBe("unavailable");
    // Tools with nothing saved for them still say the watcher holds the ledger.
    expect((await call(client, "search_events")).error?.code).toBe("unavailable");
  }, 60_000);
});

describe("selfhost mcp in team mode", () => {
  it("hands calls to the team server as the person, and writes approved grants here", async () => {
    const m = machine();
    const ledger = await openLedger({ dataDir: "memory://" });
    const app = createApp({ version: "test", ledger, token: "admin-token" });
    const admin = (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const team = (await (await admin("/v1/teams", { name: "Web" })).json()) as CreateTeamResponse;
    const joined = (await (
      await app.request("/v1/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invite: team.invite, person: PERSON }),
      })
    ).json()) as JoinResponse;
    const server = "http://selfhost.test";
    saveMembership(m.configPath, { server, token: joined.token, person: PERSON, team: "web" });
    const fetch = async (url: string, init: RequestInit) => app.request(url, init);

    const proxy = mcpServer(
      {},
      { env: {}, cwd: m.workspace.root, configPath: m.configPath, fetch },
      "test",
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await proxy.connect(serverSide);
    const client = new Client({ name: "codex-mcp-client", version: "0.50.0" });
    await client.connect(clientSide);
    clients.push(client);

    const asked = await call<McpItemStatus>(client, "ask_human", { question: "Merge on Friday?" });
    expect(asked.result).toMatchObject({ kind: "question", owners: [PERSON] });
    const item = await openReviewList(ledger, { team: "web" }).get(asked.result.item_id);
    expect(item?.agent?.vendor).toBe("codex");

    // A block on this machine reaches the server the real way: `selfhost import` maps the hook's
    // spool line into this machine's ledger and the team sync sends it with the person token.
    const id = await blockCurl(m);
    const local = await openLedger({ dataDir: "memory://" });
    const imported = await runImport(
      // Empty log folders, so the import never reads this machine's real agent logs.
      { since: "1d", claudeDir: m.home.path("no-claude"), codexDir: m.home.path("no-codex") },
      {
        env: { HOME: m.home.root, SELFHOST_PERSON: PERSON },
        write: () => {},
        configPath: m.configPath,
        fetch,
        retry: { retries: 0 },
      },
      local,
    );
    await local.close();
    expect(imported.hooks.accepted).toBeGreaterThan(0);
    expect(imported.sync?.error).toBeUndefined();
    const requested = await call<McpItemStatus>(client, "request_exception", {
      exception_id: id,
      reason: "Needed for the status check.",
    });
    expect(requested.result).toMatchObject({ kind: "exception", state: "open" });
    // The person whose agent was blocked cannot approve it; someone else does.
    const own = await app.request(`/v1/review-items/${id}/decision`, {
      method: "POST",
      headers: { authorization: `Bearer ${joined.token}`, "content-type": "application/json" },
      body: JSON.stringify({ verdict: "approve" }),
    });
    expect(own.status).toBe(403);
    const approved = await admin(`/v1/review-items/${id}/decision`, {
      verdict: "approve",
      by: "lead@example.com",
    });
    expect(approved.status).toBe(200);
    const { result } = await call<McpItemStatus>(client, "get_answer", { item_id: id });
    expect(result.grant?.expires_at).toBeDefined();
    expect(result.next).toMatch(/identical call again now/);

    // An unknown tool is an unknown tool, as in solo mode, not an unreachable server.
    await expect(client.callTool({ name: "no_such_tool", arguments: {} })).rejects.toThrow(
      /Unknown tool: no_such_tool/,
    );

    // The token stayed in config.json; the agent sees no secret.
    expect(JSON.stringify(result)).not.toContain(joined.token);
    await ledger.close();
  }, 60_000);
});

describe("selfhost mcp install", () => {
  const probes = {
    which: (name: string) => (name === "selfhost" ? "/usr/local/bin/selfhost" : undefined),
  };

  it("adds the selfhost server to Claude Code, Codex and Cursor, and takes it out again", async () => {
    const home = tempDir("mcp-install");
    const args = ["--home", home.root, "--agent", "claude", "codex", "cursor"];
    const installed = await run(["mcp", "install", ...args, "--json"], { probes });
    expect(installed.code).toBe(0);
    const report = JSON.parse(installed.out);
    expect(report.command).toEqual(["selfhost", "mcp"]);
    expect(report.agents.map((agent: { status: string }) => agent.status)).toEqual([
      "create",
      "create",
      "create",
    ]);
    const claude = JSON.parse(readFileSync(home.path(".claude.json"), "utf8"));
    expect(claude.mcpServers.selfhost).toMatchObject({ command: "selfhost", args: ["mcp"] });
    expect(readFileSync(home.path(".codex", "config.toml"), "utf8")).toContain(
      "[mcp_servers.selfhost]",
    );
    const cursor = JSON.parse(readFileSync(home.path(".cursor", "mcp.json"), "utf8"));
    expect(cursor.mcpServers.selfhost.command).toBe("selfhost");

    const again = await run(["mcp", "install", ...args, "--json"], { probes });
    expect(JSON.parse(again.out).agents.map((agent: { status: string }) => agent.status)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
    ]);

    const removed = await run(["mcp", "uninstall", ...args], { probes });
    expect(removed.code).toBe(0);
    // The files selfhost created for the entries are gone again.
    expect(existsSync(home.path(".claude.json"))).toBe(false);
    expect(existsSync(home.path(".cursor", "mcp.json"))).toBe(false);
  });

  it("leaves other MCP servers alone", async () => {
    const home = tempDir("mcp-install-keep");
    home.write(
      ".cursor/mcp.json",
      JSON.stringify({ mcpServers: { docs: { url: "https://docs.example.com/mcp" } } }),
    );
    await run(["mcp", "install", "--home", home.root, "--agent", "cursor"], { probes });
    const cursor = JSON.parse(readFileSync(home.path(".cursor", "mcp.json"), "utf8"));
    expect(Object.keys(cursor.mcpServers).sort()).toEqual(["docs", "selfhost"]);
    await run(["mcp", "uninstall", "--home", home.root, "--agent", "cursor"], { probes });
    expect(
      Object.keys(JSON.parse(readFileSync(home.path(".cursor", "mcp.json"), "utf8")).mcpServers),
    ).toEqual(["docs"]);
  });
});

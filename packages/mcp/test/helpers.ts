import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type Ledger, openLedger } from "@selfhost/ledger";
import { effectiveRules } from "@selfhost/policy";
import {
  type BudgetResponse,
  EVENT_SCHEMA,
  type LedgerEvent,
  type PolicyResponse,
  parseConfig,
} from "@selfhost/schema";
import { encode } from "gpt-tokenizer";
import { createMcpServer, ledgerData, type McpData, uuidv7 } from "../src/index.js";

export const T0 = new Date("2026-11-08T10:00:00.000Z");
export const ME = "dev@example.com";
export const OTHER = "ana@example.com";

const PRESETS = join(import.meta.dirname, "..", "..", "..", "presets");

/** The strict preset as a policy response: the largest policy shipped. */
export function strictPolicy(): PolicyResponse {
  const text = readFileSync(join(PRESETS, "strict.toml"), "utf8");
  const parsed = parseConfig(text);
  if (!parsed.ok) throw new Error("presets/strict.toml does not parse");
  return {
    hash: "0".repeat(64),
    repo: "acme/api",
    text,
    loaded_at: T0.toISOString(),
    config: parsed.config,
    effective_rules: effectiveRules(parsed.config, {}),
  };
}

export const BUDGET: BudgetResponse = {
  period: "month",
  from: "2026-11-01T00:00:00.000Z",
  to: "2026-12-01T00:00:00.000Z",
  spent_usd: 120.5,
  limit_usd: 500,
  remaining_usd: 379.5,
  forecast_usd: 451.9,
};

let tick = 0;

/** A tool.called event on a file, as the hooks write it. */
export function toolCall(fields: {
  person?: string;
  session?: string;
  path: string;
  tool?: string;
  minutesAgo?: number;
  repo?: string;
  summary?: string;
}): LedgerEvent {
  const ts = new Date(T0.getTime() - (fields.minutesAgo ?? 1) * 60_000 + (tick++ % 1000));
  return {
    id: uuidv7(ts),
    schema: EVENT_SCHEMA,
    ts: ts.toISOString(),
    source: "hook",
    kind: "tool.called",
    actor: { kind: "person", id: fields.person ?? ME },
    agent: { vendor: "claude_code", version: "2.1.0" },
    session_id: fields.session ?? "sess-1",
    ...(fields.repo ? { repo: fields.repo } : {}),
    tool: { name: fields.tool ?? "Edit", input_summary: fields.summary ?? fields.path },
    target: { type: "file", value: fields.path },
  };
}

export async function memoryLedger(): Promise<Ledger> {
  return openLedger({ dataDir: "memory://" });
}

/** The tools' data over one ledger, as on a laptop, with a fixed policy and budget. */
export function soloData(ledger: Ledger, now: () => Date = () => T0): McpData {
  return {
    ...ledgerData({ use: (fn) => fn(ledger), person: ME, now, source: "cli" }),
    policy: async () => strictPolicy(),
    budget: async () => BUDGET,
  };
}

/** An SDK client connected to a server over `data` in memory. */
export async function connect(data: McpData, name = "claude-code"): Promise<Client> {
  const server = createMcpServer(data, { version: "0.0.0", now: () => T0, sleep: async () => {} });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name, version: "2.1.0" });
  await client.connect(clientSide);
  return client;
}

/** A tool call's structured answer, or its ApiError body for an error. */
export async function call<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ result: T; error?: { code: string; message: string }; tokens: number }> {
  const response = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const [first] = response.content;
  const text = first?.type === "text" ? first.text : "";
  const tokens = encode(text).length;
  if (response.isError) {
    return { result: {} as T, error: JSON.parse(text).error, tokens };
  }
  return { result: response.structuredContent as T, tokens };
}

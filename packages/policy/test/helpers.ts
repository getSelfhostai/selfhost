import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stableEventId } from "@selfhost/ledger";
import {
  type AgentVendor,
  EVENT_SCHEMA,
  type LedgerEvent,
  parseConfig,
  type ResolvedSelfhostConfig,
} from "@selfhost/schema";

export const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");

/** The schema fixture with one or more rules per policy category. */
export const CATEGORIES_TOML = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "schema",
    "fixtures",
    "config",
    "valid",
    "policy-categories.toml",
  ),
  "utf8",
);

export function config(text: string): ResolvedSelfhostConfig {
  const result = parseConfig(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.config;
}

export interface ToolEventInput {
  session: string;
  ts: string;
  tool: string;
  agent?: AgentVendor;
  model?: string;
  target?: LedgerEvent["target"];
}

export function toolEvent(input: ToolEventInput): LedgerEvent {
  const agent = input.agent ?? "claude_code";
  return {
    id: stableEventId(input.ts, `test:tool:${input.session}:${input.tool}:${input.ts}`),
    schema: EVENT_SCHEMA,
    ts: input.ts,
    source: "hook",
    kind: "tool.called",
    actor: { kind: "agent", id: `${agent}:session:${input.session}` },
    agent: { vendor: agent },
    session_id: input.session,
    ...(input.model ? { model: input.model } : {}),
    tool: input.target
      ? { name: input.tool, input_summary: input.target.value }
      : { name: input.tool },
    ...(input.target ? { target: input.target } : {}),
  };
}

export function sessionStarted(session: string, ts: string, cwd: string): LedgerEvent {
  return {
    id: stableEventId(ts, `test:start:${session}`),
    schema: EVENT_SCHEMA,
    ts,
    source: "hook",
    kind: "session.started",
    actor: { kind: "person", id: "dev@example.com" },
    agent: { vendor: "claude_code" },
    session_id: session,
    data: { cwd },
  };
}

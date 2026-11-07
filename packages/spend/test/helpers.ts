import { EVENT_SCHEMA, type EventSource, type LedgerEvent } from "@selfhost/schema";

let counter = 0;

export interface CostInput {
  ts: string;
  usd: number;
  type?: string;
  vendor?: "claude_code" | "codex";
  model?: string;
  person?: string;
  session?: string;
  source?: EventSource;
  tokens?: number;
}

/** A cost.recorded event; tokens are all uncached input. */
export function cost(input: CostInput): LedgerEvent {
  counter++;
  return {
    id: `01930c4e-2f1a-7b2c-8d3e-${counter.toString(16).padStart(12, "0")}`,
    schema: EVENT_SCHEMA,
    ts: input.ts,
    source: input.source ?? "local_log",
    kind: "cost.recorded",
    actor: input.person
      ? { kind: "person", id: input.person }
      : { kind: "agent", id: "claude_code:session:s" },
    agent: { vendor: input.vendor ?? "claude_code" },
    ...(input.model ? { model: input.model } : {}),
    ...(input.session ? { session_id: input.session } : {}),
    cost: {
      input_tokens: input.tokens ?? 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      usd: input.usd,
      estimated: true,
    },
    ...(input.type ? { data: { request_type: input.type } } : {}),
  };
}

/** One day's spend as { request_type: usd }, at noon UTC. */
export function day(date: string, spend: Record<string, number>): LedgerEvent[] {
  return Object.entries(spend).map(([type, usd]) =>
    cost({ ts: `${date}T12:00:00.000Z`, usd, type }),
  );
}

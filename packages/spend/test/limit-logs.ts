import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Synthetic Claude Code transcripts and Codex rollouts, in the line shapes of the fixtures in
 * fixtures/sources/subscription-week, plus the lines each agent writes when a plan limit is hit.
 */

let counter = 0;
const uuid = (prefix: string) => {
  counter++;
  return `${prefix}-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
};

const lines = (rows: object[]) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

const PROJECT = "-home-dev-acme-api";

/** One Claude Code session: a prompt, then one priced response per timestamp, then a limit hit. */
export function writeClaudeSession(
  root: string,
  responses: { ts: string; usd: number }[],
  limitHit?: { ts: string; text: string },
): void {
  const sessionId = uuid("5e55c1a0");
  const first = responses[0]?.ts ?? limitHit?.ts ?? "2026-10-01T00:00:00.000Z";
  const base = {
    isSidechain: false,
    userType: "external",
    entrypoint: "cli",
    cwd: "/home/dev/acme-api",
    sessionId,
    version: "2.1.312",
    gitBranch: "main",
  };
  const rows: object[] = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      timestamp: first,
      uuid: uuid("00000000"),
      message: { role: "user", content: "Keep going on the migration." },
    },
    ...responses.map((response) => {
      const n = uuid("00000000");
      return {
        ...base,
        type: "assistant",
        timestamp: response.ts,
        uuid: n,
        requestId: `req_${n.slice(-12)}`,
        costUSD: response.usd,
        message: {
          model: "claude-opus-5-5",
          id: `msg_${n.slice(-12)}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          usage: { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 20000 },
        },
      };
    }),
  ];
  if (limitHit) {
    rows.push({
      ...base,
      type: "assistant",
      timestamp: limitHit.ts,
      uuid: uuid("00000000"),
      isApiErrorMessage: true,
      error: "rate_limit",
      message: {
        id: "msg_synthetic",
        model: "<synthetic>",
        role: "assistant",
        content: [{ type: "text", text: limitHit.text }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }
  const dir = join(root, "claude-code", "projects", PROJECT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines(rows));
}

interface RateWindow {
  used_percent: number;
  window_minutes: number;
  resets_at: number;
}

/**
 * One Codex rollout on gpt-5.5: a token_count per timestamp, every request the same size, each
 * with the rate_limits snapshot Codex logs. `limitHit` adds a snapshot with the weekly window at
 * 100% that resets at `resetsAt`.
 */
export function writeCodexRollout(
  root: string,
  requests: string[],
  limitHit?: { ts: string; resetsAt: string },
): void {
  const id = uuid("01a20000");
  const start = requests[0] ?? limitHit?.ts ?? "2026-10-01T00:00:00.000Z";
  const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const rateLimits = (secondary: RateWindow) => ({
    limit_id: "codex",
    limit_name: null,
    primary: { used_percent: 20, window_minutes: 300, resets_at: epoch(start) + 18_000 },
    secondary,
    credits: null,
    individual_limit: null,
    plan_type: null,
    rate_limit_reached_type: null,
  });
  const weekly = { used_percent: 50, window_minutes: 10080, resets_at: epoch(start) + 86_400 };
  const per = { input: 40_000, cached: 32_000, output: 800, reasoning: 300 };
  const rows: object[] = [
    {
      timestamp: start,
      type: "session_meta",
      payload: {
        session_id: id,
        id,
        timestamp: start,
        cwd: "/home/dev/acme-api",
        originator: "codex_cli_rs",
        cli_version: "0.142.5",
        source: "cli",
        thread_source: "user",
        model_provider: "openai",
      },
    },
    {
      timestamp: start,
      type: "turn_context",
      payload: { turn_id: uuid("01a20000"), cwd: "/home/dev/acme-api", model: "gpt-5.5" },
    },
    ...requests.map((ts, index) => {
      const n = index + 1;
      const usage = (count: number) => ({
        input_tokens: per.input * count,
        cached_input_tokens: per.cached * count,
        output_tokens: per.output * count,
        reasoning_output_tokens: per.reasoning * count,
        total_tokens: (per.input + per.output) * count,
      });
      return {
        timestamp: ts,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: usage(n),
            last_token_usage: usage(1),
            model_context_window: 258_400,
          },
          rate_limits: rateLimits(weekly),
        },
      };
    }),
  ];
  if (limitHit) {
    rows.push({
      timestamp: limitHit.ts,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: null,
        rate_limits: rateLimits({
          used_percent: 100,
          window_minutes: 10080,
          resets_at: epoch(limitHit.resetsAt),
        }),
      },
    });
  }
  const day = start.slice(0, 10).split("-");
  const dir = join(root, "codex", "sessions", ...day);
  mkdirSync(dir, { recursive: true });
  const stamp = start.slice(0, 19).replaceAll(":", "-");
  writeFileSync(join(dir, `rollout-${stamp}-${id}.jsonl`), lines(rows));
}

/** Timestamps every `everyMin` minutes from `from` (inclusive) to `to` (exclusive), 30 s in. */
export function every(from: string, to: string, everyMin: number): string[] {
  const out: string[] = [];
  for (let ms = Date.parse(from); ms < Date.parse(to); ms += everyMin * 60_000) {
    out.push(new Date(ms + 30_000).toISOString());
  }
  return out;
}

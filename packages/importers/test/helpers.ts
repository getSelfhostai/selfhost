import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type LedgerEvent, validateEventBatch } from "@selfhost/schema";
import type { LedgerWriter } from "../src/index.js";

export const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
export const CLAUDE_DIR = join(FIXTURES, "claude-code");
export const CODEX_DIR = join(FIXTURES, "codex");
/** Before every fixture line, so nothing is cut by the window. */
export const ALL_TIME = new Date("2026-01-01T00:00:00Z");

export function readJson<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(join(FIXTURES, ...parts), "utf8")) as T;
}

/** A ledger stand-in: validates each batch like the server and dedupes by id. */
export class MemoryWriter implements LedgerWriter {
  readonly events = new Map<string, LedgerEvent>();
  readonly batches: number[] = [];

  async append(events: LedgerEvent[]) {
    const result = validateEventBatch(events);
    if (!result.ok) throw new Error(`invalid batch: ${JSON.stringify(result.errors.slice(0, 3))}`);
    const accepted: string[] = [];
    const duplicates: string[] = [];
    for (const event of events) {
      if (this.events.has(event.id)) {
        duplicates.push(event.id);
      } else {
        this.events.set(event.id, event);
        accepted.push(event.id);
      }
    }
    this.batches.push(events.length);
    return { accepted, duplicates };
  }

  list(kind?: LedgerEvent["kind"]): LedgerEvent[] {
    return [...this.events.values()].filter((event) => kind === undefined || event.kind === kind);
  }
}

export function tempDir(prefix: string): { path: string; cleanup(): void } {
  const path = mkdtempSync(join(tmpdir(), `selfhost-${prefix}-`));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/** Copies the fixture logs into `home` with the default `~/.claude` and `~/.codex` layout. */
export function seedHome(home: string): void {
  cpSync(join(CLAUDE_DIR, "projects"), join(home, ".claude", "projects"), { recursive: true });
  cpSync(join(CODEX_DIR, "sessions"), join(home, ".codex", "sessions"), { recursive: true });
}

export async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((done) => setTimeout(done, 20));
  }
}

export interface ModelTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cost: number;
}

/** cost.recorded totals by UTC day and model, the grouping ccusage's daily report uses. */
export function dailyByModel(events: LedgerEvent[]): Map<string, Map<string, ModelTotals>> {
  const days = new Map<string, Map<string, ModelTotals>>();
  for (const event of events) {
    if (event.kind !== "cost.recorded" || !event.cost || !event.model) continue;
    const day = event.ts.slice(0, 10);
    const models = days.get(day) ?? new Map<string, ModelTotals>();
    const totals = models.get(event.model) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cost: 0,
    };
    totals.inputTokens += event.cost.input_tokens;
    totals.outputTokens += event.cost.output_tokens;
    totals.cacheReadTokens += event.cost.cache_read_tokens;
    totals.cacheCreationTokens += event.cost.cache_write_tokens;
    totals.cost += event.cost.usd;
    models.set(event.model, totals);
    days.set(day, models);
  }
  return days;
}

/** A Claude Code assistant line with one Bash tool call and its usage. */
export function assistantToolLine(toolUseId: string, timestamp: string): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    message: {
      model: "claude-opus-5-5",
      id: `msg_${toolUseId.slice(6)}`,
      type: "message",
      role: "assistant",
      content: [
        { type: "tool_use", id: toolUseId, name: "Bash", input: { command: "npm run lint" } },
      ],
      usage: { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 21000 },
    },
    requestId: `req_${toolUseId.slice(6)}`,
    type: "assistant",
    uuid: "00000000-0000-4000-8000-00000000a001",
    timestamp,
    cwd: "/home/dev/acme-api",
    sessionId: "665bce74-4bdc-4164-8bb1-cc4246de2400",
    version: "2.1.308",
  });
}

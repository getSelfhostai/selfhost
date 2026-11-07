import type { LedgerEvent } from "@selfhost/schema";
import { cost } from "./helpers.js";

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32). */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Worker {
  person: string;
  vendor: "claude_code" | "codex";
  /** UTC hours of the working day, end exclusive. */
  from: number;
  to: number;
  /** Average USD per 15 minutes while working. */
  usdPerSlot: number;
  /** Works on Saturday and Sunday too. */
  weekends?: boolean;
}

const SLOT = 15 * 60_000;
const DAY = 86_400_000;

/**
 * A team's spend: each worker spends on working days, in their hours, a varying amount per 15
 * minutes (0.3x to 1.7x the average, a few requests per slot), starting up to 30 minutes late.
 */
export function teamSpend(
  workers: readonly Worker[],
  firstDay: string,
  days: number,
  seed = 7,
): LedgerEvent[] {
  const next = random(seed);
  const events: LedgerEvent[] = [];
  const start = Date.parse(`${firstDay}T00:00:00.000Z`);
  for (let day = 0; day < days; day++) {
    const dayMs = start + day * DAY;
    const weekday = new Date(dayMs).getUTCDay();
    for (const worker of workers) {
      if (!worker.weekends && (weekday === 0 || weekday === 6)) continue;
      const late = Math.floor(next() * 3) * SLOT;
      for (let ms = dayMs + worker.from * 3_600_000 + late; ms < dayMs + worker.to * 3_600_000; ) {
        const slotUsd = worker.usdPerSlot * (0.3 + 1.4 * next());
        const requests = 2 + Math.floor(next() * 4);
        for (let r = 0; r < requests; r++) {
          events.push(
            cost({
              ts: new Date(ms + Math.floor(((r + 0.5) * SLOT) / requests)).toISOString(),
              usd: slotUsd / requests,
              person: worker.person,
              vendor: worker.vendor,
              type: "main",
            }),
          );
        }
        ms += SLOT;
      }
    }
  }
  return events;
}

/** `usd` spread evenly over `minutes` from `at`, one request a minute, for one person. */
export function burst(
  at: string,
  minutes: number,
  usd: number,
  person: string,
  vendor: "claude_code" | "codex" = "claude_code",
): LedgerEvent[] {
  const start = Date.parse(at);
  return Array.from({ length: minutes }, (_, minute) =>
    cost({
      ts: new Date(start + minute * 60_000 + 30_000).toISOString(),
      usd: usd / minutes,
      person,
      vendor,
      type: "main",
    }),
  );
}

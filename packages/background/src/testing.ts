import { type BackgroundRun, isFinalRunState } from "@selfhost/schema";
import type { ActiveKill, Clock, RunStore } from "./types.js";

/** An in-memory RunStore with the same rules as the ledger's, for tests. */
export function memoryRunStore(): RunStore & { runs: Map<string, BackgroundRun> } {
  const runs = new Map<string, BackgroundRun>();
  const kills: (ActiveKill & { cleared?: boolean })[] = [];
  const copy = (run: BackgroundRun): BackgroundRun => structuredClone(run);
  return {
    runs,
    async create(run) {
      if (runs.has(run.id)) return false;
      runs.set(run.id, copy(run));
      return true;
    },
    async get(id) {
      const run = runs.get(id);
      return run ? copy(run) : undefined;
    },
    async save(run) {
      const old = runs.get(run.id);
      if (!old) throw new Error(`No background run ${run.id}`);
      const next = copy({ ...run, cancel: run.cancel ?? old.cancel });
      runs.set(run.id, next);
      return copy(next);
    },
    async requestCancel(id, cancel) {
      const run = runs.get(id);
      if (!run || run.cancel || isFinalRunState(run.state)) return false;
      runs.set(id, { ...run, cancel });
      return true;
    },
    async list({ teams, states, limit = 50 } = {}) {
      return [...runs.values()]
        .filter((run) => !teams || teams.includes(run.team))
        .filter((run) => !states || states.includes(run.state))
        .sort((a, b) =>
          a.created_at < b.created_at
            ? 1
            : a.created_at > b.created_at
              ? -1
              : b.id.localeCompare(a.id),
        )
        .slice(0, limit)
        .map(copy);
    },
    async countSince(team, since) {
      return [...runs.values()].filter(
        (run) => run.team === team && Date.parse(run.created_at) >= since.getTime(),
      ).length;
    },
    async countActive(team) {
      return [...runs.values()].filter((run) => run.team === team && !isFinalRunState(run.state))
        .length;
    },
    async kill({ scope, target, by, at }) {
      if (kills.some((k) => !k.cleared && k.scope === scope && k.target === target)) return false;
      kills.push({ scope, target, by, at });
      return true;
    },
    async clearKill(scope, target) {
      const found = kills.find((k) => !k.cleared && k.scope === scope && k.target === target);
      if (!found) return false;
      found.cleared = true;
      return true;
    },
    async activeKills({ teams = [], orgs = [] }) {
      return kills
        .filter((k) => !k.cleared)
        .filter((k) => (k.scope === "team" ? teams.includes(k.target) : orgs.includes(k.target)))
        .map(({ scope, target, by, at }) => ({ scope, target, by, at }));
    },
  };
}

/**
 * A clock tests move by hand: `advance` moves the time and runs every timer that falls due, one
 * after another, waiting for each.
 */
export function manualClock(start: string | Date): Clock & {
  advance(ms: number): Promise<void>;
  set(at: string | Date): void;
} {
  let now = new Date(start).getTime();
  let nextId = 1;
  const timers = new Map<number, { ms: number; due: number; fn: () => Promise<void> | void }>();
  return {
    now: () => new Date(now),
    set(at) {
      now = new Date(at).getTime();
    },
    every(ms, fn) {
      const id = nextId++;
      timers.set(id, { ms, due: now + ms, fn });
      return () => timers.delete(id);
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.due <= end)
          .sort(([, a], [, b]) => a.due - b.due)[0];
        if (!next) break;
        const [, timer] = next;
        now = Math.max(now, timer.due);
        timer.due += timer.ms;
        await timer.fn();
      }
      now = end;
      // Let promise chains the timers started settle.
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
  };
}

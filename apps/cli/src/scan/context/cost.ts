import { isAbsolute, relative } from "node:path";
import type { ContextReader } from "@selfhost/agents";
import { findPricing } from "@selfhost/importers";
import { WORK_REQUEST_TYPES } from "@selfhost/schema";
import { WEEK_MS } from "@selfhost/spend";
import type { SessionStats } from "../sessions.js";
import type { ContextDoc } from "./files.js";

/** Counts tokens the way TOKENIZER says. */
export type CountTokens = (text: string) => number;

export const TOKENIZER =
  "o200k_base (gpt-tokenizer): exact for Codex's GPT-5 models; Claude, Gemini and the others publish no offline tokenizer, so their counts are an estimate from the same encoding";

export const CONTEXT_PRICING =
  "each session that loads a file pays for it once as a cache write and then as a cache read on every later main or subagent request, at that session's model rates from the ccusage price table; sessions per week are this window's sessions from the local logs";

/** Loads the tokenizer only when a scan has files to count. */
export async function o200kCounter(): Promise<CountTokens> {
  const { countTokens } = await import("gpt-tokenizer/encoding/o200k_base");
  return (text) => (text === "" ? 0 : countTokens(text, { disallowedSpecial: new Set() }));
}

export interface FileCost {
  sessions: number;
  sessions_per_week: number;
  tokens_per_week: number;
  usd_per_week: number;
}

const inside = (dir: string, root: string) => {
  const rel = relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** USD for one token of always-loaded context over a whole session. */
export function sessionRate(session: SessionStats): number | undefined {
  const pricing = session.model ? findPricing(session.model) : undefined;
  if (!pricing) return undefined;
  const work = session.costs.filter((cost) =>
    (WORK_REQUEST_TYPES as readonly string[]).includes(cost.requestType),
  ).length;
  return pricing.cacheCreate + pricing.cacheRead * Math.max(work - 1, 0);
}

/**
 * The weekly cost of one file's always-loaded part: its sessions are the window's sessions of
 * the agents that read it, in the repository for repository files and anywhere for home files.
 */
export function fileCost(
  doc: ContextDoc,
  alwaysTokens: number,
  sessions: SessionStats[],
  window: { from: Date; to: Date },
  repo: string | undefined,
): FileCost {
  const weeks = Math.max(window.to.getTime() - window.from.getTime(), 1) / WEEK_MS;
  const matched = sessions.filter(
    (session) =>
      doc.file.readers.includes(session.vendor as ContextReader) &&
      (doc.file.scope === "home" ||
        (repo !== undefined && session.cwd !== undefined && inside(session.cwd, repo))),
  );
  let usd = 0;
  for (const session of matched) usd += alwaysTokens * (sessionRate(session) ?? 0);
  const perWeek = matched.length / weeks;
  return {
    sessions: matched.length,
    sessions_per_week: perWeek,
    tokens_per_week: alwaysTokens * perWeek,
    usd_per_week: usd / weeks,
  };
}

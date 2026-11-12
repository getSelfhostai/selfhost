import { compare } from "@selfhost/pr";
import { ROOT_MODULE } from "@selfhost/provenance";
import { revertedShas } from "./reverts.js";
import type { ChangedFile } from "./types.js";

/**
 * Learning from reverts: which merged agent pull requests were reverted or had their lines
 * changed again (reworked) within `[review] revert_window_days`, and the rate per agent, model
 * and module that `[review] revert_rate_threshold` is checked against. Pure: the server reads
 * GitHub and the ledger and records what these functions find.
 */

/** Line ranges per file path, first and last line, both included, sorted. */
export type LineRanges = Record<string, [number, number][]>;

/** Most files and ranges per file a pull request's line record keeps. */
export const MAX_LINE_FILES = 300;
export const MAX_FILE_RANGES = 200;

/** Merges per agent, model and module before a rate counts. */
export const MIN_LEARNING_PULLS = 5;

function ranges(lines: number[]): [number, number][] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const line of sorted) {
    const last = out[out.length - 1];
    if (last && line === last[1] + 1) last[1] = line;
    else out.push([line, line]);
  }
  return out.slice(0, MAX_FILE_RANGES);
}

function collect(files: ChangedFile[], pick: (file: ChangedFile) => [string, number[]]) {
  const lines = new Map<string, number[]>();
  for (const file of files) {
    const [path, found] = pick(file);
    if (found.length > 0) lines.set(path, [...(lines.get(path) ?? []), ...found]);
  }
  const out: LineRanges = {};
  for (const path of [...lines.keys()].sort(compare).slice(0, MAX_LINE_FILES)) {
    out[path] = ranges(lines.get(path) ?? []);
  }
  return out;
}

/** The lines a pull request added or changed, by their numbers after the merge. */
export function addedLines(files: ChangedFile[]): LineRanges {
  return collect(files, (file) => [
    file.path,
    (file.hunks ?? []).flatMap((hunk) => hunk.added.map((line) => line.line)),
  ]);
}

/** The lines a pull request changed or deleted, by their numbers before it (the old path of a rename). */
export function removedLines(files: ChangedFile[]): LineRanges {
  return collect(files, (file) => [
    file.previousPath ?? file.path,
    (file.hunks ?? []).flatMap((hunk) => hunk.removed.map((line) => line.line)),
  ]);
}

/**
 * Where a later change touched lines an earlier one wrote: the files and how many lines. Line
 * numbers are compared as they were at the earlier merge and the later pull request's base, so
 * other changes to the same file in between can shift them.
 */
export function overlappingLines(
  written: LineRanges,
  changed: LineRanges,
): { files: string[]; lines: number } {
  const files: string[] = [];
  let lines = 0;
  for (const [path, later] of Object.entries(changed).sort(([a], [b]) => compare(a, b))) {
    const earlier = written[path];
    if (!earlier) continue;
    let hit = 0;
    for (const [a, b] of later) {
      for (const [c, d] of earlier) {
        const from = Math.max(a, c);
        const to = Math.min(b, d);
        if (from <= to) hit += to - from + 1;
      }
    }
    if (hit > 0) {
      files.push(path);
      lines += hit;
    }
  }
  return { files, lines };
}

/** What a pull request or commit says it reverts. */
export interface RevertClaims {
  /** Pull requests named by GitHub's revert button ("Reverts owner/repo#142"), lower case repo. */
  pulls: { repo?: string; number: number }[];
  /** Commits named by `git revert` ("This reverts commit <sha>"). */
  shas: string[];
  /** The reverted pull request's title, from a `Revert "<title>"` title. */
  title?: string;
}

const PULL_REF = /\bReverts\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)/gi;
const REVERT_TITLE = /^Revert "(.+)"(?:\s+\(#\d+\))?\s*$/;

/** The pull requests, commits and title a revert names; empty lists when it names none. */
export function revertClaims(text: {
  title?: string;
  body?: string | null;
  messages?: string[];
}): RevertClaims {
  const texts = [text.body ?? "", ...(text.messages ?? [])];
  const pulls = new Map<string, { repo?: string; number: number }>();
  for (const value of texts) {
    for (const match of value.matchAll(PULL_REF)) {
      const repo = match[1]?.toLowerCase();
      const number = Number(match[2]);
      pulls.set(`${repo ?? ""}#${number}`, { ...(repo ? { repo } : {}), number });
    }
  }
  const title = REVERT_TITLE.exec((text.title ?? "").trim())?.[1];
  return {
    pulls: [...pulls.values()].sort((a, b) => a.number - b.number),
    shas: revertedShas(texts),
    ...(title ? { title } : {}),
  };
}

/** true when the pull request or commit looks like a revert at all. */
export function looksLikeRevert(claims: RevertClaims): boolean {
  return claims.pulls.length > 0 || claims.shas.length > 0 || claims.title !== undefined;
}

const REASON_MAX = 500;

/**
 * Why a pull request was reverted, from the revert's description: what is left once the lines
 * GitHub and git write ("Reverts owner/repo#142", "This reverts commit <sha>.") are taken out.
 */
export function revertReason(body: string | null | undefined): string | undefined {
  const kept = (body ?? "")
    .split("\n")
    .filter((line) => !/^\s*Reverts\s+([\w.-]+\/[\w.-]+)?#\d+\s*$/i.test(line))
    .filter((line) => !/^\s*This reverts commit [0-9a-f]{7,40}/i.test(line))
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  if (kept === "") return undefined;
  return kept.length > REASON_MAX ? `${kept.slice(0, REASON_MAX - 3)}...` : kept;
}

/** A merged agent pull request, with the modules its lines are in. */
export interface MergedPull {
  url: string;
  vendor: string;
  model?: string;
  modules: string[];
}

/** A pr.reverted or pr.reworked event: the pull request it is about and its own id. */
export interface PullOutcome {
  url: string;
  kind: "revert" | "rework";
  /** The ledger event that recorded it, as evidence. */
  event: string;
}

/** How one agent and model's merged pull requests in one module fared. */
export interface LearnedRate {
  vendor: string;
  model?: string;
  module: string;
  /** Merged pull requests in the window. */
  pulls: number;
  reverted: number;
  /** Reworked and not reverted. */
  reworked: number;
  /** (reverted + reworked) / pulls. */
  rate: number;
  /** At least MIN_LEARNING_PULLS pulls and a rate above the threshold. */
  above: boolean;
  /** The pr.reverted and pr.reworked events behind the rate, sorted. */
  evidence: string[];
}

/** The key one rate is tracked under: agent, model and module. */
export const learnedKey = (rate: Pick<LearnedRate, "vendor" | "model" | "module">) =>
  `${rate.vendor}\n${rate.model ?? ""}\n${rate.module}`;

/**
 * Revert and rework rates per agent, model and module, sorted by key. A pull request counts once
 * per module it touched; reverted and reworked, it counts as reverted.
 */
export function learnedRates(
  merged: MergedPull[],
  outcomes: PullOutcome[],
  opts: { threshold: number; minPulls?: number },
): LearnedRate[] {
  const min = opts.minPulls ?? MIN_LEARNING_PULLS;
  const byUrl = new Map<string, PullOutcome[]>();
  for (const outcome of outcomes) {
    byUrl.set(outcome.url, [...(byUrl.get(outcome.url) ?? []), outcome]);
  }
  const groups = new Map<string, { rate: LearnedRate; urls: Set<string> }>();
  const seen = new Set<string>();
  for (const pull of merged) {
    if (seen.has(pull.url)) continue;
    seen.add(pull.url);
    for (const module of new Set(pull.modules)) {
      const key = learnedKey({ vendor: pull.vendor, model: pull.model, module });
      let group = groups.get(key);
      if (!group) {
        group = {
          rate: {
            vendor: pull.vendor,
            ...(pull.model ? { model: pull.model } : {}),
            module,
            pulls: 0,
            reverted: 0,
            reworked: 0,
            rate: 0,
            above: false,
            evidence: [],
          },
          urls: new Set(),
        };
        groups.set(key, group);
      }
      group.rate.pulls++;
      const found = byUrl.get(pull.url) ?? [];
      if (found.some((o) => o.kind === "revert")) group.rate.reverted++;
      else if (found.length > 0) group.rate.reworked++;
      group.rate.evidence.push(...found.map((o) => o.event));
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([, { rate }]) => {
      const bad = rate.reverted + rate.reworked;
      const value = rate.pulls > 0 ? bad / rate.pulls : 0;
      return {
        ...rate,
        rate: value,
        above: rate.pulls >= min && value > opts.threshold,
        evidence: [...new Set(rate.evidence)].sort(),
      };
    });
}

/** What changes for a rate: newly above the threshold, back under it, or nothing. */
export function learnedChange(
  rate: LearnedRate,
  newest: "proposed" | "cleared" | undefined,
): "proposed" | "cleared" | undefined {
  if (rate.above && newest !== "proposed") return "proposed";
  if (!rate.above && newest === "proposed") return "cleared";
  return undefined;
}

/**
 * The selfhost.toml change a person could make by hand for a module that keeps being reverted.
 * selfhost never applies it.
 */
export function learnedSuggestion(module: string, globs: string[] | undefined): string {
  const paths = globs && globs.length > 0 ? globs : [module === ROOT_MODULE ? "*" : `${module}/**`];
  return `Add ${paths.map((glob) => `"${glob}"`).join(", ")} to [review] high_risk_paths in selfhost.toml, so every pull request there ranks high and waits for a person.`;
}

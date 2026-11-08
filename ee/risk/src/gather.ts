import type { Ledger } from "@selfhost/ledger";
import {
  type ChangeRef,
  type ChangeTarget,
  gitIn,
  type LocalChange,
  ledgerEvents,
  newDependencies,
  type Runner,
  readChange,
} from "@selfhost/pr";
import {
  DEFAULT_SETTINGS,
  type ProvenanceSettings,
  readProvenance,
  runCommits,
  touchedModules,
} from "@selfhost/provenance";
import type { LedgerEvent } from "@selfhost/schema";
import { REVERT_WINDOW_DAYS, revertedShas, revertHistory } from "./reverts.js";
import type { ModuleReverts, RiskInput, RiskInputs, RunInput, TestStatus } from "./types.js";

const DAY_MS = 86_400_000;

export type RiskTarget = ChangeTarget;

export interface GatherOptions {
  /** Any folder inside the repository. */
  repoDir: string;
  /** A pull request on GitHub, read with gh, or local commits from the merge base of `base`. */
  target: RiskTarget;
  /** owner/name. Default: the origin remote. */
  repo?: string;
  /** Where the agent runs are. Without it, the run inputs are missing. */
  ledger?: Pick<Ledger, "query">;
  /** From the sandbox or CI; undefined until sandbox runs exist. */
  tests?: TestStatus;
  now?: Date;
  /** Runs gh. Default: the developer's own gh login. */
  gh?: Runner;
  /** Where gh responses are cached. Default: ~/.selfhost/cache/github. */
  ghCacheDir?: string;
  /** Modules, revert window and threshold from `[review]`. Default: the selfhost.toml defaults. */
  provenance?: ProvenanceSettings;
}

/** What was scored. */
export type GatheredTarget = ChangeRef;

export interface Gathered {
  target: GatheredTarget;
  inputs: RiskInputs;
}

/**
 * Revert and rework rates of the modules the change touches, over merges to the main branch in
 * the last REVERT_WINDOW_DAYS, with commits joined to the ledger's runs when there is a ledger.
 */
export async function moduleReverts(
  change: LocalChange,
  opts: {
    since: Date;
    now: Date;
    settings: ProvenanceSettings;
    ledger?: Pick<Ledger, "query">;
  },
): Promise<ModuleReverts> {
  const events: LedgerEvent[] = [];
  if (opts.ledger) {
    for await (const event of ledgerEvents(opts.ledger, {
      kind: "commit.created",
      from: opts.since.toISOString(),
    })) {
      events.push(event);
    }
  }
  const report = await readProvenance(change.target.root, {
    since: opts.since,
    until: opts.now,
    settings: opts.settings,
    commits: change.history,
    runs: runCommits(events),
  });
  const rows = new Map(report.modules.map((row) => [row.module, row] as const));
  return {
    days: REVERT_WINDOW_DAYS,
    modules: touchedModules(change.files, opts.settings).map((module) => ({
      module,
      agentLines: rows.get(module)?.agent_lines ?? 0,
      rate: rows.get(module)?.agent_revert_rework_rate ?? null,
    })),
  };
}

/**
 * Reads everything the score needs, locally: the change through `@selfhost/pr` (the diff and
 * manifests, attribution and the agent run), the revert history from git, and the revert and
 * rework rates of the modules it touches through `@selfhost/provenance`. Never writes to
 * GitHub. Inputs it cannot find are left undefined with the reason in `unavailable`.
 */
export async function gatherRiskInputs(opts: GatherOptions): Promise<Gathered> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - REVERT_WINDOW_DAYS * DAY_MS);
  const change = await readChange({
    repoDir: opts.repoDir,
    target: opts.target,
    since,
    ...(opts.repo ? { repo: opts.repo } : {}),
    ...(opts.ledger ? { ledger: opts.ledger } : {}),
    ...(opts.gh ? { gh: opts.gh } : {}),
    ...(opts.ghCacheDir ? { ghCacheDir: opts.ghCacheDir } : {}),
  });
  const unavailable: Partial<Record<RiskInput, string>> = {};

  let run: RunInput | undefined;
  if (change.run) {
    run = {
      sessions: change.run.sessions,
      toolCalls: change.run.toolCalls,
      guardrails: change.run.guardrails.map(({ rule_id, verdict, mode, irreversible }) => ({
        rule_id,
        verdict,
        mode,
        irreversible,
      })),
    };
  } else if (change.runMissing) {
    unavailable.outside_effects = unavailable.guardrails = change.runMissing;
  }

  const { agent } = change;
  let reverts: RiskInputs["reverts"];
  if (agent) {
    const messages = (
      await gitIn(change.target.root)([
        "log",
        "--branches",
        "--remotes",
        `--since=${since.toISOString()}`,
        "--grep=This reverts commit",
        "--format=%x1e%B",
      ])
    ).split("\x1e");
    reverts = revertHistory(
      change.history.filter((commit) => Date.parse(commit.authoredAt) >= since.getTime()),
      revertedShas(messages),
      agent,
      {
        exclude: new Set(change.target.commits.map((sha) => sha.toLowerCase())),
        days: REVERT_WINDOW_DAYS,
      },
    );
  } else {
    unavailable.reverts = "no agent attributed to these commits";
  }

  let modules: ModuleReverts | undefined;
  try {
    modules = await moduleReverts(change, {
      since,
      now,
      settings: opts.provenance ?? DEFAULT_SETTINGS,
      ...(opts.ledger ? { ledger: opts.ledger } : {}),
    });
  } catch (error) {
    unavailable.module_reverts = `could not read the main branch: ${(error as Error).message}`;
  }

  let dependencies: RiskInputs["dependencies"];
  if (change.manifestProblem) unavailable.dependencies = change.manifestProblem;
  else dependencies = newDependencies(change.manifests);

  if (opts.tests === undefined) unavailable.tests = "no sandbox run yet";

  return {
    target: change.target,
    inputs: {
      files: change.files,
      ...(dependencies ? { dependencies } : {}),
      ...(opts.tests ? { tests: opts.tests } : {}),
      ...(run ? { run } : {}),
      ...(reverts ? { reverts } : {}),
      ...(modules ? { modules } : {}),
      ...(agent ? { agent } : {}),
      unavailable,
    },
  };
}

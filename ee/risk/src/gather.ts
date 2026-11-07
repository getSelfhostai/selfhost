import type { Ledger } from "@selfhost/ledger";
import {
  type ChangeRef,
  type ChangeTarget,
  gitIn,
  newDependencies,
  type Runner,
  readChange,
} from "@selfhost/pr";
import { REVERT_WINDOW_DAYS, revertedShas, revertHistory } from "./reverts.js";
import type { RiskInput, RiskInputs, RunInput, TestStatus } from "./types.js";

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
}

/** What was scored. */
export type GatheredTarget = ChangeRef;

export interface Gathered {
  target: GatheredTarget;
  inputs: RiskInputs;
}

/**
 * Reads everything the score needs, locally: the change through `@selfhost/pr` (the diff and
 * manifests, attribution and the agent run), and the revert history from git. Never writes to
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
      ...(agent ? { agent } : {}),
      unavailable,
    },
  };
}

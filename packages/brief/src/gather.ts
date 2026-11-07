import type { Ledger } from "@selfhost/ledger";
import {
  type Change,
  type ChangeTarget,
  newDependencies,
  type Runner,
  readChange,
} from "@selfhost/pr";
import { buildBrief } from "./build.js";
import type { Brief, BriefInputs } from "./types.js";

export interface BriefSettings {
  /** `[review] high_risk_paths` from selfhost.toml. */
  highRiskPaths: string[];
  /** The team server's base URL, for trace links. */
  server?: string;
}

/** The brief's inputs from a change read by `@selfhost/pr`. */
export function briefInputs(change: Change, settings: BriefSettings): BriefInputs {
  const { target } = change;
  return {
    target: {
      ...(change.repo ? { repo: change.repo } : {}),
      ...(target.pr ? { pr: { number: target.pr.number, url: target.pr.url } } : {}),
      base: target.base,
      head: target.head,
      commits: target.commits,
    },
    ...(change.pull ? { pull: change.pull } : {}),
    subjects: change.subjects,
    ...(change.agent ? { agent: change.agent } : {}),
    files: change.files,
    ...(change.manifestProblem
      ? { dependenciesMissing: change.manifestProblem }
      : { dependencies: newDependencies(change.manifests) }),
    ...(change.run ? { run: { sessions: change.run.sessions, events: change.run.events } } : {}),
    ...(change.runMissing ? { runMissing: change.runMissing } : {}),
    highRiskPaths: settings.highRiskPaths,
    ...(settings.server ? { server: settings.server } : {}),
  };
}

export interface GatherBriefOptions extends BriefSettings {
  /** Any folder inside the repository. */
  repoDir: string;
  target: ChangeTarget;
  /** owner/name. Default: the origin remote. */
  repo?: string;
  /** Where the agent runs are. Without it, the run sections say no run was found. */
  ledger?: Pick<Ledger, "query">;
  /** Runs gh (read-only). Default: the developer's own gh login. */
  gh?: Runner;
  ghCacheDir?: string;
}

/** Reads the change and its run, and builds the brief. Writes nothing anywhere. */
export async function gatherBrief(opts: GatherBriefOptions): Promise<Brief> {
  const change = await readChange({
    repoDir: opts.repoDir,
    target: opts.target,
    ...(opts.repo ? { repo: opts.repo } : {}),
    ...(opts.ledger ? { ledger: opts.ledger } : {}),
    ...(opts.gh ? { gh: opts.gh } : {}),
    ...(opts.ghCacheDir ? { ghCacheDir: opts.ghCacheDir } : {}),
  });
  return buildBrief(briefInputs(change, opts));
}

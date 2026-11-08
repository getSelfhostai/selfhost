import { existsSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { locate } from "@selfhost/agents";
import { importAll } from "@selfhost/importers";
import type { LedgerEvent } from "@selfhost/schema";
import { detectWaste, groupSpend, oneSourcePerSession } from "@selfhost/spend";
import { parseSince } from "../import.js";
import { type CollectAttribution, noAttribution } from "./attribution.js";
import { scanContext } from "./context/index.js";
import { renderHtml } from "./render-html.js";
import { renderSvg } from "./render-svg.js";
import { renderText } from "./render-text.js";
import { buildScanReport, type PlanForecast, type ScanReport } from "./report.js";
import { sessionHintsFromEvents } from "./sessions.js";
import { type Ask, agentCountPrompt, type SendPing } from "./telemetry.js";

export type { AttributionResult, CollectAttribution, SessionHint } from "./attribution.js";
export { buildScanReport, type ScanReport } from "./report.js";
export { sessionHintsFromEvents } from "./sessions.js";

export interface ScanCommandOptions {
  since?: string;
  repo?: string;
  json?: boolean;
  report?: string;
  share?: string;
}

export interface ScanIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Where the agent logs (unless CLAUDE_CONFIG_DIR or CODEX_HOME say otherwise) and the
   * personal context files are. Default: the home directory. */
  home?: string;
  platform?: NodeJS.Platform;
  write: (line: string) => void;
  now?: Date;
  collectAttribution?: CollectAttribution;
  forecast?: PlanForecast;
  ask?: Ask;
  configPath?: string;
  sendTelemetry?: SendPing;
}

/**
 * Reads the local Claude Code and Codex logs for the window straight into memory, with no
 * ledger. Prompt text is never read into events.
 */
export async function readLocalEvents(opts: {
  since: Date;
  claudeDir?: string;
  codexDir?: string;
}): Promise<LedgerEvent[]> {
  const events: LedgerEvent[] = [];
  await importAll(
    {
      async append(batch) {
        events.push(...batch);
        return { accepted: batch.map((event) => event.id), duplicates: [] };
      },
    },
    { ...opts, logPrompts: false, actorId: "local" },
  );
  return events;
}

/** The nearest folder with a .git, from `cwd` up. */
function findGitRoot(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** `--repo` as a folder, or the git repository around `cwd`. */
export function repoDir(option: string | undefined, cwd: string): string | undefined {
  if (option === undefined) return findGitRoot(cwd);
  const dir = resolve(cwd, option);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`--repo: ${dir} is not a folder`);
  }
  return dir;
}

/**
 * `selfhost scan`: reads the local agent logs and the context files of the repository and the
 * home config, joins the logs with git when attribution is wired in, and prints the report or
 * writes it as JSON, HTML or an SVG card. Nothing leaves the machine
 * unless the person said yes to the agent count and an endpoint is configured.
 */
export async function runScan(options: ScanCommandOptions, io: ScanIo): Promise<ScanReport> {
  const now = io.now ?? new Date();
  const since = parseSince(options.since ?? "30d", now) ?? now;
  const repo = repoDir(options.repo, io.cwd);
  const home = io.home ?? homedir();
  // CLAUDE_CONFIG_DIR and CODEX_HOME when set, else the folders in this home.
  const loc = locate({ home, env: io.env, platform: io.platform });
  const events = await readLocalEvents({
    since,
    claudeDir: loc.claude_code.configDir,
    codexDir: loc.codex.home,
  });
  const costs = oneSourcePerSession(events.filter((event) => event.kind === "cost.recorded"));
  const waste = detectWaste(groupSpend(costs, { by: ["request_type"], from: since, to: now }));
  const collect = io.collectAttribution ?? noAttribution;
  const attribution = repo ? await collect(repo, sessionHintsFromEvents(events)) : undefined;
  const context = await scanContext({
    home,
    env: io.env,
    platform: io.platform,
    repo,
  });
  const report = buildScanReport({
    events,
    waste,
    attribution,
    forecast: io.forecast,
    repoDir: repo,
    context,
    from: since,
    to: now,
  });

  const written: string[] = [];
  if (options.report) {
    const path = resolve(io.cwd, options.report);
    writeFileSync(path, renderHtml(report));
    written.push(`Wrote the HTML report to ${path}`);
  }
  if (options.share) {
    const path = resolve(io.cwd, options.share);
    writeFileSync(path, renderSvg(report));
    written.push(`Wrote the share card to ${path}`);
  }
  if (options.json) {
    io.write(JSON.stringify(report, null, 2));
    return report;
  }
  for (const line of renderText(report, written)) io.write(line);
  if (report.totals.agents > 0) {
    await agentCountPrompt(report.totals.agents, {
      env: io.env,
      configPath: io.configPath,
      ask: io.ask,
      send: io.sendTelemetry,
    });
  }
  return report;
}

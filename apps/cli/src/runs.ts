import { execFileSync } from "node:child_process";
import {
  BACKGROUND_AGENTS,
  BACKGROUND_RUN_STATES,
  type BackgroundAgent,
  type BackgroundRun,
  type BackgroundRunsQuery,
  isFinalRunState,
  KILL_SCOPES,
  type KillScope,
  parseRemote,
} from "@selfhost/schema";
import type { Command } from "commander";
import { table, usd } from "./format.js";
import { type Fetch, serverUrl, TeamClient } from "./team/client.js";
import { readMembership } from "./team/config.js";

export interface RunsIo {
  cwd: string;
  write: (line: string) => void;
  setExitCode: (code: number) => void;
  configPath: string;
  fetch: Fetch;
  /** Waits between polls of `selfhost run --wait`. */
  sleep?: (ms: number) => Promise<void>;
  /** The repo's origin remote; default: git in cwd. */
  originRemote?: (cwd: string) => string | undefined;
}

interface RunOptions {
  agent?: string;
  repo?: string;
  runtime?: string;
  base?: string;
  team?: string;
  timeout?: string;
  wait?: boolean;
  json?: boolean;
}

const POLL_MS = 5_000;

function client(io: RunsIo): { client: TeamClient; team: string; server: string } {
  const membership = readMembership(io.configPath);
  if (!membership) {
    throw new Error(
      "Background runs go through the team server, which keeps them going after this machine disconnects. Join a team first: selfhost team join <invite>",
    );
  }
  return {
    client: new TeamClient(serverUrl(membership.server), membership.token, io.fetch),
    team: membership.team,
    server: membership.server,
  };
}

function gitOrigin(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function repoOf(options: RunOptions, io: RunsIo): string {
  if (options.repo) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo)) {
      throw new Error(`--repo: expected owner/name, got "${options.repo}"`);
    }
    return options.repo;
  }
  const remote = (io.originRemote ?? gitOrigin)(io.cwd);
  const parsed = remote ? parseRemote(remote) : undefined;
  if (!parsed)
    throw new Error("--repo: not in a git repository with a GitHub origin; pass --repo owner/name");
  return parsed.repo;
}

function agentOf(value: string | undefined): BackgroundAgent | undefined {
  if (value === undefined) return undefined;
  const name = value.trim().toLowerCase();
  if (!(BACKGROUND_AGENTS as readonly string[]).includes(name)) {
    throw new Error(`--agent: expected one of ${BACKGROUND_AGENTS.join(", ")}, got "${value}"`);
  }
  return name as BackgroundAgent;
}

const ago = (from: string, to: Date) => {
  const minutes = Math.max(0, Math.round((to.getTime() - Date.parse(from)) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
};

/** The lines `selfhost runs show` prints for one run. */
export function describeRun(run: BackgroundRun): string[] {
  return [
    `Run ${run.id}: ${run.state}${run.reason ? ` (${run.reason})` : ""}`,
    `  ${run.agent} on ${run.repo}, branch ${run.branch}, runtime ${run.runtime}, attempt ${run.attempt} of ${run.max_attempts}`,
    `  task: ${run.task.split("\n")[0]}`,
    `  for ${run.person ?? "the team (no person)"}, from ${run.trigger.source} by ${run.trigger.sender}${run.credential ? `, signed in with ${run.credential.replace("_", " ")}` : ""}`,
    ...(run.health ? [`  health: ${run.health.status}, ${run.health.line}`] : []),
    `  cost: ${usd(run.cost.usd)} (runtime ${usd(run.cost.runtime_usd)}, models ${usd(run.cost.model_usd)})`,
    ...(run.gate
      ? [`  tests first (${run.gate.mode}): ${run.gate.result}, ${run.gate.summary}`]
      : []),
    ...(run.pr_url ? [`  pull request: ${run.pr_url}`] : []),
    ...(run.cancel ? [`  stopped by ${run.cancel.by} (${run.cancel.scope} switch)`] : []),
  ];
}

export function registerRuns(
  program: Command,
  io: () => RunsIo,
  fail: (error: unknown, json?: boolean) => void,
): void {
  program
    .command("run <task...>")
    .description(
      "hand a task to an agent CLI in a sandbox on the team's runtime: a branch, the team's hooks, the tests-first gate and one pull request; it keeps going after this machine disconnects",
    )
    .option(
      "--agent <name>",
      `the agent CLI: ${BACKGROUND_AGENTS.join(", ")} (default: [background] agent)`,
    )
    .option("--repo <owner/name>", "the repository (default: this checkout's origin)")
    .option("--runtime <kind>", "the runtime, such as e2b or daytona (default: the team's)")
    .option("--base <branch>", "the branch to start from (default: the repository's)")
    .option("--team <team>", "the team the run is for (default: yours)")
    .option(
      "--timeout <minutes>",
      "stop it after this long (default: [background] timeout_minutes)",
    )
    .option("--wait", "follow the run until it ends; the exit code is 0 only when it succeeded")
    .option("--json", "print the run as JSON")
    .action(async (words: string[], options: RunOptions) => {
      const deps = io();
      try {
        const { client: api } = client(deps);
        const timeout = options.timeout === undefined ? undefined : Number(options.timeout);
        if (
          timeout !== undefined &&
          (!Number.isInteger(timeout) || timeout < 1 || timeout > 1440)
        ) {
          throw new Error(`--timeout: expected minutes from 1 to 1440, got "${options.timeout}"`);
        }
        const agent = agentOf(options.agent);
        let run = await api.startRun({
          task: words.join(" "),
          repo: repoOf(options, deps),
          source: "cli",
          ...(agent ? { agent } : {}),
          ...(options.runtime ? { runtime: options.runtime } : {}),
          ...(options.base ? { base: options.base } : {}),
          ...(options.team ? { team: options.team } : {}),
          ...(timeout ? { timeout_minutes: timeout } : {}),
        });
        if (!options.json) {
          deps.write(`Started run ${run.id}: ${run.agent} on ${run.repo}, branch ${run.branch}.`);
          deps.write(
            `Follow it: selfhost tail --run ${run.id}   Status: selfhost runs show ${run.id}`,
          );
        }
        if (options.wait) {
          const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
          let state = run.state;
          while (!isFinalRunState(run.state)) {
            await sleep(POLL_MS);
            run = await api.run(run.id);
            if (run.state !== state && !options.json) {
              deps.write(
                `${run.state}${run.health && run.state === "running" ? `, ${run.health.line}` : ""}`,
              );
            }
            state = run.state;
          }
          if (run.state !== "succeeded") deps.setExitCode(1);
        }
        if (options.json) deps.write(JSON.stringify(run, null, 2));
        else if (options.wait) for (const line of describeRun(run)) deps.write(line);
      } catch (error) {
        fail(error, options.json);
      }
    });

  const runs = program
    .command("runs")
    .description(
      "background runs of your teams: list, show, cancel, and the team and org kill switch",
    );

  runs
    .command("list", { isDefault: true })
    .description("runs, newest first")
    .option("--team <team>", "only this team")
    .option("--state <state>", `active, final, or one of ${BACKGROUND_RUN_STATES.join(", ")}`)
    .option("--limit <n>", "at most this many", "20")
    .option("--json", "print JSON")
    .action(async (options: { team?: string; state?: string; limit: string; json?: boolean }) => {
      const deps = io();
      try {
        const { client: api } = client(deps);
        const query: BackgroundRunsQuery = {
          ...(options.team ? { team: options.team } : {}),
          ...(options.state ? { state: options.state as BackgroundRunsQuery["state"] } : {}),
          limit: Number(options.limit),
        };
        const answer = await api.runs(query);
        if (options.json) {
          deps.write(JSON.stringify(answer, null, 2));
          return;
        }
        for (const kill of answer.kills) {
          deps.write(
            `Kill switch on for ${kill.scope} ${kill.target}, by ${kill.by}: new runs are refused.`,
          );
        }
        if (answer.runs.length === 0) {
          deps.write("No background runs.");
          return;
        }
        const now = new Date();
        table(
          [
            ["RUN", "STATE", "AGENT", "REPO", "STARTED", "HEALTH", "COST", "PR"],
            ...answer.runs.map((run) => [
              run.id,
              run.state,
              run.agent,
              run.repo,
              `${ago(run.created_at, now)} ago`,
              run.health?.line ?? "-",
              usd(run.cost.usd),
              run.pr_url ?? "-",
            ]),
          ],
          deps.write,
        );
      } catch (error) {
        fail(error, options.json);
      }
    });

  runs
    .command("show <id>")
    .description("one run: state, health, live cost, the gate and its pull request")
    .option("--json", "print JSON")
    .action(async (id: string, options: { json?: boolean }) => {
      const deps = io();
      try {
        const run = await client(deps).client.run(id);
        if (options.json) deps.write(JSON.stringify(run, null, 2));
        else for (const line of describeRun(run)) deps.write(line);
      } catch (error) {
        fail(error, options.json);
      }
    });

  runs
    .command("cancel <id>")
    .description("stop a run and its sandbox")
    .option("--json", "print JSON")
    .action(async (id: string, options: { json?: boolean }) => {
      const deps = io();
      try {
        const run = await client(deps).client.cancelRun(id);
        if (options.json) deps.write(JSON.stringify(run, null, 2));
        else
          deps.write(
            `Run ${run.id}: ${run.state}${run.cancel ? `, stopped by ${run.cancel.by}` : ""}.`,
          );
      } catch (error) {
        fail(error, options.json);
      }
    });

  runs
    .command("kill")
    .description(
      "the kill switch: stop every run of a team or org and refuse new ones until --clear",
    )
    .option("--team <team>", "the team (default: yours)")
    .option("--org <org>", "the whole org instead")
    .option("--reason <text>", "why, kept with who used it")
    .option("--clear", "turn the switch off")
    .option("--json", "print JSON")
    .action(
      async (options: {
        team?: string;
        org?: string;
        reason?: string;
        clear?: boolean;
        json?: boolean;
      }) => {
        const deps = io();
        try {
          const { client: api, team } = client(deps);
          const scope: KillScope = options.org ? "org" : "team";
          if (!(KILL_SCOPES as readonly string[]).includes(scope)) throw new Error("Unknown scope");
          const target = options.org ?? options.team ?? team;
          const answer = options.clear
            ? await api.clearKill(scope, target)
            : await api.killRuns(scope, target, options.reason);
          if (options.json) deps.write(JSON.stringify(answer, null, 2));
          else if (options.clear)
            deps.write(`Kill switch off for ${scope} ${target}: runs may start again.`);
          else {
            deps.write(
              `Kill switch on for ${scope} ${target}: ${answer.stopped.length} runs stopped, new runs refused until selfhost runs kill --clear.`,
            );
          }
        } catch (error) {
          fail(error, options.json);
        }
      },
    );
}

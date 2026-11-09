import { planAgentConfig } from "@selfhost/agents";
import type { Sandbox } from "@selfhost/runtime";
import type { BackgroundRun } from "@selfhost/schema";
import { AGENT_CLIS, sh } from "./agents.js";

/** A failure while preparing or driving the sandbox that another attempt may not hit. */
export class RuntimeError extends Error {
  override name = "RuntimeError";
}

/** A failure of the run itself (the agent, the gate, the push) that trying again will not fix. */
export class RunFailure extends Error {
  override name = "RunFailure";
}

/**
 * The home folder packages/agents plans the hook settings under. It never exists here, so the plan
 * is a fresh one; its paths are moved to the sandbox's real home before they are written.
 */
const PLAN_HOME = "/nonexistent/selfhost-sandbox-home";

/** The hook command inside the sandbox: the same `selfhost hook` a laptop runs. */
export const SANDBOX_HOOK_COMMAND = "selfhost hook {agent}";

/** The git credential helper: it hands git GITHUB_TOKEN from the environment, never a stored value. */
const CREDENTIAL_HELPER = `!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f`;

export interface Prepared {
  home: string;
  dir: string;
  base: string;
  baseSha: string;
  /** What could not be set up, such as hooks for an agent that has none. */
  notes: string[];
}

async function must(
  sandbox: Sandbox,
  command: string,
  what: string,
  cwd?: string,
): Promise<string> {
  let result: Awaited<ReturnType<Sandbox["exec"]>>;
  try {
    result = await sandbox.exec(command, cwd ? { cwd } : {});
  } catch (error) {
    throw new RuntimeError(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ");
    throw new RunFailure(`${what} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

export interface PrepareOptions {
  /** The team's selfhost.toml text, for the hooks; else the repository's own file is used. */
  policyText?: string;
  /** The base branch; else the repository's default. */
  base?: string;
  /** The selfhost CLI version to install when the image has none. */
  selfhostVersion: string;
}

/**
 * Prepares a fresh sandbox for a run: clones the repository, cuts the run's branch, installs the
 * agent CLI and the selfhost CLI when the image lacks them, and writes the team's hook settings
 * into the agent's own config, so the same rules decide the same tool calls as on a laptop.
 */
export async function prepareSandbox(
  sandbox: Sandbox,
  run: BackgroundRun,
  options: PrepareOptions,
): Promise<Prepared> {
  const agent = AGENT_CLIS[run.agent];
  const notes: string[] = [];
  const home =
    (await must(sandbox, 'printf %s "$HOME"', "Reading the sandbox's home")).trim() || "/root";
  const name = run.repo.split("/")[1] ?? "repo";
  const dir = `${home}/work/${name}`;

  const clone = [
    `mkdir -p ${sh(`${home}/work`)}`,
    `git -c credential.helper=${sh(CREDENTIAL_HELPER)} clone --quiet ${options.base ? `--branch ${sh(options.base)} ` : ""}https://github.com/${run.repo}.git ${sh(dir)}`,
    `git -C ${sh(dir)} config credential.helper ${sh(CREDENTIAL_HELPER)}`,
    `git -C ${sh(dir)} config user.name ${sh("selfhost run")}`,
    `git -C ${sh(dir)} config user.email ${sh("runs@selfhost.ai")}`,
  ].join(" && ");
  await must(sandbox, clone, `Cloning ${run.repo}`);
  const base = (
    await must(sandbox, "git rev-parse --abbrev-ref HEAD", "Reading the base branch", dir)
  ).trim();
  const baseSha = (
    await must(sandbox, "git rev-parse HEAD", "Reading the base commit", dir)
  ).trim();
  await must(sandbox, `git checkout -b ${sh(run.branch)}`, `Creating branch ${run.branch}`, dir);

  await must(
    sandbox,
    `command -v ${agent.bin} >/dev/null 2>&1 || ${agent.install}`,
    `Installing ${agent.bin}`,
  );
  await must(
    sandbox,
    `command -v selfhost >/dev/null 2>&1 || npm install -g selfhostai@${sh(options.selfhostVersion)}`,
    "Installing the selfhost CLI",
  );

  if (options.policyText !== undefined) {
    await sandbox.writeFile(`${home}/.selfhost/run/selfhost.toml`, options.policyText);
  }
  if (agent.hooks) {
    const plan = planAgentConfig(agent.id, {
      home: PLAN_HOME,
      processEnv: {},
      platform: "linux",
      hooks: { command: SANDBOX_HOOK_COMMAND, events: "all" },
    });
    for (const change of plan.changes) {
      if (change.role !== "config" || change.after === null) continue;
      await sandbox.writeFile(change.path.replace(PLAN_HOME, home), change.after);
    }
    for (const item of plan.items) {
      if (item.status === "unsupported" || item.status === "error") {
        notes.push(`${item.item}: ${item.message ?? item.status}`);
      }
    }
  } else {
    notes.push(
      `hooks: ${agent.bin} has no hook settings selfhost can install, so the team's rules are not checked inside this run`,
    );
  }
  return { home, dir, base, baseSha, notes };
}

/** Environment for the agent and the hooks inside the sandbox. */
export function runEnv(run: BackgroundRun, home: string, policy: boolean): Record<string, string> {
  return {
    HOME: home,
    SELFHOST_RUN_ID: run.id,
    ...(run.person ? { SELFHOST_PERSON: run.person } : {}),
    ...(policy ? { SELFHOST_CONFIG: `${home}/.selfhost/run/selfhost.toml` } : {}),
  };
}

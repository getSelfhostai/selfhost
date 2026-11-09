import { type Env, type Probes, systemProbes } from "@selfhost/agents";
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import {
  type AgentsOptions,
  agentsCommand,
  type ConfigureOptions,
  configureCommand,
} from "./agents.js";
import { registerAlerts } from "./alerts/commands.js";
import { registerBrief } from "./brief.js";
import { defaultConfigPath } from "./config-file.js";
import { registerConsole } from "./console.js";
import { registerContext } from "./context/commands.js";
import { registerDecisions } from "./decisions.js";
import { doctor } from "./doctor.js";
import { registerGateway } from "./gateway/commands.js";
import { registerGuard } from "./guard/commands.js";
import { readStdin, runHook } from "./hooks/receive.js";
import { type ImportCommandOptions, type ImportIo, runImport, runWatch } from "./import.js";
import { registerInbox } from "./inbox/commands.js";
import type { OpenLocalReviewList } from "./inbox/sync.js";
import { registerInit } from "./init/commands.js";
import { registerIntegrations } from "./integrations.js";
import { registerLedger } from "./ledger.js";
import { registerMcp } from "./mcp/commands.js";
import { registerMigrate } from "./migrate/commands.js";
import { registerPackages } from "./packages.js";
import { registerPolicy } from "./policy/commands.js";
import { registerPolicyCompile } from "./policy/compile.js";
import { registerPolicyEditing } from "./policy/editing.js";
import { registerProvenance } from "./provenance.js";
import { registerReview } from "./review.js";
import { localReviewList, registerReviewList } from "./review-list.js";
import { registerRoi } from "./roi.js";
import type { CollectAttribution } from "./scan/attribution.js";
import { gitAttribution } from "./scan/git-attribution.js";
import { runScan, type ScanCommandOptions } from "./scan/index.js";
import { type Ask, askOnTerminal, type SendPing } from "./scan/telemetry.js";
import { registerSpend } from "./spend.js";
import type { Fetch } from "./team/client.js";
import { registerTeam } from "./team/commands.js";
import { registerTraces } from "./traces.js";
import { registerUp } from "./up/commands.js";
import type { ImageCheck } from "./up/registry.js";
import { type Exec, systemExec } from "./up/resources.js";

export const VERSION = pkg.version;

/** What the commands read and write; tests pass fixtures instead of the real machine. */
export interface CliDeps {
  env: Env;
  cwd: string;
  platform: NodeJS.Platform;
  probes: Probes;
  write: (line: string) => void;
  writeError: (line: string) => void;
  setExitCode: (code: number) => void;
  now?: Date;
  /** Joins sessions with git and GitHub for `selfhost scan`. */
  collectAttribution?: CollectAttribution;
  /** Asks a yes or no question; undefined when stdin is not a terminal. */
  ask?: Ask;
  /**
   * Whether stdin is a terminal a person types into. Decisions only a person makes (approve,
   * deny, decide, policy promote and push) refuse without one. Default: process.stdin.isTTY.
   */
  stdinIsTTY?: boolean;
  /** Where `selfhost scan` looks for personal context files. Default: the home directory. */
  home?: string;
  /** Where one-time answers and the team membership are kept. Default: ~/.selfhost/config.json. */
  configPath?: string;
  /**
   * HTTP for the team server in team mode, and for the calls `selfhost integrations check` makes
   * to the tools in solo mode. Default: the global fetch.
   */
  fetch?: Fetch;
  /** Retry timing for sends to the team server. */
  retry?: ImportIo["retry"];
  /** Sends the opt-in anonymous agent count. Default: a JSON POST. */
  sendTelemetry?: SendPing;
  /** Solo mode's review list over the local ledger, for `selfhost inbox` and `import --watch`. */
  localReviewList?: OpenLocalReviewList;
  /** Runs ssh and the aws CLI for `selfhost up`. Default: the programs on PATH. */
  exec?: Exec;
  /** Waits between polls in `selfhost up`. */
  sleep?: (ms: number) => Promise<void>;
  /** Whether `selfhost up`'s image tag is in its registry. Default: ask the registry. */
  imageExists?: ImageCheck;
  /** Opens the console in a browser for `selfhost console`. Default: the system's opener. */
  openBrowser?: (url: string, platform: NodeJS.Platform) => void;
  /** Resolves when `selfhost console` should stop. Default: Ctrl-C or SIGTERM. */
  untilStopped?: () => Promise<void>;
}

/** `--json` errors: printed on stdout so a script always gets JSON back. */
export interface ErrorReport {
  schema: "selfhost.error/v1";
  error: string;
}

function defaultDeps(): CliDeps {
  return {
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    probes: systemProbes(process.env, process.platform),
    write: (line) => console.log(line),
    writeError: (line) => console.error(line),
    setExitCode: (code) => {
      process.exitCode = code;
    },
    collectAttribution: gitAttribution(),
    ask: process.stdin.isTTY ? askOnTerminal : undefined,
    stdinIsTTY: process.stdin.isTTY === true,
  };
}

const collect = (value: string, previous: string[]) => [...previous, value];

export function createProgram(overrides: Partial<CliDeps> = {}): Command {
  const deps = { ...defaultDeps(), ...overrides };
  const openLocalList =
    deps.localReviewList ??
    localReviewList({
      env: deps.env,
      cwd: deps.cwd,
      write: deps.write,
      now: deps.now,
      configPath: deps.configPath ?? defaultConfigPath(),
    });
  const fail = (error: unknown, json: boolean | undefined) => {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      const report: ErrorReport = { schema: "selfhost.error/v1", error: message };
      deps.write(JSON.stringify(report, null, 2));
    } else {
      deps.writeError(message);
    }
    deps.setExitCode(1);
  };
  const io = () => ({
    env: deps.env,
    cwd: deps.cwd,
    platform: deps.platform,
    probes: deps.probes,
    write: deps.write,
    now: deps.now,
  });

  const program = new Command()
    .name("selfhost")
    .description("One ledger, one review list, one team config across every coding agent.")
    .version(VERSION, "-v, --version", "print the version")
    .enablePositionalOptions();

  program
    .command("doctor")
    .description("check the runtime and the selfhost.toml in this repository")
    .option("-c, --config <path>", "path to selfhost.toml")
    .option("--json", "print JSON")
    .action((options: { config?: string; json?: boolean }) => {
      deps.setExitCode(
        doctor({
          ...(deps.probes.which ? { which: deps.probes.which } : {}),
          cwd: deps.cwd,
          config: options.config,
          env: deps.env,
          version: VERSION,
          write: deps.write,
          json: options.json,
          configPath: deps.configPath ?? defaultConfigPath(),
        }),
      );
    });

  program
    .command("import")
    .description("import local Claude Code and Codex session logs into the ledger")
    .option("--since <when>", "how far back to read, like 30d, 12h or a date", "30d")
    .option("--vendor <name>", "only claude or codex")
    .option("--watch", "keep tailing the logs after the first import")
    .option("--prompts", "store prompt text (off by default)")
    .option("--person <id>", "who the sessions belong to (default: git email)")
    .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
    .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
    .option("--json", "print JSON (one line per batch with --watch)")
    .action(async (options: ImportCommandOptions) => {
      const importIo: ImportIo = {
        env: deps.env,
        write: deps.write,
        configPath: deps.configPath,
        fetch: deps.fetch,
        retry: deps.retry,
        localReviewList: openLocalList,
      };
      try {
        if (options.watch) await runWatch(options, importIo);
        else if ((await runImport(options, importIo)).sync?.error) deps.setExitCode(1);
      } catch (error) {
        fail(error, options.json);
      }
    });

  const agents = program
    .command("agents")
    .description("list installed coding agents, their logins and their context files")
    .option("--json", "print JSON")
    .option("--home <dir>", "use this folder as the home directory (for testing)")
    .enablePositionalOptions()
    .action((options: AgentsOptions) => {
      try {
        deps.setExitCode(agentsCommand(options, io()));
      } catch (error) {
        fail(error, options.json);
      }
    });

  agents
    .command("configure")
    .description(
      "write selfhost's hooks, env, MCP and OpenTelemetry settings into each agent's own config",
    )
    .option(
      "--agent <name...>",
      "claude, codex, opencode, goose or cursor (default: the ones found)",
    )
    .option("--dry-run", "print the changes as a unified diff and write nothing")
    .option("--remove", "take selfhost's settings out again")
    .option("--otel-endpoint <url>", "OTLP endpoint, like http://127.0.0.1:4318")
    .option("--otel-protocol <protocol>", "http/protobuf (default), http/json or grpc")
    .option("--otel-header <key=value>", "OTLP header, repeatable", collect, [])
    .option("--otel-log-prompts", "export prompt text")
    .option("--otel-traces", "export traces where the agent supports it")
    .option("--hook-command <command>", "command run on each hook event; {agent} is the agent id")
    .option(
      "--mcp <name=command>",
      "MCP server as name=command [args] or name=url, repeatable",
      collect,
      [],
    )
    .option("--env <key=value>", "environment variable for the agent, repeatable", collect, [])
    .option("--json", "print JSON")
    .option("--home <dir>", "use this folder as the home directory (for testing)")
    .action((options: ConfigureOptions) => {
      try {
        deps.setExitCode(configureCommand(options, io()));
      } catch (error) {
        fail(error, options.json);
      }
    });

  program
    .command("scan")
    .description(
      "audit local agent logs: cost by agent and model, leaks, the costliest sessions and, in a git repo, who wrote what",
    )
    .option("--since <when>", "how far back to read, like 30d, 12h or a date", "30d")
    .option("--repo <dir>", "git repository to join the sessions with (default: the one here)")
    .option("--json", "print the report as JSON")
    .option("--report <file>", "write one HTML page with the report")
    .option("--share <file>", "write an SVG image card with the totals")
    .action(async (options: ScanCommandOptions) => {
      try {
        await runScan(options, {
          env: deps.env,
          cwd: deps.cwd,
          home: deps.home,
          platform: deps.platform,
          write: deps.write,
          now: deps.now,
          collectAttribution: deps.collectAttribution,
          ask: deps.ask,
          configPath: deps.configPath,
          sendTelemetry: deps.sendTelemetry,
        });
      } catch (error) {
        fail(error, options.json);
      }
    });

  program
    .command("hook")
    .description(
      "receive one agent hook event, answer pre-tool events and add it to ~/.selfhost/spool (agents run this, not people)",
    )
    .argument("<agent>", "claude, codex, codex-notify, cursor or opencode")
    .argument("[payload]", "the event JSON, for codex-notify; others read it from stdin")
    .action(async (agent: string, payload: string | undefined) => {
      await runHook(payload === undefined ? [agent] : [agent, payload], {
        env: deps.env,
        readStdin,
        writeOutput: (text) => {
          if (text !== "") deps.write(text);
        },
        writeError: deps.writeError,
        now: deps.now,
      });
    });

  registerInit(
    program,
    () => ({
      ...io(),
      setExitCode: deps.setExitCode,
      configPath: deps.configPath,
      fetch: deps.fetch,
      retry: deps.retry,
      ask: deps.ask,
    }),
    fail,
  );

  registerGuard(
    program,
    () => ({
      ...io(),
      setExitCode: deps.setExitCode,
      configPath: deps.configPath ?? defaultConfigPath(),
    }),
    fail,
  );

  registerSpend(program);
  registerAlerts(
    program,
    () => ({
      env: deps.env,
      cwd: deps.cwd,
      write: deps.write,
      setExitCode: deps.setExitCode,
      now: deps.now,
      configPath: deps.configPath ?? defaultConfigPath(),
    }),
    fail,
  );

  registerLedger(
    program,
    () => ({
      env: deps.env,
      cwd: deps.cwd,
      write: deps.write,
      now: deps.now,
      exec: deps.exec ?? systemExec,
    }),
    fail,
  );

  registerTraces(
    program,
    () => ({
      env: deps.env,
      cwd: deps.cwd,
      write: deps.write,
      setExitCode: deps.setExitCode,
      now: deps.now,
    }),
    fail,
  );

  registerPolicy(
    program,
    () => ({
      env: deps.env,
      cwd: deps.cwd,
      write: deps.write,
      setExitCode: deps.setExitCode,
      now: deps.now,
      configPath: deps.configPath ?? defaultConfigPath(),
    }),
    fail,
  );

  registerPolicyEditing(
    program,
    () => ({
      env: deps.env,
      cwd: deps.cwd,
      write: deps.write,
      now: deps.now,
      configPath: deps.configPath ?? defaultConfigPath(),
      stdinIsTTY: deps.stdinIsTTY === true,
    }),
    fail,
  );

  registerPolicyCompile(
    program,
    () => ({
      env: deps.env,
      cwd: deps.cwd,
      platform: deps.platform,
      ...(deps.probes.which ? { which: deps.probes.which } : {}),
      write: deps.write,
      setExitCode: deps.setExitCode,
      now: deps.now,
      configPath: deps.configPath ?? defaultConfigPath(),
      fetch: deps.fetch,
    }),
    fail,
  );

  registerContext(
    program,
    () => ({
      env: deps.env,
      cwd: deps.cwd,
      write: deps.write,
      setExitCode: deps.setExitCode,
      configPath: deps.configPath ?? defaultConfigPath(),
      fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
    }),
    fail,
  );

  registerDecisions(
    program,
    () => ({
      env: deps.env,
      cwd: deps.cwd,
      write: deps.write,
      now: deps.now,
      configPath: deps.configPath ?? defaultConfigPath(),
      stdinIsTTY: deps.stdinIsTTY === true,
    }),
    fail,
  );

  registerPackages(
    program,
    () => ({
      ...io(),
      setExitCode: deps.setExitCode,
      configPath: deps.configPath ?? defaultConfigPath(),
    }),
    fail,
  );

  registerMigrate(
    program,
    () => ({
      env: deps.env,
      cwd: deps.cwd,
      write: deps.write,
      setExitCode: deps.setExitCode,
      now: deps.now,
      configPath: deps.configPath ?? defaultConfigPath(),
    }),
    fail,
  );

  registerReview(
    program,
    () => ({ env: deps.env, cwd: deps.cwd, write: deps.write, now: deps.now }),
    fail,
  );

  registerProvenance(
    program,
    () => ({ env: deps.env, cwd: deps.cwd, write: deps.write, now: deps.now }),
    fail,
  );

  registerRoi(
    program,
    () => ({
      env: deps.env,
      cwd: deps.cwd,
      write: deps.write,
      now: deps.now,
      configPath: deps.configPath ?? defaultConfigPath(),
      fetch: deps.fetch,
    }),
    fail,
  );

  registerBrief(
    program,
    () => ({
      env: deps.env,
      cwd: deps.cwd,
      write: deps.write,
      now: deps.now,
      configPath: deps.configPath ?? defaultConfigPath(),
    }),
    fail,
  );

  registerReviewList(
    program,
    () => ({
      env: deps.env,
      cwd: deps.cwd,
      write: deps.write,
      now: deps.now,
      configPath: deps.configPath ?? defaultConfigPath(),
    }),
    fail,
  );

  registerTeam(
    program,
    () => ({
      env: deps.env,
      cwd: deps.cwd,
      stdinIsTTY: deps.stdinIsTTY === true,
      write: deps.write,
      configPath: deps.configPath ?? defaultConfigPath(),
      fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
    }),
    fail,
  );

  registerIntegrations(
    program,
    () => ({
      env: deps.env,
      cwd: deps.cwd,
      write: deps.write,
      setExitCode: deps.setExitCode,
      configPath: deps.configPath ?? defaultConfigPath(),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    }),
    fail,
  );

  registerUp(
    program,
    () => ({
      env: deps.env,
      write: deps.write,
      setExitCode: deps.setExitCode,
      now: deps.now,
      configPath: deps.configPath ?? defaultConfigPath(),
      fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
      exec: deps.exec ?? systemExec,
      sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      ...(deps.imageExists ? { imageExists: deps.imageExists } : {}),
    }),
    fail,
  );

  registerGateway(
    program,
    () => ({
      env: deps.env,
      write: deps.write,
      configPath: deps.configPath ?? defaultConfigPath(),
      fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
      ...(deps.home ? { home: deps.home } : {}),
    }),
    fail,
  );

  registerConsole(
    program,
    () => ({
      env: deps.env,
      platform: deps.platform,
      write: deps.write,
      version: VERSION,
      configPath: deps.configPath ?? defaultConfigPath(),
      ...(deps.openBrowser ? { openBrowser: deps.openBrowser } : {}),
      ...(deps.untilStopped ? { untilStopped: deps.untilStopped } : {}),
    }),
    fail,
  );

  registerMcp(
    program,
    () => ({
      ...io(),
      setExitCode: deps.setExitCode,
      configPath: deps.configPath ?? defaultConfigPath(),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    }),
    VERSION,
    fail,
  );

  registerInbox(
    program,
    () => ({
      env: deps.env,
      platform: deps.platform,
      write: deps.write,
      setExitCode: deps.setExitCode,
      now: deps.now,
      configPath: deps.configPath ?? defaultConfigPath(),
      fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
      localReviewList: openLocalList,
      stdinIsTTY: deps.stdinIsTTY === true,
    }),
    fail,
  );

  return program;
}

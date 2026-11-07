import { type Env, type Probes, systemProbes } from "@selfhost/agents";
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import {
  type AgentsOptions,
  agentsCommand,
  type ConfigureOptions,
  configureCommand,
} from "./agents.js";
import { doctor } from "./doctor.js";
import { type ImportCommandOptions, runImport, runWatch } from "./import.js";

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
  };
}

const collect = (value: string, previous: string[]) => [...previous, value];

export function createProgram(overrides: Partial<CliDeps> = {}): Command {
  const deps = { ...defaultDeps(), ...overrides };
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
          cwd: deps.cwd,
          config: options.config,
          env: deps.env,
          version: VERSION,
          write: deps.write,
          json: options.json,
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
      const importIo = { env: deps.env, write: deps.write };
      try {
        if (options.watch) await runWatch(options, importIo);
        else await runImport(options, importIo);
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

  return program;
}

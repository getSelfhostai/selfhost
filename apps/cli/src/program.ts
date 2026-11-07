import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { doctor } from "./doctor.js";
import { type ImportCommandOptions, runImport, runWatch } from "./import.js";

export const VERSION = pkg.version;

export function createProgram(): Command {
  const program = new Command()
    .name("selfhost")
    .description("One ledger, one review list, one team config across every coding agent.")
    .version(VERSION, "-v, --version", "print the version");

  program
    .command("doctor")
    .description("check the runtime and the selfhost.toml in this repository")
    .option("-c, --config <path>", "path to selfhost.toml")
    .action((options: { config?: string }) => {
      process.exitCode = doctor({
        cwd: process.cwd(),
        config: options.config,
        env: process.env,
        version: VERSION,
        write: (line) => console.log(line),
      });
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
    .action(async (options: ImportCommandOptions) => {
      const io = { env: process.env, write: (line: string) => console.log(line) };
      try {
        if (options.watch) await runWatch(options, io);
        else await runImport(options, io);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });

  return program;
}

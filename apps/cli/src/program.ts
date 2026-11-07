import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { doctor } from "./doctor.js";

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

  return program;
}

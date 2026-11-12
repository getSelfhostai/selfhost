import { type Command, CommanderError } from "commander";
import { describe, expect, it } from "vitest";
import { createProgram } from "../src/program.js";
import { tempDir } from "./run.js";

function program(): Command {
  return createProgram({
    env: {},
    platform: "linux",
    probes: {},
    write: () => {},
    writeError: () => {},
    setExitCode: () => {},
    ask: undefined,
    configPath: tempDir("help-config").path("config.json"),
    home: tempDir("help-home").root,
    systemRoot: tempDir("help-system").root,
    hostname: "test-laptop",
  });
}

function each(command: Command, visit: (command: Command) => void) {
  visit(command);
  for (const sub of command.commands) each(sub, visit);
}

/** What `selfhost <args>` prints for help, in process, without exiting. */
async function help(args: string[]): Promise<string> {
  const root = program();
  let out = "";
  each(root, (command) => {
    command.exitOverride();
    command.configureOutput({
      writeOut: (text) => {
        out += text;
      },
      writeErr: (text) => {
        out += text;
      },
    });
  });
  try {
    await root.parseAsync(["node", "selfhost", ...args]);
  } catch (error) {
    if (!(error instanceof CommanderError) || error.code !== "commander.helpDisplayed") throw error;
  }
  return out;
}

describe("--help", () => {
  // Every `selfhost <group> <sub> --help` prints that subcommand's help, never the top level's.
  const pairs = program().commands.flatMap((group) =>
    group.commands.map((sub) => [group.name(), sub.name()] as const),
  );

  it("has nested commands to check", () => {
    expect(pairs).toContainEqual(["team", "init"]);
    expect(pairs).toContainEqual(["runtime", "reap"]);
  });

  it.each(pairs)("selfhost %s %s --help prints its own help", async (group, sub) => {
    const out = await help([group, sub, "--help"]);
    expect(out.split("\n")[0]).toMatch(new RegExp(`^Usage: selfhost ${group} ${sub}\\b`));
  });
});

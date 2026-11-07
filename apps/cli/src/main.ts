#!/usr/bin/env node

// Agents run `selfhost hook` on every hook event, so it skips loading the rest of the CLI.
if (process.argv[2] === "hook") {
  const { hookMain } = await import("./hooks/receive.js");
  process.exitCode = await hookMain(process.argv.slice(3));
} else {
  const { createProgram } = await import("./program.js");
  await createProgram().parseAsync(process.argv);
}

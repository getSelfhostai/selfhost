#!/usr/bin/env node
import { nodeVersionProblem } from "./node-version.js";

// Before anything that needs Node 20 is loaded: an older Node gets one line saying so.
const tooOld = nodeVersionProblem(process.versions);
if (tooOld) {
  process.stderr.write(`${tooOld}\n`);
  process.exit(1);
}

// Agents run `selfhost hook` on every hook event, so it skips loading the rest of the CLI.
if (process.argv[2] === "hook") {
  const { hookMain } = await import("./hooks/receive.js");
  process.exitCode = await hookMain(process.argv.slice(3));
} else {
  const { createProgram } = await import("./program.js");
  await createProgram().parseAsync(process.argv);
}

import { errorLine, escapeCommand, main } from "./main.js";

// The GitHub Action's entry point: `node action/index.mjs run` or `... report`.
main(process.argv[2], { env: process.env, log: (line) => console.log(line) }).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.log(`::error::${escapeCommand(`Proof receipt: ${errorLine(error)}`)}`);
    process.exitCode = 1;
  },
);

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Compiles the CLI into standalone selfhost binaries with `bun build --compile`.
// Usage: pnpm build:cli [target...], for example `pnpm build:cli bun-darwin-arm64`.

const TARGETS = ["bun-linux-x64", "bun-linux-arm64", "bun-darwin-arm64", "bun-darwin-x64"];

const root = join(import.meta.dirname, "..");
const requested = process.argv.slice(2);
const unknown = requested.filter((target) => !TARGETS.includes(target));
if (unknown.length > 0) {
  console.error(`Unknown target: ${unknown.join(", ")}. Known targets: ${TARGETS.join(", ")}`);
  process.exit(2);
}

// Locally, build only for this machine; CI builds every target.
const hostTarget = `bun-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const defaults = process.env.CI ? TARGETS : TARGETS.filter((target) => target === hostTarget);

mkdirSync(join(root, "dist"), { recursive: true });
for (const target of requested.length > 0 ? requested : defaults) {
  const outfile = join("dist", `selfhost-${target.replace(/^bun-/, "")}`);
  console.log(`building ${outfile}`);
  const result = spawnSync(
    "bun",
    ["build", "--compile", "--minify", `--target=${target}`, "src/main.ts", "--outfile", outfile],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) {
    console.error(`Could not run bun: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

#!/usr/bin/env node
// Packs the built CLI (apps/cli/dist, from `pnpm --filter "@selfhost/cli..." --filter
// @selfhost/console build`) as the npm package `selfhostai`, ready for `npm publish <tarball>`.
//
// The workspace packages are already bundled into dist by tsup (noExternal: @selfhost/*), so the
// package.json written here drops them and lists only the CLI's own npm dependencies, at the
// versions of the pnpm catalog. It fails when the bundle imports a package that list lacks, or
// still imports a workspace package. Installs both bins: `selfhostai` (what `npx selfhostai`
// runs) and `selfhost`.
//
// Usage: node scripts/release/pack-cli.mjs [--out dir]   (default: apps/cli/release)
// Prints the tarball's path. GITHUB_REPOSITORY (owner/name, set in GitHub Actions) names the
// repository in package.json, which npm provenance checks against the repository publishing it.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";
import { githubOwner, ROOT, sourceVersion } from "./version.mjs";

export const PACKAGE_NAME = "selfhostai";
const CLI = join(ROOT, "apps/cli");
const DIST = join(CLI, "dist");

/** The `catalog:` versions of pnpm-workspace.yaml. */
function catalog() {
  const text = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const block = /^catalog:\n((?:[ \t]+.*\n?)*)/m.exec(text)?.[1] ?? "";
  const versions = {};
  for (const line of block.split("\n")) {
    const match = /^\s+"?([^":\s]+)"?:\s*"?([^"\s]+)"?\s*$/.exec(line);
    if (match) versions[match[1]] = match[2];
  }
  return versions;
}

/** The npm dependencies of the published package: the CLI's, workspace packages left out. */
function dependencies(cli) {
  const versions = catalog();
  const out = {};
  for (const [name, spec] of Object.entries(cli.dependencies ?? {})) {
    if (spec.startsWith("workspace:")) continue;
    if (spec === "catalog:" || spec === "catalog:default") {
      if (!versions[name]) throw new Error(`${name} is catalog: but not in the pnpm catalog`);
      out[name] = versions[name];
    } else if (spec.startsWith("catalog:")) {
      throw new Error(`${name}: named catalogs (${spec}) are not supported here`);
    } else {
      out[name] = spec;
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const SPECIFIER = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w./-]*)?$/;

/** The package names the bundle imports at runtime, builtins left out. */
export function bundleImports(dir = DIST) {
  const found = new Set();
  const patterns = [
    /(?:^|[\s;})])(?:import|export)\s*(?:[\w*{},\s$]+\s*from\s*)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".js")) continue;
    // Comment lines left out: bundled JSDoc shows imports in its examples.
    const text = readFileSync(join(dir, file), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line))
      .join("\n");
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const spec = match[1];
        if (spec.startsWith(".") || BUILTINS.has(spec) || BUILTINS.has(spec.split("/")[0])) {
          continue;
        }
        if (!SPECIFIER.test(spec)) continue;
        const parts = spec.split("/");
        found.add(spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
      }
    }
  }
  return [...found].sort();
}

export function packageJson() {
  const cli = JSON.parse(readFileSync(join(CLI, "package.json"), "utf8"));
  const repo = process.env.GITHUB_REPOSITORY || `${githubOwner()}/selfhost`;
  return {
    name: PACKAGE_NAME,
    version: sourceVersion(),
    description: cli.description,
    keywords: ["coding-agents", "claude-code", "codex", "cursor", "opencode", "guardrails", "mcp"],
    homepage: `https://github.com/${repo}#readme`,
    bugs: { url: `https://github.com/${repo}/issues` },
    repository: { type: "git", url: `git+https://github.com/${repo}.git`, directory: "apps/cli" },
    license: cli.license,
    type: "module",
    bin: { selfhostai: "dist/main.js", selfhost: "dist/main.js" },
    files: [...cli.files, "ee/LICENSE"],
    engines: cli.engines,
    dependencies: dependencies(cli),
  };
}

function main(args) {
  const outIndex = args.indexOf("--out");
  const out = resolve(outIndex === -1 ? join(CLI, "release") : args[outIndex + 1]);
  if (!existsSync(join(DIST, "main.js")) || !existsSync(join(DIST, "console/index.html"))) {
    console.error(
      'apps/cli/dist is not built. Run: pnpm --filter "@selfhost/cli..." --filter @selfhost/console build',
    );
    return 1;
  }

  const pkg = packageJson();
  // Once published, a workspace name would resolve to whatever public npm holds under it.
  const local = Object.entries(pkg.dependencies).filter(
    ([name, spec]) => name.startsWith("@selfhost/") || /^(workspace|catalog|link|file):/.test(spec),
  );
  if (local.length > 0) {
    console.error(`package.json would depend on workspace packages: ${local.map(([n]) => n)}`);
    return 1;
  }
  const imports = bundleImports();
  const workspace = imports.filter((name) => name.startsWith("@selfhost/"));
  const missing = imports.filter((name) => !workspace.includes(name) && !pkg.dependencies[name]);
  if (workspace.length > 0 || missing.length > 0) {
    if (workspace.length > 0) console.error(`The bundle imports workspace packages: ${workspace}`);
    if (missing.length > 0) {
      console.error(`The bundle imports packages apps/cli/package.json does not list: ${missing}`);
    }
    return 1;
  }

  const stage = join(out, "package");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "dist"), { recursive: true });
  for (const file of readdirSync(DIST)) {
    if (file.endsWith(".js")) cpSync(join(DIST, file), join(stage, "dist", file));
  }
  cpSync(join(DIST, "console"), join(stage, "dist/console"), { recursive: true });
  for (const file of ["AGENTS.md", "llms.txt"]) cpSync(join(CLI, file), join(stage, file));
  cpSync(join(ROOT, "README.md"), join(stage, "README.md"));
  cpSync(join(ROOT, "LICENSE"), join(stage, "LICENSE"));
  cpSync(join(ROOT, "ee/LICENSE"), join(stage, "ee/LICENSE"));
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", out], {
      cwd: stage,
      encoding: "utf8",
    }),
  );
  console.log(join(out, packed[0].filename));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = main(process.argv.slice(2));
}

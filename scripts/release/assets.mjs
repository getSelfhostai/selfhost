#!/usr/bin/env node

// Gathers the files a GitHub Release carries into one folder, and writes SHA256SUMS over them:
//
//   selfhost-<platform>                 the bun-compiled binaries (pnpm build:cli), when built
//   selfhostai-<version>.tgz            the npm package (scripts/release/pack-cli.mjs)
//   selfhost-docker-<version>.tar.gz    deploy/docker as `selfhost up` ships it, for a Compose
//                                       install without a clone
//   <name>.json                         the JSON Schemas of packages/schema/json, each named after
//                                       the last part of its $id (selfhost.toml.v1.json, ...)
//   schemas.json                        each schema file with the URL path of its $id
//
// Usage: node scripts/release/assets.mjs <npm tarball> <out dir>

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { ROOT, sourceVersion } from "./version.mjs";

const DOCKER = join(ROOT, "deploy/docker");
const SCHEMAS = join(ROOT, "packages/schema/json");
const CLI_DIST = join(ROOT, "apps/cli/dist");

/** STACK_PATHS of deploy/scripts/stack.ts: the files `selfhost up` puts on a server. */
function stackPaths() {
  const text = readFileSync(join(ROOT, "deploy/scripts/stack.ts"), "utf8");
  const list = /export const STACK_PATHS = \[([\s\S]*?)\] as const;/.exec(text)?.[1];
  if (!list) throw new Error("deploy/scripts/stack.ts has no STACK_PATHS list");
  return [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function dockerTarball(version, out) {
  const name = `selfhost-docker-${version}`;
  const stage = join(out, ".stage");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, name), { recursive: true });
  for (const path of [...stackPaths(), "README.md"]) {
    cpSync(join(DOCKER, path), join(stage, name, path));
    chmodSync(join(stage, name, path), statSync(join(DOCKER, path)).mode & 0o777);
  }
  const file = `${name}.tar.gz`;
  execFileSync("tar", ["-czf", join(out, file), "-C", stage, name]);
  rmSync(stage, { recursive: true, force: true });
  return file;
}

function schemas(out) {
  const index = [];
  for (const file of readdirSync(SCHEMAS).sort()) {
    if (!file.endsWith(".json")) continue;
    const schema = JSON.parse(readFileSync(join(SCHEMAS, file), "utf8"));
    const id = new URL(schema.$id);
    const name = basename(id.pathname);
    cpSync(join(SCHEMAS, file), join(out, name));
    index.push({
      file: name,
      path: id.pathname,
      id: schema.$id,
      source: `packages/schema/json/${file}`,
    });
  }
  writeFileSync(join(out, "schemas.json"), `${JSON.stringify(index, null, 2)}\n`);
  return [...index.map((entry) => entry.file), "schemas.json"];
}

function main(args) {
  if (args.length !== 2) {
    console.error("usage: node scripts/release/assets.mjs <npm tarball> <out dir>");
    return 2;
  }
  const version = sourceVersion();
  const tarball = resolve(args[0]);
  const out = resolve(args[1]);
  if (basename(tarball) !== `selfhostai-${version}.tgz`) {
    console.error(`${basename(tarball)} is not the npm package of ${version}`);
    return 1;
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const files = [];
  for (const file of readdirSync(CLI_DIST).sort()) {
    if (!/^selfhost-(linux|darwin|windows)-/.test(file)) continue;
    cpSync(join(CLI_DIST, file), join(out, file));
    files.push(file);
  }
  cpSync(tarball, join(out, basename(tarball)));
  files.push(basename(tarball), dockerTarball(version, out), ...schemas(out));

  const sums = files.sort().map(
    (file) =>
      `${createHash("sha256")
        .update(readFileSync(join(out, file)))
        .digest("hex")}  ${file}`,
  );
  writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
  for (const file of [...files, "SHA256SUMS"]) console.log(file);
  return 0;
}

process.exitCode = main(process.argv.slice(2));

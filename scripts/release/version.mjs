#!/usr/bin/env node
// The release version and the GitHub owner, kept in step everywhere they are written down.
//
// The version in the root package.json is the source. The image owner is GITHUB_OWNER in
// apps/cli/src/project.ts. This script copies both to the CLI and server packages (the npm
// package and the image report them), every workspace package that is not private,
// SELFHOST_VERSION in deploy/docker/.env.example (the release `selfhost up` and the Docker Compose
// install run), the image and repository defaults in deploy/docker and the READMEs, and then
// embeds deploy/docker in the CLI again (pnpm --filter @selfhost/deploy embed-stack).
//
// Usage:
//   node scripts/release/version.mjs 0.2.0          set the version, then sync
//   node scripts/release/version.mjs                 sync the current version and owner
//   node scripts/release/version.mjs --check         exit 1 when anything disagrees
//   node scripts/release/version.mjs --check --tag v0.2.0 --changelog --owner getselfhostai
//                                                    also the tag, a CHANGELOG.md section, and
//                                                    the GitHub owner releasing it
//   node scripts/release/version.mjs --print         print the version

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Packages whose version is shown to people: `selfhost --version` and the server's /v1/health. */
const VERSIONED = ["package.json", "apps/cli/package.json", "apps/server/package.json"];
const WORKSPACE_DIRS = ["apps", "packages", "ee", "adapters"];
const ENV_EXAMPLE = "deploy/docker/.env.example";
const STACK_MODULE = "deploy/src/stack.generated.ts";
const PROJECT = "apps/cli/src/project.ts";
/** Files that name the image or the repository by owner. */
const OWNER_FILES = [
  "README.md",
  "apps/cli/README.md",
  "deploy/docker/README.md",
  "deploy/docker/compose.yml",
  "deploy/docker/install.sh",
  "deploy/docker/upgrade.sh",
  "deploy/docker/.env.example",
  "ee/receipt/README.md",
  // The bootstrap script selfhost up writes, which embeds deploy/docker.
  "apps/cli/test/__snapshots__/up-bootstrap.sh",
];
/** ghcr.io names are lower case. */
const IMAGE_PATTERN = /(ghcr\.io\/)([A-Za-z0-9-]+)(\/selfhost\b)/g;
/** GitHub ignores case here, so a link may spell the owner as the org does (getSelfhostai). */
const REPO_PATTERNS = [
  /(github\.com\/)([A-Za-z0-9-]+)(\/selfhost\b)/g,
  /(uses: )([A-Za-z0-9-]+)(\/selfhost\/)/g,
  /(--repo )([A-Za-z0-9-]+)(\/selfhost\b)/g,
];

const read = (path) => readFileSync(join(ROOT, path), "utf8");
const write = (path, text) => writeFileSync(join(ROOT, path), text);

export function sourceVersion() {
  return JSON.parse(read("package.json")).version;
}

export function githubOwner() {
  const owner = /^export const GITHUB_OWNER = "([^"]+)";$/m.exec(read(PROJECT))?.[1];
  if (!owner) throw new Error(`${PROJECT} has no GITHUB_OWNER line`);
  return owner;
}

/** Every package.json whose version follows the release. */
function versionedPackages() {
  const found = new Set(VERSIONED);
  for (const dir of WORKSPACE_DIRS) {
    let entries = [];
    try {
      entries = readdirSync(join(ROOT, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = `${dir}/${entry.name}/package.json`;
      try {
        if (JSON.parse(read(path)).private !== true) found.add(path);
      } catch {
        // A folder without a package.json is not a package.
      }
    }
  }
  return [...found];
}

/** The text with its first "version" field set, formatting kept. */
function withVersion(text, version) {
  return text.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`);
}

/** Install examples that name the current release. Every npx selfhostai in them is pinned. */
const DOC_VERSION_FILES = [
  "README.md",
  "deploy/docker/README.md",
  "apps/cli/README.md",
  "apps/cli/AGENTS.md",
  "apps/cli/llms.txt",
];
const UNPINNED_NPX = /\bnpx (?:-y |--yes )?selfhostai(?!@)\b/;

function withDocVersion(text, version) {
  return text
    .replace(/^version=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/gm, `version=${version}`)
    .replace(
      /(ghcr\.io\/[A-Za-z0-9-]+\/selfhost:)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g,
      `$1${version}`,
    )
    .replace(/\bselfhostai@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g, `selfhostai@${version}`);
}

function withOwner(text, owner) {
  const image = text.replace(
    IMAGE_PATTERN,
    (_, before, _old, after) => before + owner.toLowerCase() + after,
  );
  return REPO_PATTERNS.reduce(
    (out, pattern) =>
      out.replace(
        pattern,
        (_, before, old, after) =>
          before + (old.toLowerCase() === owner.toLowerCase() ? old : owner) + after,
      ),
    image,
  );
}

function envVersion(text) {
  return /^SELFHOST_VERSION=(\S*)$/m.exec(text)?.[1];
}

function embedStack() {
  execFileSync("pnpm", ["--silent", "--filter", "@selfhost/deploy", "embed-stack"], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

/** stack.generated.ts as embed-stack would write it now. */
function expectedStack() {
  return execFileSync(
    "pnpm",
    [
      "--silent",
      "--filter",
      "@selfhost/deploy",
      "exec",
      "tsx",
      "--eval",
      'import("./scripts/stack.ts").then((m) => process.stdout.write(m.buildStackModule()))',
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
}

export function sync(version) {
  const owner = githubOwner();
  const changed = [];
  const update = (path, next) => {
    if (read(path) !== next) {
      write(path, next);
      changed.push(path);
    }
  };
  for (const path of versionedPackages()) update(path, withVersion(read(path), version));
  update(
    ENV_EXAMPLE,
    read(ENV_EXAMPLE).replace(/^SELFHOST_VERSION=.*$/m, `SELFHOST_VERSION=${version}`),
  );
  for (const path of OWNER_FILES) update(path, withOwner(read(path), owner));
  for (const path of DOC_VERSION_FILES) update(path, withDocVersion(read(path), version));
  const before = read(STACK_MODULE);
  embedStack();
  if (read(STACK_MODULE) !== before) changed.push(STACK_MODULE);
  return changed;
}

/** Every place that disagrees with the source version and owner, as one line each. */
export function problems({ tag, changelog, releaseOwner } = {}) {
  const version = sourceVersion();
  const owner = githubOwner();
  const out = [];
  if (!SEMVER.test(version)) out.push(`package.json: version "${version}" is not x.y.z`);
  for (const path of versionedPackages()) {
    const found = JSON.parse(read(path)).version;
    if (found !== version) out.push(`${path}: version ${found}, expected ${version}`);
  }
  const env = envVersion(read(ENV_EXAMPLE));
  if (env !== version) out.push(`${ENV_EXAMPLE}: SELFHOST_VERSION=${env}, expected ${version}`);
  for (const path of DOC_VERSION_FILES) {
    const text = read(path);
    if (withDocVersion(text, version) !== text) {
      out.push(`${path}: an install example names a version other than ${version}`);
    }
    if (UNPINNED_NPX.test(text)) {
      out.push(`${path}: npx selfhostai without a version; write selfhostai@${version}`);
    }
  }
  for (const path of OWNER_FILES) {
    const text = read(path);
    if (withOwner(text, owner) !== text) out.push(`${path}: names an owner other than ${owner}`);
  }
  if (read(STACK_MODULE) !== expectedStack()) {
    out.push(`${STACK_MODULE}: does not embed deploy/docker as it is now`);
  }
  if (tag !== undefined && tag !== `v${version}`) {
    out.push(`tag ${tag} does not match the version: expected v${version}`);
  }
  // The image goes to ghcr.io/<releasing owner>/selfhost, which `selfhost up` must default to.
  if (releaseOwner !== undefined && releaseOwner.toLowerCase() !== owner.toLowerCase()) {
    out.push(
      `${PROJECT}: GITHUB_OWNER is ${owner}, but ${releaseOwner} releases, so selfhost up would look for an image that is not there`,
    );
  }
  if (changelog && changelogSection(version) === undefined) {
    out.push(`CHANGELOG.md: no "## ${version}" section`);
  }
  return out;
}

/** The body of the CHANGELOG.md section for a version, without its heading. */
export function changelogSection(version) {
  const lines = read("CHANGELOG.md").split("\n");
  const heading = new RegExp(`^## \\[?${version.replaceAll(".", "\\.")}\\]?(?:\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return undefined;
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
}

function main(args) {
  const flag = (name) => args.includes(name);
  const option = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  if (flag("--print")) {
    console.log(sourceVersion());
    return 0;
  }
  if (flag("--check")) {
    const found = problems({
      tag: option("--tag"),
      changelog: flag("--changelog"),
      releaseOwner: option("--owner"),
    });
    for (const line of found) console.error(line);
    if (found.length > 0) {
      console.error("Run: pnpm release:version, or pnpm release:version <x.y.z> for a new release");
      return 1;
    }
    console.log(`version ${sourceVersion()} and owner ${githubOwner()} agree everywhere`);
    return 0;
  }
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const version = positional[0] ?? sourceVersion();
  if (!SEMVER.test(version)) {
    console.error(`Not a version: ${version}. Expected x.y.z, for example 0.2.0`);
    return 2;
  }
  const root = read("package.json");
  if (withVersion(root, version) !== root) {
    write("package.json", withVersion(root, version));
    console.log("updated package.json");
  }
  for (const path of sync(version)) console.log(`updated ${path}`);
  console.log(`version ${version}, owner ${githubOwner()}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

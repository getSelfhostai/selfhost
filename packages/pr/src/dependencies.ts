import { posix } from "node:path";
import type { ManifestChange, NewDependency } from "./types.js";

/**
 * New direct dependencies: names in a manifest after the change that were not in it before.
 * Each format is read just far enough to list dependency names; versions, extras and markers
 * are ignored, so a version bump is not a new dependency.
 */

type Names = (text: string) => Set<string>;

function packageJsonNames(text: string): Set<string> {
  const names = new Set<string>();
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return names;
  }
  if (typeof manifest !== "object" || manifest === null) return names;
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const section = (manifest as Record<string, unknown>)[field];
    if (typeof section === "object" && section !== null) {
      for (const name of Object.keys(section)) names.add(name);
    }
  }
  return names;
}

/** PEP 503 normalized names, so `Foo_Bar` and `foo-bar` are the same package. */
function requirementsNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s#.*$/, "").trim();
    if (line === "" || line.startsWith("#") || line.startsWith("-")) continue;
    const name = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line)?.[1];
    if (name) names.add(name.toLowerCase().replace(/[-_.]+/g, "-"));
  }
  return names;
}

/** Direct requirements; lines marked `// indirect` are other modules' dependencies. */
function goModNames(text: string): Set<string> {
  const names = new Set<string>();
  let inBlock = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (inBlock) {
      if (line.startsWith(")")) inBlock = false;
      else if (!line.includes("// indirect")) {
        const name = /^(\S+)\s+v\S+/.exec(line)?.[1];
        if (name) names.add(name);
      }
      continue;
    }
    if (/^require\s*\($/.test(line)) inBlock = true;
    else if (!line.includes("// indirect")) {
      const name = /^require\s+(\S+)\s+v\S+/.exec(line)?.[1];
      if (name) names.add(name);
    }
  }
  return names;
}

const CARGO_SECTION = /^(?:.*\.)?(?:dev-|build-)?dependencies$/;
const CARGO_TABLE = /^(?:.*\.)?(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/;

/** Keys of every [dependencies]-like table, including [target.*] and [workspace] ones. */
function cargoNames(text: string): Set<string> {
  const names = new Set<string>();
  let inSection = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const header = /^\[([^[\]]+)\]$/.exec(line)?.[1]?.trim();
    if (header !== undefined) {
      const table = CARGO_TABLE.exec(header)?.[1];
      if (table) names.add(table);
      inSection = CARGO_SECTION.test(header);
      continue;
    }
    if (!inSection) continue;
    const name = /^([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]+)?\s*=/.exec(line)?.[1];
    if (name) names.add(name);
  }
  return names;
}

/** Manifests by file name. */
function manifestNames(path: string): Names | undefined {
  const name = posix.basename(path);
  if (name === "package.json") return packageJsonNames;
  if (/^requirements.*\.(?:txt|in)$/.test(name)) return requirementsNames;
  if (name === "go.mod") return goModNames;
  if (name === "Cargo.toml") return cargoNames;
  return undefined;
}

/** Lockfiles list resolved versions; they count toward dependencies, never toward size. */
export const LOCKFILES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "go.sum",
  "Cargo.lock",
]);

export function isLockfile(path: string): boolean {
  return LOCKFILES.has(posix.basename(path));
}

export function isManifest(path: string): boolean {
  return manifestNames(path) !== undefined;
}

/** Dependencies each manifest gained, sorted by manifest and name. */
export function newDependencies(changes: ManifestChange[]): NewDependency[] {
  const found: NewDependency[] = [];
  for (const change of changes) {
    const names = manifestNames(change.path);
    if (!names || change.after === undefined) continue;
    const before = change.before === undefined ? new Set<string>() : names(change.before);
    for (const name of names(change.after)) {
      if (!before.has(name)) found.push({ manifest: change.path, name });
    }
  }
  return found.sort((a, b) => compare(a.manifest, b.manifest) || compare(a.name, b.name));
}

export const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

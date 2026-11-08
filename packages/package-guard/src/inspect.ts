import semver from "semver";
import type { PackageRequest } from "./parse.js";
import {
  depsDevPackage,
  goProxyInfo,
  type LookupContext,
  npmVersion,
  osvMalicious,
  type PackageFacts,
  pypiRelease,
  type Result,
  registryHas,
} from "./registry.js";

/** What the registries say about one requested package. */
export interface Inspection {
  /** The name the registry files it under, when it differs from the request. */
  name?: string;
  /** false: no package by this name. Undefined: could not tell. */
  exists?: boolean;
  /** The package exists but has no version matching this. */
  missingVersion?: string;
  /** The version the install gets. */
  version?: string;
  /** When `version` was published; null when the registry has it but deps.dev does not list it yet. */
  publishedAt?: string | null;
  /** Why the version could not be pinned down, so its age is not checked. */
  versionNote?: string;
  /** npm lifecycle scripts that run at install. */
  scripts?: string[];
  /** A PyPI release with no wheel: pip runs its build code. */
  noWheel?: boolean;
  /** MAL- advisory ids. */
  malicious?: string[];
  /** Lookups that failed, as "service: reason". */
  errors: string[];
}

export interface Needs {
  age: boolean;
  scripts: boolean;
}

function take<T>(result: Result<T> | undefined, errors: string[]): T | undefined {
  if (result === undefined) return undefined;
  if (result.ok) return result.value;
  errors.push(result.error);
  return undefined;
}

/** The newest version satisfying a semver range, preferring the default the way npm does. */
function resolveRange(facts: PackageFacts, range: string): string | undefined {
  const versions = Object.keys(facts.versions);
  if (facts.default && semver.satisfies(facts.default, range)) return facts.default;
  return semver.maxSatisfying(versions, range) ?? undefined;
}

async function malware(
  ctx: LookupContext,
  pkg: PackageRequest,
  out: Inspection,
  name: string,
): Promise<void> {
  // A missing package is asked about by name: a removed malicious package keeps its advisory.
  const version = out.exists === false ? undefined : out.version;
  const ids = take(await osvMalicious(ctx, pkg.ecosystem, name, version), out.errors);
  if (ids && ids.length > 0) out.malicious = ids;
}

async function inspectNpm(
  ctx: LookupContext,
  pkg: PackageRequest,
  needs: Needs,
): Promise<Inspection> {
  const out: Inspection = { errors: [] };
  const { spec } = pkg;
  const exact = spec !== undefined && semver.valid(spec) !== null;
  const range = spec !== undefined && !exact && semver.validRange(spec) !== null;
  const asked = exact ? (semver.valid(spec) ?? spec) : range ? undefined : (spec ?? "latest");
  const [factsResult, manifestResult] = await Promise.all([
    depsDevPackage(ctx, "npm", pkg.name),
    asked === undefined ? undefined : npmVersion(ctx, pkg.name, asked, exact),
  ]);
  const facts = take(factsResult, out.errors);
  let manifest = take(manifestResult, out.errors);
  if (manifest?.found === "no_package") out.exists = false;
  else if (manifest?.found === "no_version") {
    out.exists = true;
    out.missingVersion = spec ?? "latest";
  } else if (manifest?.found === "yes") {
    out.exists = true;
    out.version = manifest.version;
  }
  if (facts?.found) {
    out.exists ??= true;
    if (range && spec !== undefined) {
      out.version = resolveRange(facts, spec);
      if (out.version === undefined) out.missingVersion = spec;
    }
  } else if (facts && !manifest) {
    // deps.dev has no such package and the registry was not asked yet (a range): ask it.
    manifest = take(await npmVersion(ctx, pkg.name, "latest", false), out.errors);
    if (manifest?.found === "no_package") out.exists = false;
    else if (manifest?.found === "yes") {
      out.exists = true;
      out.versionNote = "deps.dev does not list the package yet, so the range was not resolved";
    }
  }
  if (out.version !== undefined && facts) {
    out.publishedAt = facts.versions[out.version] ?? null;
  }
  const followUps: Promise<void>[] = [malware(ctx, pkg, out, pkg.name)];
  if (needs.scripts && out.version !== undefined && out.missingVersion === undefined) {
    const version = out.version;
    followUps.push(
      (async () => {
        const own =
          manifest?.found === "yes" && manifest.version === version
            ? manifest
            : take(await npmVersion(ctx, pkg.name, version, true), out.errors);
        if (own?.found === "yes") out.scripts = own.scripts;
      })(),
    );
  }
  await Promise.all(followUps);
  return out;
}

/** `==1.2.3` or `===1.2.3`: one exact version. */
const PYPI_EXACT = /^===?([A-Za-z0-9.+!-]+)$/;

async function inspectPypi(
  ctx: LookupContext,
  pkg: PackageRequest,
  needs: Needs,
): Promise<Inspection> {
  const out: Inspection = { errors: [] };
  const exact = pkg.spec === undefined ? undefined : PYPI_EXACT.exec(pkg.spec)?.[1];
  const facts = take(await depsDevPackage(ctx, "pypi", pkg.name), out.errors);
  if (facts?.found) {
    out.exists = true;
    if (facts.name && facts.name !== pkg.name) out.name = facts.name;
    out.version = exact ?? facts.default;
    if (out.version !== undefined) out.publishedAt = facts.versions[out.version] ?? null;
  } else if (facts) {
    const found = take(await registryHas(ctx, "pypi", pkg.name), out.errors);
    if (found !== undefined) out.exists = found;
    if (found) {
      out.version = exact;
      if (exact === undefined) out.versionNote = "deps.dev does not list the package yet";
      else out.publishedAt = null;
    }
  }
  const name = out.name ?? pkg.name;
  const followUps: Promise<void>[] = [malware(ctx, pkg, out, name)];
  const version = out.version;
  // An exact version deps.dev does not list may not exist at all: PyPI says which.
  const unlisted = exact !== undefined && out.exists === true && out.publishedAt === null;
  if (version !== undefined && out.exists && (needs.scripts || unlisted)) {
    followUps.push(
      (async () => {
        const release = take(await pypiRelease(ctx, name, version), out.errors);
        if (release && !release.found) {
          out.missingVersion = pkg.spec ?? version;
          delete out.publishedAt;
        } else if (release && needs.scripts) out.noWheel = !release.wheel;
      })(),
    );
  }
  await Promise.all(followUps);
  return out;
}

/** A cargo requirement as a semver range: a bare version means ^, commas separate parts. */
function cargoRange(spec: string): string | undefined {
  const parts = spec.split(",").map((part) => {
    const value = part.trim();
    return /^\d/.test(value) ? `^${value}` : value;
  });
  return semver.validRange(parts.join(" ")) ?? undefined;
}

async function inspectCargo(ctx: LookupContext, pkg: PackageRequest): Promise<Inspection> {
  const out: Inspection = { errors: [] };
  const facts = take(await depsDevPackage(ctx, "cargo", pkg.name), out.errors);
  if (facts?.found) {
    out.exists = true;
    if (facts.name && facts.name !== pkg.name) out.name = facts.name;
    if (pkg.spec === undefined) out.version = facts.default;
    else {
      const range = cargoRange(pkg.spec);
      out.version =
        range === undefined
          ? undefined
          : (semver.maxSatisfying(Object.keys(facts.versions), range) ?? undefined);
      if (out.version === undefined) out.missingVersion = pkg.spec;
    }
    if (out.version !== undefined) out.publishedAt = facts.versions[out.version] ?? null;
  } else if (facts) {
    const found = take(await registryHas(ctx, "cargo", pkg.name), out.errors);
    if (found !== undefined) out.exists = found;
    if (found) out.versionNote = "deps.dev does not list the crate yet";
  }
  await malware(ctx, pkg, out, out.name ?? pkg.name);
  return out;
}

/** Hosts whose module paths have at least three elements: host/owner/repo. */
const THREE_ELEMENT_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org", "golang.org"]);
const MAX_GO_CANDIDATES = 5;

/** The module paths a package path can belong to, longest first. */
export function moduleCandidates(path: string): string[] {
  const parts = path.split("/");
  const min = THREE_ELEMENT_HOSTS.has(parts[0] ?? "") ? 3 : 2;
  const candidates: string[] = [];
  for (let n = parts.length; n >= Math.min(min, parts.length); n -= 1) {
    candidates.push(parts.slice(0, n).join("/"));
  }
  return candidates.slice(0, MAX_GO_CANDIDATES);
}

const GO_DEFAULT_QUERIES = new Set(["latest", "upgrade", "patch"]);

/** The version a Go query picks from a module's versions. */
function resolveGo(
  facts: PackageFacts,
  query: string | undefined,
): { version?: string; note?: string; missing?: boolean } {
  const versions = Object.keys(facts.versions);
  if (query === undefined || GO_DEFAULT_QUERIES.has(query)) {
    const newest = semver.maxSatisfying(
      versions.filter((v) => semver.valid(v) && !semver.prerelease(v)),
      "*",
    );
    const version = facts.default ?? newest ?? undefined;
    return version === undefined ? { note: "the module has no tagged version" } : { version };
  }
  if (/^v\d+\.\d+\.\d+/.test(query)) {
    return versions.includes(query) ? { version: query } : { missing: true };
  }
  const prefix = /^v(\d+)(?:\.(\d+))?$/.exec(query);
  if (prefix) {
    const range = prefix[2] === undefined ? `${prefix[1]}.x` : `${prefix[1]}.${prefix[2]}.x`;
    const version = semver.maxSatisfying(versions, range);
    return version ? { version } : { missing: true };
  }
  return { note: `@${query} is a branch, commit or comparison, so its age is not checked` };
}

async function inspectGo(ctx: LookupContext, pkg: PackageRequest): Promise<Inspection> {
  const out: Inspection = { errors: [] };
  const candidates = moduleCandidates(pkg.name);
  const listed = await Promise.all(candidates.map((c) => depsDevPackage(ctx, "go", c)));
  const index = listed.findIndex((result) => result.ok && result.value.found);
  let module: string | undefined;
  const found = index === -1 ? undefined : listed[index];
  if (found?.ok) {
    module = candidates[index];
    out.exists = true;
    const resolved = resolveGo(found.value, pkg.spec);
    if (resolved.note) out.versionNote = resolved.note;
    if (resolved.version !== undefined) {
      out.version = resolved.version;
      out.publishedAt = found.value.versions[resolved.version] ?? null;
    } else if (resolved.missing && pkg.spec !== undefined && module !== undefined) {
      // A version deps.dev does not list yet may already be on the proxy.
      const exact = /^v\d+\.\d+\.\d+/.test(pkg.spec) ? pkg.spec : undefined;
      const info = take(await goProxyInfo(ctx, module, exact), out.errors);
      if (info?.found && exact !== undefined) {
        out.version = info.version ?? exact;
        out.publishedAt = info.time ?? null;
      } else if (info) out.missingVersion = pkg.spec;
    }
  } else {
    const failed = listed.filter((result) => !result.ok);
    if (failed.length > 0) {
      for (const result of failed.slice(0, 1)) take(result, out.errors);
    } else {
      // deps.dev lists none of them: ask the module proxy, which fetches new modules on demand.
      const exact =
        pkg.spec !== undefined && /^v\d+\.\d+\.\d+/.test(pkg.spec) ? pkg.spec : undefined;
      const infos = await Promise.all(candidates.map((c) => goProxyInfo(ctx, c, exact)));
      const hit = infos.findIndex((result) => result.ok && result.value.found);
      const info = hit === -1 ? undefined : infos[hit];
      if (info?.ok) {
        module = candidates[hit];
        out.exists = true;
        if (info.value.version) out.version = info.value.version;
        if (info.value.time) out.publishedAt = info.value.time;
        if (pkg.spec !== undefined && exact === undefined && !GO_DEFAULT_QUERIES.has(pkg.spec)) {
          out.versionNote = `@${pkg.spec} was not resolved, so the latest version was checked`;
        }
      } else if (infos.every((result) => result.ok)) {
        out.exists = false;
      } else {
        take(
          infos.find((result) => !result.ok),
          out.errors,
        );
      }
    }
  }
  if (module !== undefined && module !== pkg.name) out.name = module;
  await malware(ctx, pkg, out, module ?? pkg.name);
  return out;
}

/** Asks the registries about one package. Never throws: failures land in `errors`. */
export function inspect(
  ctx: LookupContext,
  pkg: PackageRequest,
  needs: Needs,
): Promise<Inspection> {
  switch (pkg.ecosystem) {
    case "npm":
      return inspectNpm(ctx, pkg, needs);
    case "pypi":
      return inspectPypi(ctx, pkg, needs);
    case "cargo":
      return inspectCargo(ctx, pkg);
    case "go":
      return inspectGo(ctx, pkg);
  }
}

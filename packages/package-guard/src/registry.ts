import type { Cache } from "./cache.js";
import type { Ecosystem } from "./parse.js";

/**
 * The HTTP the guard needs, a subset of the global fetch so it can be passed as is. Tests pass
 * one that replays recorded responses.
 */
export type Fetch = (
  url: string,
  init: {
    method: "GET" | "HEAD" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface LookupContext {
  fetch: Fetch;
  /** Aborted when the time budget runs out. */
  signal: AbortSignal;
  budgetMs: number;
  cache: Cache;
  /** Lookups in flight in this check, so one package asked for twice is fetched once. */
  inflight: Map<string, Promise<unknown>>;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A name that is missing now may be published any minute, by its author or a squatter. */
const NOT_FOUND_TTL = 10 * MINUTE;
/** The default version and the version list change with every release. */
const PACKAGE_TTL = HOUR;
/** A published version never changes. */
const VERSION_TTL = 7 * DAY;
/** New malware advisories land all the time. */
const ADVISORY_TTL = HOUR;

export const USER_AGENT = "selfhost-package-guard (+https://selfhost.ai)";

export const DEPS_DEV = "https://api.deps.dev/v3";
export const NPM_REGISTRY = "https://registry.npmjs.org";
export const PYPI = "https://pypi.org";
export const CRATES_INDEX = "https://index.crates.io";
export const GO_PROXY = "https://proxy.golang.org";
export const OSV = "https://api.osv.dev/v1";

const SYSTEMS: Record<Ecosystem, string> = { npm: "npm", pypi: "pypi", cargo: "cargo", go: "go" };
const OSV_ECOSYSTEMS: Record<Ecosystem, string> = {
  npm: "npm",
  pypi: "PyPI",
  cargo: "crates.io",
  go: "Go",
};

interface Response {
  status: number;
  body: string;
}

async function request(
  ctx: LookupContext,
  service: string,
  url: string,
  init: { method?: "GET" | "HEAD" | "POST"; body?: string } = {},
): Promise<Result<Response>> {
  const method = init.method ?? "GET";
  const late = `${service} did not answer within ${ctx.budgetMs} ms`;
  // Once the budget is spent, later lookups fail at once instead of starting.
  if (ctx.signal.aborted) return { ok: false, error: late };
  try {
    const response = await ctx.fetch(url, {
      method,
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: ctx.signal,
    });
    const body = method === "HEAD" ? "" : await response.text();
    return { ok: true, value: { status: response.status, body } };
  } catch (error) {
    if (ctx.signal.aborted) return { ok: false, error: late };
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `${service} could not be reached (${reason})` };
  }
}

const unexpected = (service: string, status: number): Result<never> => ({
  ok: false,
  error: `${service} answered HTTP ${status}`,
});

function json<T>(service: string, body: string): Result<T> {
  try {
    return { ok: true, value: JSON.parse(body) as T };
  } catch {
    return { ok: false, error: `${service} answered with something that is not JSON` };
  }
}

/** Runs a lookup once per check and caches what it finds for `ttl(value)`. */
async function cached<T>(
  ctx: LookupContext,
  key: string,
  ttl: (value: T) => number,
  load: () => Promise<Result<T>>,
): Promise<Result<T>> {
  const hit = await ctx.cache.get<T>(key);
  if (hit !== undefined) return { ok: true, value: hit };
  const running = ctx.inflight.get(key) as Promise<Result<T>> | undefined;
  if (running) return running;
  const promise = load().then(async (result) => {
    if (result.ok) await ctx.cache.set(key, result.value, ttl(result.value));
    return result;
  });
  ctx.inflight.set(key, promise);
  return promise;
}

/** A package as deps.dev lists it. */
export interface PackageFacts {
  found: boolean;
  /** The name deps.dev files it under: PyPI and crates.io names are normalized. */
  name?: string;
  /** The version a plain install gets. */
  default?: string;
  /** Every version, with its publish time when deps.dev has one. */
  versions: Record<string, string | null>;
}

interface DepsDevPackage {
  packageKey?: { name?: string };
  versions?: { versionKey?: { version?: string }; publishedAt?: string; isDefault?: boolean }[];
}

/** deps.dev v3 GetPackage: whether the package exists, its versions and their publish times. */
export function depsDevPackage(
  ctx: LookupContext,
  ecosystem: Ecosystem,
  name: string,
): Promise<Result<PackageFacts>> {
  const service = "deps.dev";
  const url = `${DEPS_DEV}/systems/${SYSTEMS[ecosystem]}/packages/${encodeURIComponent(name)}`;
  return cached<PackageFacts>(
    ctx,
    `deps.dev:${ecosystem}:${name}`,
    (facts) => (facts.found ? PACKAGE_TTL : NOT_FOUND_TTL),
    async () => {
      const response = await request(ctx, service, url);
      if (!response.ok) return response;
      if (response.value.status === 404) return { ok: true, value: { found: false, versions: {} } };
      if (response.value.status !== 200) return unexpected(service, response.value.status);
      const parsed = json<DepsDevPackage>(service, response.value.body);
      if (!parsed.ok) return parsed;
      const facts: PackageFacts = { found: true, versions: {} };
      if (parsed.value.packageKey?.name) facts.name = parsed.value.packageKey.name;
      for (const entry of parsed.value.versions ?? []) {
        const version = entry.versionKey?.version;
        if (!version) continue;
        facts.versions[version] = entry.publishedAt ?? null;
        if (entry.isDefault) facts.default = version;
      }
      return { ok: true, value: facts };
    },
  );
}

/** One npm version manifest, reduced to what the guard checks. */
export interface NpmVersion {
  found: "yes" | "no_package" | "no_version";
  version?: string;
  /** Lifecycle scripts npm runs at install: preinstall, install, postinstall, or node-gyp. */
  scripts: string[];
}

const encodeNpmName = (name: string) => name.replace("/", "%2F");

/**
 * The npm registry's manifest for one version or dist-tag. It is small, unlike the full or
 * abbreviated package document (megabytes for popular packages), and it resolves tags.
 */
export function npmVersion(
  ctx: LookupContext,
  name: string,
  versionOrTag: string,
  exact: boolean,
): Promise<Result<NpmVersion>> {
  const service = "the npm registry";
  const url = `${NPM_REGISTRY}/${encodeNpmName(name)}/${encodeURIComponent(versionOrTag)}`;
  return cached<NpmVersion>(
    ctx,
    `npm:${name}@${versionOrTag}`,
    (value) => (value.found !== "yes" ? NOT_FOUND_TTL : exact ? VERSION_TTL : PACKAGE_TTL),
    async () => {
      const response = await request(ctx, service, url);
      if (!response.ok) return response;
      const { status, body } = response.value;
      if (status === 404) {
        const found: NpmVersion["found"] = /version not found/i.test(body)
          ? "no_version"
          : "no_package";
        return { ok: true, value: { found, scripts: [] } };
      }
      if (status !== 200) return unexpected(service, status);
      const parsed = json<{
        version?: string;
        scripts?: Record<string, unknown>;
        gypfile?: boolean;
      }>(service, body);
      if (!parsed.ok) return parsed;
      const scripts = ["preinstall", "install", "postinstall"].filter(
        (script) => typeof parsed.value.scripts?.[script] === "string",
      );
      if (parsed.value.gypfile === true && !scripts.includes("install")) scripts.push("node-gyp");
      return {
        ok: true,
        value: {
          found: "yes",
          ...(parsed.value.version ? { version: parsed.value.version } : {}),
          scripts,
        },
      };
    },
  );
}

/** One PyPI release: whether it exists and whether it ships a wheel. */
export interface PypiRelease {
  found: boolean;
  wheel: boolean;
}

/** PyPI's JSON API for one release. With no wheel, pip builds the sdist, running its code. */
export function pypiRelease(
  ctx: LookupContext,
  name: string,
  version: string,
): Promise<Result<PypiRelease>> {
  const service = "PyPI";
  const url = `${PYPI}/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`;
  return cached<PypiRelease>(
    ctx,
    `pypi:${name}@${version}`,
    (value) => (value.found ? VERSION_TTL : NOT_FOUND_TTL),
    async () => {
      const response = await request(ctx, service, url);
      if (!response.ok) return response;
      if (response.value.status === 404) return { ok: true, value: { found: false, wheel: false } };
      if (response.value.status !== 200) return unexpected(service, response.value.status);
      const parsed = json<{ urls?: { packagetype?: string }[] }>(service, response.value.body);
      if (!parsed.ok) return parsed;
      const wheel = (parsed.value.urls ?? []).some((file) => file.packagetype === "bdist_wheel");
      return { ok: true, value: { found: true, wheel } };
    },
  );
}

/** The crates.io sparse index path of a crate: se/rd/serde, 3/s/syn, 2/cc. */
function indexPath(name: string): string {
  const lower = name.toLowerCase();
  if (lower.length <= 2) return `${lower.length}/${lower}`;
  if (lower.length === 3) return `3/${lower[0]}/${lower}`;
  return `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`;
}

/**
 * Whether the registry itself has the package, for a name deps.dev does not list: it may be
 * too new for deps.dev. A HEAD request, so nothing large comes back.
 */
export function registryHas(
  ctx: LookupContext,
  ecosystem: "pypi" | "cargo",
  name: string,
): Promise<Result<boolean>> {
  const service = ecosystem === "pypi" ? "PyPI" : "the crates.io index";
  const url =
    ecosystem === "pypi"
      ? `${PYPI}/pypi/${encodeURIComponent(name)}/json`
      : `${CRATES_INDEX}/${indexPath(name)}`;
  return cached<boolean>(
    ctx,
    `exists:${ecosystem}:${name}`,
    (found) => (found ? PACKAGE_TTL : NOT_FOUND_TTL),
    async () => {
      const response = await request(ctx, service, url, { method: "HEAD" });
      if (!response.ok) return response;
      if (response.value.status === 404) return { ok: true, value: false };
      if (response.value.status !== 200) return unexpected(service, response.value.status);
      return { ok: true, value: true };
    },
  );
}

/** A Go module version as the module proxy reports it. */
export interface GoInfo {
  found: boolean;
  version?: string;
  time?: string;
}

/** `/@v/<version>.info` escapes upper case letters as `!` and the lower case letter. */
const escapeGoPath = (path: string) => path.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);

/** proxy.golang.org: a module's latest version or one version, with its time. */
export function goProxyInfo(
  ctx: LookupContext,
  module: string,
  version?: string,
): Promise<Result<GoInfo>> {
  const service = "proxy.golang.org";
  const at = version === undefined ? "@latest" : `@v/${escapeGoPath(version)}.info`;
  const url = `${GO_PROXY}/${escapeGoPath(module)}/${at}`;
  return cached<GoInfo>(
    ctx,
    `go:${module}${version === undefined ? "@latest" : `@${version}`}`,
    (info) => (!info.found ? NOT_FOUND_TTL : version === undefined ? PACKAGE_TTL : VERSION_TTL),
    async () => {
      const response = await request(ctx, service, url);
      if (!response.ok) return response;
      const { status, body } = response.value;
      if (status === 404 || status === 410) return { ok: true, value: { found: false } };
      if (status !== 200) return unexpected(service, status);
      const parsed = json<{ Version?: string; Time?: string }>(service, body);
      if (!parsed.ok) return parsed;
      return {
        ok: true,
        value: {
          found: true,
          ...(parsed.value.Version ? { version: parsed.value.Version } : {}),
          ...(parsed.value.Time ? { time: parsed.value.Time } : {}),
        },
      };
    },
  );
}

/**
 * Malicious package advisories (MAL- ids, from the OpenSSF malicious packages feed OSV-Scanner
 * uses) for a package, or one version of it. querybatch returns ids only, which is all the
 * guard needs.
 */
export function osvMalicious(
  ctx: LookupContext,
  ecosystem: Ecosystem,
  name: string,
  version?: string,
): Promise<Result<string[]>> {
  const service = "osv.dev";
  const query = {
    package: { name, ecosystem: OSV_ECOSYSTEMS[ecosystem] },
    ...(version !== undefined ? { version } : {}),
  };
  return cached<string[]>(
    ctx,
    `osv:${ecosystem}:${name}@${version ?? "*"}`,
    () => ADVISORY_TTL,
    async () => {
      const response = await request(ctx, service, `${OSV}/querybatch`, {
        method: "POST",
        body: JSON.stringify({ queries: [query] }),
      });
      if (!response.ok) return response;
      if (response.value.status !== 200) return unexpected(service, response.value.status);
      const parsed = json<{ results?: { vulns?: { id?: string }[] }[] }>(
        service,
        response.value.body,
      );
      if (!parsed.ok) return parsed;
      const ids = (parsed.value.results?.[0]?.vulns ?? [])
        .map((vuln) => vuln.id ?? "")
        .filter((id) => id.startsWith("MAL-"));
      return { ok: true, value: ids.sort() };
    },
  );
}

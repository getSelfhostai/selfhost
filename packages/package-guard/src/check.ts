import { globMatches } from "@selfhost/policy";
import { PACKAGE_RULE_IDS, type ResolvedSelfhostConfig, type RuleAction } from "@selfhost/schema";
import { type Cache, createCache } from "./cache.js";
import { type Inspection, inspect, type Needs } from "./inspect.js";
import {
  type Ecosystem,
  type Install,
  type PackageRequest,
  parseInstalls,
  type SkippedArg,
} from "./parse.js";
import type { Fetch, LookupContext } from "./registry.js";
import { hostOf, normalizePypi } from "./specs.js";

/** How long a check may wait on registries before it lets the install through unchecked. */
export const DEFAULT_BUDGET_MS = 3000;

export interface GuardDeps {
  /** The global fetch, or a stand-in. */
  fetch: Fetch;
  now: () => Date;
  /** Keeps lookups on disk between processes. Without it they last for one guard only. */
  cacheDir?: string;
  /** Default: DEFAULT_BUDGET_MS. */
  budgetMs?: number;
  /** The environment the command runs in, for registry variables like npm_config_registry. */
  env?: Record<string, string | undefined>;
}

export type PackagesPolicy = ResolvedSelfhostConfig["packages"];

/** One rule a package or install broke, in words about that package. */
export interface Finding {
  rule_id: string;
  verdict: RuleAction;
  message: string;
}

/**
 * ok: checked, nothing found. blocked or flagged: a block or ask finding. unchecked: a lookup
 * failed. allowed: on the allow list, not checked. skipped: not looked up (a private module, an
 * install through another registry, or an install that is already blocked).
 */
export type PackageStatus = "ok" | "blocked" | "flagged" | "unchecked" | "allowed" | "skipped";

export interface PackageResult {
  ecosystem: Ecosystem;
  /** The name the registry files it under. */
  name: string;
  spec?: string;
  arg: string;
  version?: string;
  published_at?: string;
  status: PackageStatus;
  findings: Finding[];
  /** Lookups that failed, as "service: reason". */
  unchecked: string[];
  /** Why it was not looked up, or what was not checked. */
  note?: string;
}

export interface InstallResult {
  ecosystem: Ecosystem;
  manager: string;
  command: string;
  /** The registries, indexes or proxies it uses; the default one when it names none. */
  registries: string[];
  /** Blocked registries. */
  findings: Finding[];
  packages: PackageResult[];
  skipped: SkippedArg[];
}

export interface PackageReport {
  installs: InstallResult[];
}

const DEFAULT_REGISTRY: Record<Ecosystem, string> = {
  npm: "https://registry.npmjs.org/",
  pypi: "https://pypi.org/simple/",
  cargo: "crates.io",
  go: "https://proxy.golang.org",
};

/** Hosts and names that are the public registry under another spelling. */
const PUBLIC: Record<Ecosystem, string[]> = {
  npm: ["registry.npmjs.org", "registry.npmjs.com", "registry.yarnpkg.com"],
  pypi: ["pypi.org", "pypi.python.org", "files.pythonhosted.org"],
  cargo: ["crates.io", "crates-io", "index.crates.io"],
  go: ["proxy.golang.org", "direct", "off"],
};

export const REGISTRY_NAMES: Record<Ecosystem, string> = {
  npm: "npm",
  pypi: "PyPI",
  cargo: "crates.io",
  go: "Go",
};

const isPublic = (ecosystem: Ecosystem, registry: string) =>
  PUBLIC[ecosystem].includes(hostOf(registry) ?? registry.toLowerCase().replace(/\/+$/, ""));

/** The blocked_registries glob a registry or host matches. */
function blockedBy(policy: PackagesPolicy, value: string): string | undefined {
  const url = value.toLowerCase().replace(/\/+$/, "");
  const host = hostOf(value);
  return policy.blocked_registries.find((glob) => {
    const pattern = glob.toLowerCase().replace(/\/+$/, "");
    return globMatches(pattern, url) || (host !== undefined && globMatches(pattern, host));
  });
}

const PREFIXES: Record<string, Ecosystem> = {
  npm: "npm",
  pypi: "pypi",
  cargo: "cargo",
  go: "go",
};

/** The allow or deny entry a package matches. `pypi:` and the like limit an entry to one registry. */
export function listEntry(
  list: readonly string[],
  ecosystem: Ecosystem,
  name: string,
): string | undefined {
  return list.find((entry) => {
    const colon = entry.indexOf(":");
    const prefix = colon === -1 ? undefined : PREFIXES[entry.slice(0, colon)];
    if (prefix !== undefined && prefix !== ecosystem) return false;
    const glob = prefix === undefined ? entry : entry.slice(colon + 1);
    if (ecosystem === "pypi") return globMatches(normalizePypi(glob), name);
    if (ecosystem === "cargo") {
      return globMatches(
        glob.toLowerCase().replace(/_/g, "-"),
        name.toLowerCase().replace(/_/g, "-"),
      );
    }
    return globMatches(glob, name);
  });
}

/** Go's GOPRIVATE matching: a glob against as many leading path elements as it has. */
function goPrivate(patterns: string[], path: string): string | undefined {
  return patterns.find((pattern) => {
    const count = pattern.split("/").length;
    return globMatches(pattern, path.split("/").slice(0, count).join("/"));
  });
}

const NOT_FOUND: Record<Ecosystem, (name: string) => string> = {
  npm: (name) => `npm has no package named ${name}.`,
  pypi: (name) => `PyPI has no package named ${name}.`,
  cargo: (name) => `crates.io has no crate named ${name}.`,
  go: (name) => `No Go module provides ${name}.`,
};

const DAY_MS = 86_400_000;

function age(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "less than an hour ago";
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.floor(ms / DAY_MS)} days ago`;
}

function label(pkg: PackageRequest, ins: Inspection | undefined): string {
  const name = ins?.name ?? pkg.name;
  const version = ins?.version ? ` ${ins.version}` : "";
  return `${name}${version} (${REGISTRY_NAMES[pkg.ecosystem]})`;
}

/** The findings for one inspected package. */
function findingsOf(
  pkg: PackageRequest,
  ins: Inspection,
  policy: PackagesPolicy,
  now: Date,
): { findings: Finding[]; note?: string } {
  const findings: Finding[] = [];
  const what = label(pkg, ins);
  const registry = REGISTRY_NAMES[pkg.ecosystem];
  if (ins.malicious) {
    findings.push({
      rule_id: PACKAGE_RULE_IDS.malicious,
      verdict: "block",
      message: `${what} is known malware (${ins.malicious.join(", ")} on osv.dev).`,
    });
  } else if (ins.exists === false) {
    findings.push({
      rule_id: PACKAGE_RULE_IDS.not_found,
      verdict: "block",
      message: `${NOT_FOUND[pkg.ecosystem](pkg.name)} Check the name: attackers register the names agents invent.`,
    });
  } else if (ins.missingVersion !== undefined) {
    findings.push({
      rule_id: PACKAGE_RULE_IDS.not_found,
      verdict: "block",
      message: `${registry} has no version ${ins.missingVersion} of ${ins.name ?? pkg.name}.`,
    });
  }
  const minAge = policy.min_age_days ?? 0;
  if (ins.exists && minAge > 0 && ins.missingVersion === undefined && !ins.malicious) {
    if (ins.publishedAt === null) {
      findings.push({
        rule_id: PACKAGE_RULE_IDS.too_new,
        verdict: "ask",
        message: `${what} is so new that deps.dev does not list it yet; [packages] min_age_days is ${minAge}.`,
      });
    } else if (ins.publishedAt !== undefined) {
      const elapsed = now.getTime() - Date.parse(ins.publishedAt);
      if (elapsed < minAge * DAY_MS) {
        findings.push({
          rule_id: PACKAGE_RULE_IDS.too_new,
          verdict: "ask",
          message: `${what} was published ${age(elapsed)}; [packages] min_age_days is ${minAge}.`,
        });
      }
    }
  }
  if (policy.install_scripts !== "allow") {
    const verdict: RuleAction = policy.install_scripts === "block" ? "block" : "ask";
    if (ins.scripts && ins.scripts.length > 0) {
      findings.push({
        rule_id: PACKAGE_RULE_IDS.install_scripts,
        verdict,
        message: `${what} runs code at install (${ins.scripts.join(", ")}).`,
      });
    } else if (ins.noWheel) {
      findings.push({
        rule_id: PACKAGE_RULE_IDS.install_scripts,
        verdict,
        message: `${what} has no wheel, so installing it runs its build code.`,
      });
    }
  }
  const note =
    ins.versionNote ??
    (minAge > 0 && ins.exists && ins.version === undefined && !ins.missingVersion
      ? "the version could not be resolved, so its age is not checked"
      : undefined);
  return { findings, ...(note ? { note } : {}) };
}

function statusOf(findings: Finding[], unchecked: string[]): PackageStatus {
  if (findings.some((f) => f.verdict === "block")) return "blocked";
  if (findings.length > 0) return "flagged";
  return unchecked.length > 0 ? "unchecked" : "ok";
}

interface Run {
  ctx: LookupContext;
  policy: PackagesPolicy;
  now: Date;
}

async function checkInstall(install: Install, run: Run): Promise<InstallResult> {
  const { policy } = run;
  const registries =
    install.registries.length > 0 ? install.registries : [DEFAULT_REGISTRY[install.ecosystem]];
  const findings: Finding[] = [];
  for (const registry of registries) {
    const glob = blockedBy(policy, registry);
    if (glob) {
      findings.push({
        rule_id: PACKAGE_RULE_IDS.blocked_registry,
        verdict: "block",
        message: `${install.manager} uses ${registry}, which [packages] blocked_registries blocks (${glob}).`,
      });
    }
  }
  for (const skipped of install.skipped) {
    const glob = skipped.host === undefined ? undefined : blockedBy(policy, skipped.host);
    if (glob) {
      findings.push({
        rule_id: PACKAGE_RULE_IDS.blocked_registry,
        verdict: "block",
        message: `${skipped.arg} comes from ${skipped.host}, which [packages] blocked_registries blocks (${glob}).`,
      });
    }
  }
  const custom = install.registries.filter((r) => !isPublic(install.ecosystem, r));
  const needs: Needs = {
    age: (policy.min_age_days ?? 0) > 0,
    scripts: policy.install_scripts !== "allow",
  };
  const packages = await Promise.all(
    install.packages.map(async (pkg): Promise<PackageResult> => {
      const base = {
        ecosystem: pkg.ecosystem,
        name: pkg.name,
        ...(pkg.spec !== undefined ? { spec: pkg.spec } : {}),
        arg: pkg.arg,
      };
      const denied = listEntry(policy.deny, pkg.ecosystem, pkg.name);
      if (denied !== undefined) {
        const finding: Finding = {
          rule_id: PACKAGE_RULE_IDS.deny,
          verdict: "block",
          message: `${label(pkg, undefined)} is in [packages] deny (${denied}).`,
        };
        return { ...base, status: "blocked", findings: [finding], unchecked: [] };
      }
      const allowed = listEntry(policy.allow, pkg.ecosystem, pkg.name);
      const skip = (status: PackageStatus, note: string): PackageResult => ({
        ...base,
        status,
        findings: [],
        unchecked: [],
        note,
      });
      if (allowed !== undefined) return skip("allowed", `on [packages] allow (${allowed})`);
      if (findings.length > 0) return skip("skipped", "not looked up: the install is blocked");
      if (custom.length > 0) {
        return skip(
          "skipped",
          `installs through ${custom.join(", ")}, which the guard does not look up`,
        );
      }
      const privateGo =
        pkg.ecosystem === "go" ? goPrivate(install.privatePatterns, pkg.name) : undefined;
      if (privateGo !== undefined) {
        return skip("skipped", `matches GOPRIVATE or GONOPROXY (${privateGo})`);
      }
      const ins = await inspect(run.ctx, pkg, needs);
      const found = findingsOf(pkg, ins, policy, run.now);
      return {
        ...base,
        name: ins.name ?? pkg.name,
        ...(ins.version !== undefined ? { version: ins.version } : {}),
        ...(typeof ins.publishedAt === "string" ? { published_at: ins.publishedAt } : {}),
        status: statusOf(found.findings, ins.errors),
        findings: found.findings,
        unchecked: ins.errors,
        ...(found.note ? { note: found.note } : {}),
      };
    }),
  );
  return {
    ecosystem: install.ecosystem,
    manager: install.manager,
    command: install.command,
    registries,
    findings,
    packages,
    skipped: install.skipped,
  };
}

/** Variables the command can see, without the unset ones. */
function definedEnv(env: GuardDeps["env"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) if (value !== undefined) out[key] = value;
  return out;
}

/**
 * Checks every package install in a shell command against [packages] and the registries.
 * Lookups share one time budget; when it runs out, or a registry fails, the packages it could
 * not check are reported as unchecked instead of blocked (fail open). With mode off, or a
 * command that installs nothing, it returns at once without any network call.
 */
export async function checkCommand(
  command: string,
  config: ResolvedSelfhostConfig,
  deps: GuardDeps & { cache?: Cache },
): Promise<PackageReport> {
  const policy = config.packages;
  if (policy.mode === "off") return { installs: [] };
  const installs = parseInstalls(command, definedEnv(deps.env));
  if (installs.length === 0) return { installs: [] };
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const ctx: LookupContext = {
    fetch: deps.fetch,
    signal: controller.signal,
    budgetMs,
    cache: deps.cache ?? createCache(deps.now, deps.cacheDir),
    inflight: new Map(),
  };
  try {
    const now = deps.now();
    return {
      installs: await Promise.all(
        installs.map((install) => checkInstall(install, { ctx, policy, now })),
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}

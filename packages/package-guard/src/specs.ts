import type { Ecosystem, SkippedArg } from "./parse.js";

/** A registry name and the version, tag or range asked for, or why the argument is skipped. */
export type Spec = { name: string; spec?: string } | { skip: string; host?: string };

/** The host of a URL, `git@host:path` or `host/path` spec, lowercased. */
export function hostOf(value: string): string | undefined {
  const scp = /^[\w.-]+@([\w.-]+):/.exec(value);
  if (scp) return scp[1]?.toLowerCase();
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?#]+)/i.exec(value);
  return url?.[1]?.toLowerCase();
}

const NPM_GIT = /^(git\+|git:|git@|github:|gitlab:|bitbucket:|gist:)/i;
const NPM_LOCAL = /^(file:|link:|portal:|patch:|workspace:|catalog:|exec:)/i;
const NPM_NAME = /^(?:@[a-z0-9~][\w.~-]*\/)?[a-z0-9~_.-][\w.~-]*$/i;
const VARIABLE =
  "a shell variable or command substitution, so the package is not known before the command runs";

/** Why an argument is not a registry package, from its form alone. */
function sourceSkip(arg: string): Spec | undefined {
  if (arg.includes("$") || arg.includes("`")) return { skip: VARIABLE };
  return undefined;
}

/**
 * An npm package argument as npm reads it: `name`, `name@version|tag|range`, `@scope/name@x`,
 * the alias `x@npm:name@range`, and git, GitHub, URL, tarball, folder and workspace specs, which
 * are skipped.
 */
export function npmSpec(arg: string): Spec {
  const early = sourceSkip(arg);
  if (early) return early;
  const host = hostOf(arg);
  if (NPM_GIT.test(arg)) {
    return { skip: "installs from a git repository, not the registry", host: host ?? "github.com" };
  }
  if (/^https?:\/\//i.test(arg))
    return { skip: "installs a tarball from a URL", ...(host ? { host } : {}) };
  if (/^jsr:/i.test(arg)) return { skip: "installs from JSR, which the guard does not check" };
  if (NPM_LOCAL.test(arg) || /^[./~]/.test(arg) || /\.(tgz|tar\.gz|tar)$/i.test(arg)) {
    return { skip: "installs a local folder, tarball or workspace package" };
  }
  const at = arg.indexOf("@", arg.startsWith("@") ? 1 : 0);
  const name = at === -1 ? arg : arg.slice(0, at);
  const spec = at === -1 ? undefined : arg.slice(at + 1);
  if (!name.startsWith("@") && name.includes("/")) {
    return { skip: "installs from GitHub (user/repo), not the registry", host: "github.com" };
  }
  if (spec?.toLowerCase().startsWith("npm:")) return npmSpec(spec.slice(4));
  if (
    spec !== undefined &&
    (NPM_GIT.test(spec) || /^https?:/i.test(spec) || NPM_LOCAL.test(spec))
  ) {
    return npmSpec(spec);
  }
  if (!NPM_NAME.test(name)) return { skip: "is not a valid npm package name" };
  return spec === undefined || spec === "" ? { name } : { name, spec };
}

/** PEP 503: lowercase, with runs of `-`, `_` and `.` as one `-`. */
export function normalizePypi(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

const PEP508 =
  /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*\(?\s*((?:[<>=!~]=?|===)[^)]*)?\)?\s*$/;
const AT_SPEC = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?:\[[^\]]*\])?@([^\s/:]+)$/;

/**
 * A Python requirement: PEP 508 (`name[extra]>=1,<2; marker`), or with `at` the `name@version`
 * form poetry and uvx accept. URLs, VCS and direct references, wheels, archives and folders are
 * skipped. An exact version comes back as `==1.2.3`.
 */
export function pypiSpec(arg: string, opts: { at?: boolean } = {}): Spec {
  const early = sourceSkip(arg);
  if (early) return early;
  const value = arg.trim();
  const host = hostOf(value);
  if (/^(git|hg|svn|bzr)\+/i.test(value)) {
    return {
      skip: "installs from a version control repository, not the index",
      ...(host ? { host } : {}),
    };
  }
  if (/^(https?|file):/i.test(value))
    return { skip: "installs from a URL", ...(host ? { host } : {}) };
  const direct = /^[A-Za-z0-9][A-Za-z0-9._-]*\s*(?:\[[^\]]*\])?\s*@\s*(\S+)/.exec(value);
  if (direct && (direct[1]?.includes("://") || direct[1]?.startsWith("/"))) {
    const target = direct[1] ?? "";
    return {
      skip: "is a direct reference to a URL or file",
      ...(hostOf(target) ? { host: hostOf(target) } : {}),
    };
  }
  if (/^[./~]/.test(value) || /\.(whl|tar\.gz|tgz|zip|tar\.bz2|egg)$/i.test(value)) {
    return { skip: "installs a local file or folder" };
  }
  const requirement = value.split(";")[0]?.trim() ?? "";
  if (opts.at) {
    const at = AT_SPEC.exec(requirement);
    if (at) {
      const version = at[2] ?? "";
      if (version === "latest") return { name: normalizePypi(at[1] ?? "") };
      return {
        name: normalizePypi(at[1] ?? ""),
        spec: /^\d/.test(version) ? `==${version}` : version,
      };
    }
  }
  const match = PEP508.exec(requirement);
  if (!match) return { skip: "is not a valid Python requirement" };
  const name = normalizePypi(match[1] ?? "");
  const spec = match[2]?.trim();
  return spec ? { name, spec: spec.replace(/\s+/g, "") } : { name };
}

const CRATE = /^([A-Za-z0-9][A-Za-z0-9_-]*)(?:@(.+))?$/;

/** A crate argument: `name` or `name@requirement`. */
export function cargoSpec(arg: string): Spec {
  const early = sourceSkip(arg);
  if (early) return early;
  if (/^[./~]/.test(arg)) return { skip: "installs a local path" };
  const match = CRATE.exec(arg);
  if (!match) return { skip: "is not a valid crate name" };
  const name = match[1] ?? "";
  return match[2] ? { name, spec: match[2] } : { name };
}

/**
 * A Go package argument: `path` or `path@query`. Relative paths, patterns like `./...` and
 * paths whose first element has no dot (the standard library, local modules) are skipped
 * without a note; `@none` removes a module and is skipped too.
 */
export function goSpec(arg: string): Spec | undefined {
  const early = sourceSkip(arg);
  if (early) return early;
  const at = arg.indexOf("@");
  let path = at === -1 ? arg : arg.slice(0, at);
  const query = at === -1 ? undefined : arg.slice(at + 1);
  if (path.startsWith(".") || path.startsWith("/") || path.endsWith(".go")) return undefined;
  path = path.replace(/\/\.\.\.$/, "");
  const first = path.split("/")[0] ?? "";
  if (!first.includes(".") || path.includes("...")) return undefined;
  if (query === "none") return undefined;
  return query === undefined || query === "" ? { name: path } : { name: path, spec: query };
}

/** Adds a spec to the right list. */
export function addSpec(
  ecosystem: Ecosystem,
  arg: string,
  spec: Spec | undefined,
  into: {
    packages: { ecosystem: Ecosystem; name: string; spec?: string; arg: string }[];
    skipped: SkippedArg[];
  },
): void {
  if (!spec) return;
  if ("skip" in spec) {
    into.skipped.push({ arg, reason: spec.skip, ...(spec.host ? { host: spec.host } : {}) });
  } else {
    into.packages.push({
      ecosystem,
      name: spec.name,
      ...(spec.spec ? { spec: spec.spec } : {}),
      arg,
    });
  }
}

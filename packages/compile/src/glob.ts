import picomatch from "picomatch/posix.js";

/**
 * Why a rule's `path` glob can't be written as a vendor path pattern, or undefined when it can.
 * Vendors read gitignore-style globs, so only literal text, `*`, `**`, `?` and `[...]` carry
 * over: picomatch braces, extglobs and negation have no equivalent.
 */
export function unplainGlob(glob: string): string | undefined {
  const scan = picomatch.scan(glob);
  if (scan.negated) return "the glob starts with !, which negates it";
  if (scan.isBrace) return "the glob uses {a,b} braces";
  if (scan.isExtglob) return "the glob uses an extglob such as @(a|b)";
  if (glob.includes("\\")) return "the glob uses a backslash escape";
  if (glob.startsWith("/")) return "the glob starts with /, so it never matches a repository path";
  if (glob.startsWith("#") || glob !== glob.trim()) {
    return "the glob starts with # or has spaces at an end";
  }
  if (/[()]/.test(glob)) return "the glob has parentheses, which close a vendor rule";
  return undefined;
}

export interface UrlHost {
  /** The host without a leading `*.`; "*" for every host. */
  host: string;
  /** subdomains: `*.host`, every subdomain at any depth and not the host itself. */
  match: "host" | "subdomains" | "all";
}

const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const HOST = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);

/**
 * The host a rule's `url` glob covers, when the glob is a whole site: `<scheme>://<host>/**`
 * with scheme https, http, http* or *, and host a name, `*.` plus a name, or `*`. Vendors block
 * whole domains, so a glob that names a path or a port does not reduce.
 */
export function urlHost(glob: string): UrlHost | string {
  const site = /^(https|http|http\*|\*):\/\/([^/]+)\/\*\*$/.exec(glob);
  if (!site) return "the URL glob names more than a whole site; vendors block whole domains";
  const host = site[2] as string;
  if (host === "*") return { host: "*", match: "all" };
  if (host.startsWith("*.") && HOST.test(host.slice(2))) {
    return { host: host.slice(2), match: "subdomains" };
  }
  if (HOST.test(host)) return { host, match: "host" };
  return `the host ${host} is not a domain name or *.<domain>`;
}

import type { ResolvedSelfhostConfig, RuleMode } from "./config.js";

/**
 * The egress allow list's host language, shared by the pre-tool hooks, the runtime translation
 * and the layer checks, so a host gets the same answer on a laptop, in a local sandbox and in a
 * remote runtime:
 *
 * - `api.github.com` is that host only;
 * - `*.npmjs.org` is every subdomain of npmjs.org, at any depth, and not npmjs.org itself;
 * - `10.0.0.7` is that IPv4 address, `10.0.0.0/8` every address in the range.
 *
 * Names compare without case and without a trailing dot. Ports are not part of an entry.
 */
export const EGRESS_HOST_PATTERN =
  "^(?:(?:\\*\\.)?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*|\\d{1,3}(?:\\.\\d{1,3}){3}(?:/\\d{1,2})?)$";

/**
 * `env:SELFHOST_RUN_SECRET_NAME` (no other server variable), `vault:path#key`,
 * `infisical:path#key` or `infisical:key`, `github-app:repo`.
 */
export const SECRET_SOURCE_PATTERN =
  "^(?:env:SELFHOST_RUN_SECRET_[A-Za-z0-9_]+|vault:[^#\\s]+#[^#\\s]+|infisical:(?:[^#\\s]+#)?[^#\\s/]+|github-app:repo)$";

/** The egress policy that applies to a run or a tool call. */
export interface EgressRules {
  mode: Exclude<RuleMode, "off">;
  /** Entries in the host language above. Empty allows no host. */
  allow: string[];
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipNumber(text: string): number | undefined {
  const parts = IPV4.exec(text);
  if (!parts) return undefined;
  const octets = parts.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return undefined;
  return octets.reduce((sum, octet) => sum * 256 + octet, 0);
}

interface Range {
  first: number;
  last: number;
}

/** The address range of an IPv4 address or CIDR entry, or undefined for a host name. */
export function ipRange(entry: string): Range | undefined {
  const [address = "", bits] = entry.split("/");
  const start = ipNumber(address);
  if (start === undefined) return undefined;
  const prefix = bits === undefined ? 32 : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return undefined;
  const size = 2 ** (32 - prefix);
  const first = Math.floor(start / size) * size;
  return { first, last: first + size - 1 };
}

/** Lower case, no trailing dot, no port, no brackets. */
export function normalizeHost(host: string): string {
  let out = host.trim().toLowerCase();
  if (out.startsWith("["))
    out = out.slice(1, out.indexOf("]") === -1 ? undefined : out.indexOf("]"));
  else if (/^[^:]+:\d+$/.test(out)) out = out.slice(0, out.lastIndexOf(":"));
  return out.endsWith(".") ? out.slice(0, -1) : out;
}

const isWildcard = (entry: string) => entry.startsWith("*.");

/** Whether one allow list entry lets `host` through. */
export function hostMatches(host: string, entry: string): boolean {
  const name = normalizeHost(host);
  const rule = normalizeHost(entry);
  const range = ipRange(rule);
  if (range) {
    const address = ipNumber(name);
    return address !== undefined && address >= range.first && address <= range.last;
  }
  if (isWildcard(rule)) return name.endsWith(rule.slice(1)) && name.length > rule.length - 1;
  return name === rule;
}

/** localhost and loopback addresses: never egress, so never limited by the allow list. */
export function isLoopback(host: string): boolean {
  const name = normalizeHost(host);
  if (name === "localhost" || name.endsWith(".localhost") || name === "::1") return true;
  const address = ipNumber(name);
  return address !== undefined && Math.floor(address / 2 ** 24) === 127;
}

/** Whether `host` (a name or an IPv4 address) is in the allow list. Loopback always is. */
export function hostAllowed(host: string, allow: readonly string[]): boolean {
  return isLoopback(host) || allow.some((entry) => hostMatches(host, entry));
}

/**
 * Whether every host `entry` allows is also allowed by `allow`, so a team or repo list that
 * holds it does not widen the org's.
 */
export function egressEntryCovered(entry: string, allow: readonly string[]): boolean {
  const rule = normalizeHost(entry);
  const range = ipRange(rule);
  return allow.some((other) => {
    const floor = normalizeHost(other);
    const floorRange = ipRange(floor);
    if (range || floorRange) {
      return range !== undefined && floorRange !== undefined
        ? range.first >= floorRange.first && range.last <= floorRange.last
        : false;
    }
    if (!isWildcard(rule)) return hostMatches(rule, floor);
    return isWildcard(floor) && (rule === floor || rule.endsWith(floor.slice(1)));
  });
}

/** The host of a URL, or undefined when it has none. */
export function hostOfUrl(url: string): string | undefined {
  try {
    const host = new URL(url).hostname;
    return host === "" ? undefined : normalizeHost(host);
  } catch {
    return undefined;
  }
}

const URL_IN_TEXT =
  /\b(?:https?|wss?|ftp|git|ssh|sftp):\/\/(?:[^\s/@'"`]+@)?(\[[^\]]+\]|[^\s/:'"`?#)]+)/gi;
const SCP_TARGET =
  /(?:^|[\s'"=])(?:[A-Za-z0-9._-]+@)([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9-]+)+):(?!\/\/)/g;

/**
 * Hosts a shell command reaches by URL (`curl https://host/...`, `git clone https://...`) or
 * by scp-style remote (`git@host:org/repo.git`). Commands that name a host only as a bare word
 * (`ssh host`, `nc host 80`) are not found here; the runtime's network controls still stop them.
 */
export function hostsInCommand(command: string): string[] {
  const hosts = new Set<string>();
  for (const match of command.matchAll(URL_IN_TEXT)) {
    const host = normalizeHost(match[1] ?? "");
    if (host !== "") hosts.add(host);
  }
  for (const match of command.matchAll(SCP_TARGET)) hosts.add(normalizeHost(match[1] ?? ""));
  return [...hosts];
}

/**
 * The egress rules for a team: `[egress]` with the team's own `[teams.<name>.egress]` list in
 * place of the allow list when it has one, and the team's `[teams.<name>.rules."egress.allow"]`
 * mode. Undefined when there is no `[egress]` section or the mode is off.
 */
export function egressPolicyOf(
  config: Pick<ResolvedSelfhostConfig, "egress" | "teams">,
  team?: string,
): EgressRules | undefined {
  const section = config.egress;
  if (!section) return undefined;
  const own = team === undefined ? undefined : config.teams[team];
  const mode = own?.rules["egress.allow"]?.mode ?? section.mode ?? "observe";
  if (mode === "off") return undefined;
  return { mode, allow: [...(own?.egress?.allow ?? section.allow ?? [])] };
}

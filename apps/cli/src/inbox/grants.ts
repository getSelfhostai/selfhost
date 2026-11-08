import { dirname } from "node:path";
import { clock } from "../alerts/text.js";
import {
  type ExceptionGrant,
  exceptionsDir,
  type GrantsReport,
  hasRequests,
  issueGrants,
  type LookupItem,
} from "../hooks/exceptions.js";

/** ~/.selfhost/exceptions, next to the config file. */
export const grantsDirOf = (configPath: string) => exceptionsDir(dirname(configPath));

/**
 * Writes a grant for each of this machine's exception requests a person approved, reading the
 * items through `lookup`. Nothing is read when no request waits.
 */
export async function refreshGrants(
  configPath: string,
  lookup: LookupItem,
  now: Date,
): Promise<GrantsReport | undefined> {
  const dir = grantsDirOf(configPath);
  if (!hasRequests(dir)) return undefined;
  return issueGrants(dir, lookup, now);
}

/** "Allowed once until 10:30 UTC: ..." for a grant just written. */
export function grantLine(grant: ExceptionGrant, now: Date): string {
  return `Allowed once until ${clock(grant.expires_at, now)}: the agent can make the call it asked about (exception ${grant.id}) one more time.`;
}

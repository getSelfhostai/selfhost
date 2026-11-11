import { dirname } from "node:path";
import { clock } from "../alerts/text.js";
import {
  type AnyGrant,
  exceptionsDir,
  type GrantsReport,
  hasRequests,
  hasUnreportedUses,
  issueGrants,
  type LookupItem,
  pullServerGrants,
  type ServerGrants,
} from "../hooks/exceptions.js";
import { type ExceptionTrust, exceptionTrust } from "../hooks/trust.js";
import type { TeamClient } from "../team/client.js";

/** ~/.selfhost/exceptions, next to the config file. */
export const grantsDirOf = (configPath: string) => exceptionsDir(dirname(configPath));

/**
 * Where grants come from: solo mode reads items from the local list and signs grants with the
 * local key; team mode fetches the grants the team server signed.
 */
export type GrantSource = LookupItem | ServerGrants;

/** The team server's grant routes, for pullServerGrants. */
export function serverGrants(
  client: Pick<TeamClient, "exceptionGrant" | "reportGrantUse">,
  machine?: string,
): ServerGrants {
  return {
    grant: (id) => client.exceptionGrant(id),
    used: async (id, nonce) => {
      await client.reportGrantUse(id, { nonce, ...(machine ? { machine } : {}) });
    },
  };
}

/**
 * Writes a grant for each of this machine's exception requests a person approved: in solo mode
 * signed here from the items `source` reads, in team mode fetched from the server and checked
 * against the keys this laptop pinned (`trust`, read from the managed settings and config.json
 * when not given). Nothing is read when no request waits and no use waits to be reported.
 */
export async function refreshGrants(
  configPath: string,
  source: GrantSource,
  now: Date,
  trust?: ExceptionTrust,
): Promise<GrantsReport | undefined> {
  const dir = grantsDirOf(configPath);
  if (typeof source === "function") {
    if (!hasRequests(dir)) return undefined;
    return issueGrants(dir, source, now);
  }
  if (!hasRequests(dir) && !hasUnreportedUses(dir)) return undefined;
  const keys = (trust ?? exceptionTrust(configPath, process.platform)).keys;
  return pullServerGrants(dir, source, keys, now);
}

/** "Allowed once until 10:30 UTC: ..." for a grant just written. */
export function grantLine(grant: AnyGrant, now: Date): string {
  return `Allowed once until ${clock(grant.expires_at, now)}: the agent can make the call it asked about (exception ${grant.id}) one more time.`;
}

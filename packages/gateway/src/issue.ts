import type { ResolvedSelfhostConfig } from "@selfhost/schema";
import { keyName, keySettings, sameSettings, teamLimits } from "./policy.js";
import type { GatewayClient, IssuedKey, KeyOwner, ManagedKey, ManagedTeam } from "./types.js";

export interface IssueOptions {
  /** Give an existing key a new value; without it an existing key is reported, not changed. */
  rotate?: boolean;
  fallbackProviders?: string[];
}

export type IssueResult = { issued: IssuedKey } | { exists: ManagedKey };

/**
 * Issues the key for `owner` under the team's policy: creates the gateway team when it is
 * missing, then the key with its limits, or a new value for the key when asked to rotate. The
 * value is returned to the caller and kept nowhere.
 */
export async function issueKey(
  client: GatewayClient,
  owner: KeyOwner,
  config: ResolvedSelfhostConfig | undefined,
  options: IssueOptions = {},
): Promise<IssueResult> {
  const settings = keySettings(owner, config, {
    inTeam: true,
    ...(options.fallbackProviders ? { fallbackProviders: options.fallbackProviders } : {}),
  });
  const name = keyName(owner);
  const existing = (await client.keys()).find((key) => key.name === name);
  if (existing && !options.rotate) return { exists: existing };

  let team: ManagedTeam | undefined = (await client.teams()).find((t) => t.team === owner.team);
  team ??= await client.createTeam(owner.team, teamLimits(config));

  if (!existing) return { issued: await client.createKey(owner, settings, team) };
  const held = {
    ...settings,
    budgets: client.held(settings.budgets),
    providers: client.heldProviders(settings.providers),
  };
  if (!sameSettings(existing, held)) await client.updateKey(existing, settings);
  return { issued: await client.rotateKey(existing, settings, team) };
}

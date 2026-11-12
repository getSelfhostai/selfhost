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
 *
 * owner.agent is the one agent the key is for. Asked again for an existing key with another
 * agent, or with none, the key records none from then on: several agents share it, and its
 * requests are attributed by their user-agent only.
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
  if (existing && !options.rotate) {
    if (existing.agent === undefined || existing.agent === owner.agent) return { exists: existing };
    const { agent: _shared, ...shared } = existing;
    await client.updateKey(shared, settings);
    return { exists: shared };
  }

  let team: ManagedTeam | undefined = (await client.teams()).find((t) => t.team === owner.team);
  team ??= await client.createTeam(owner.team, teamLimits(config));

  if (!existing) return { issued: await client.createKey(owner, settings, team) };
  const held = {
    ...settings,
    budgets: client.held(settings.budgets),
    providers: client.heldProviders(settings.providers),
  };
  const { agent: _before, ...rest } = existing;
  const target = { ...rest, ...(owner.agent ? { agent: owner.agent } : {}) };
  if (!sameSettings(existing, held) || existing.agent !== owner.agent) {
    await client.updateKey(target, settings);
  }
  return { issued: await client.rotateKey(target, settings, team) };
}

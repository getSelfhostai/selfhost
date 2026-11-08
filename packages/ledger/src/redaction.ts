import {
  type LedgerEvent,
  type RedactionSettings,
  redactEvent,
  redactionSettings,
} from "@selfhost/schema";
import type { OrgStore } from "./orgs.js";

/**
 * Settings for an event's team: the policy in use for the team (its stored selfhost.toml on
 * top of its org's, read the same way GET /v1/policy reads it), else `fallback`. Composed
 * policies are kept until their text changes.
 */
export function teamRedaction(
  orgs: Pick<OrgStore, "effectivePolicy">,
  fallback: RedactionSettings,
): (team: string | null | undefined) => Promise<RedactionSettings> {
  const parsed = new Map<string, { hash: string; settings: RedactionSettings }>();
  return async (team) => {
    if (team == null) return fallback;
    let policy: Awaited<ReturnType<OrgStore["effectivePolicy"]>>;
    try {
      policy = await orgs.effectivePolicy(team);
    } catch {
      // Only text that validates is stored, so this means the schema changed under it.
      return fallback;
    }
    if (!policy) return fallback;
    const cached = parsed.get(team);
    if (cached?.hash === policy.hash) return cached.settings;
    const settings = redactionSettings(policy.config);
    parsed.set(team, { hash: policy.hash, settings });
    return settings;
  };
}

/** Each event as it may be stored, under the settings of the team it goes to. */
export async function redactBatch(
  events: LedgerEvent[],
  settingsFor: (event: LedgerEvent, index: number) => Promise<RedactionSettings>,
): Promise<LedgerEvent[]> {
  return Promise.all(
    events.map(async (event, index) => redactEvent(event, await settingsFor(event, index))),
  );
}

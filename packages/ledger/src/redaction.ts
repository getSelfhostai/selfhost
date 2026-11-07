import {
  type LedgerEvent,
  parseConfig,
  type RedactionSettings,
  redactEvent,
  redactionSettings,
} from "@selfhost/schema";
import type { TeamStore } from "./teams.js";

/**
 * Settings for an event's team: the team's stored selfhost.toml when it has one, read the same
 * way GET /v1/policy reads it, else `fallback`. Parsed policies are kept until their text changes.
 */
export function teamRedaction(
  teams: Pick<TeamStore, "getPolicy">,
  fallback: RedactionSettings,
): (team: string | undefined) => Promise<RedactionSettings> {
  const parsed = new Map<string, { text: string; settings: RedactionSettings }>();
  return async (team) => {
    if (team === undefined) return fallback;
    const policy = await teams.getPolicy(team);
    if (!policy) return fallback;
    const cached = parsed.get(team);
    if (cached?.text === policy.text) return cached.settings;
    const result = parseConfig(policy.text);
    // PUT /v1/policy stores only text that parses, so this means the schema changed under it.
    const settings = result.ok ? redactionSettings(result.config) : fallback;
    parsed.set(team, { text: policy.text, settings });
    return settings;
  };
}

/** Each event as it may be stored, under its own team's settings. */
export async function redactBatch(
  events: LedgerEvent[],
  settingsFor: (team: string | undefined) => Promise<RedactionSettings>,
): Promise<LedgerEvent[]> {
  const byTeam = new Map<string | undefined, Promise<RedactionSettings>>();
  return Promise.all(
    events.map(async (event) => {
      let settings = byTeam.get(event.team);
      if (!settings) {
        settings = settingsFor(event.team);
        byTeam.set(event.team, settings);
      }
      return redactEvent(event, await settings);
    }),
  );
}

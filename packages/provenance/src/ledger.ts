import { AGENT_VENDORS, type AgentVendor, type LedgerEvent } from "@selfhost/schema";
import type { MergedPull, RunCommit } from "./types.js";

const isVendor = (value: unknown): value is AgentVendor =>
  typeof value === "string" && (AGENT_VENDORS as readonly string[]).includes(value);

/**
 * Commits agent sessions recorded: `commit.created` events with a session id, an agent and a
 * commit SHA. These join a commit to the run that made it.
 */
export function runCommits(events: Iterable<LedgerEvent>): RunCommit[] {
  const runs = new Map<string, RunCommit>();
  for (const event of events) {
    const sha = event.links?.commit_sha;
    const vendor = event.agent?.vendor;
    if (event.kind !== "commit.created" || !sha || !event.session_id || !isVendor(vendor)) {
      continue;
    }
    const key = `${sha.toLowerCase()}\n${event.session_id}`;
    if (runs.has(key)) continue;
    runs.set(key, {
      sha: sha.toLowerCase(),
      agent: { vendor, ...(event.model ? { model: event.model } : {}) },
      sessionId: event.session_id,
    });
  }
  return [...runs.values()];
}

/** Pull requests merged in `repo` (owner/name), from `pr.merged` events, with their agent. */
export function mergedPulls(events: Iterable<LedgerEvent>, repo?: string): MergedPull[] {
  const pulls = new Map<number, MergedPull>();
  for (const event of events) {
    if (event.kind !== "pr.merged") continue;
    if (repo && event.repo?.toLowerCase() !== repo.toLowerCase()) continue;
    const number = event.data?.number;
    if (typeof number !== "number" || pulls.has(number)) continue;
    const vendor = event.agent?.vendor;
    const additions = event.data?.additions;
    pulls.set(number, {
      number,
      ...(isVendor(vendor)
        ? { agent: { vendor, ...(event.model ? { model: event.model } : {}) } }
        : {}),
      ...(event.actor?.kind === "person" ? { person: event.actor.id } : {}),
      ...(typeof additions === "number" ? { additions } : {}),
      mergedAt: event.ts,
    });
  }
  return [...pulls.values()];
}

import type { LedgerEvent } from "@selfhost/schema";
import type { ParsedEvent } from "./types.js";

function isSessionEvent(event: LedgerEvent): boolean {
  return event.kind === "session.started" || event.kind === "session.ended";
}

function sessionKey(event: LedgerEvent): string {
  return `${event.agent?.vendor ?? ""}\n${event.session_id ?? ""}`;
}

function byTimeThenId(a: LedgerEvent, b: LedgerEvent): number {
  return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Picks one event per key across files and reads, and remembers what it already returned so a
 * later read of the same lines adds nothing. Also applies the `since` window: session events
 * are kept for any session with in-window activity, even when the session started earlier.
 */
export class EventSelector {
  private readonly pending = new Map<string, ParsedEvent>();
  /** Key to the timestamp of the copy already returned. */
  private readonly emitted = new Map<string, string>();
  /** Replay group to whether a main-thread entry (true) or only a sidechain copy was returned. */
  private readonly replayGroups = new Map<string, boolean>();
  private readonly activeSessions = new Set<string>();
  /** Session events held back until their session has in-window activity. */
  private readonly deferred = new Map<string, Map<string, ParsedEvent>>();

  add(events: Iterable<ParsedEvent>): void {
    for (const candidate of events) {
      const seen = this.emitted.get(candidate.key);
      if (seen !== undefined && (candidate.keep === "first" || candidate.event.ts <= seen))
        continue;
      const current = this.pending.get(candidate.key);
      const replaces =
        current === undefined ||
        (candidate.keep === "first"
          ? candidate.event.ts < current.event.ts
          : candidate.event.ts >= current.event.ts);
      if (replaces) this.pending.set(candidate.key, candidate);
    }
  }

  /** Marks events as already written without returning them. */
  remember(events: Iterable<ParsedEvent>): void {
    this.add(events);
    this.drain();
  }

  drain(since?: Date): LedgerEvent[] {
    const winners = [...this.pending.values()].sort((a, b) => byTimeThenId(a.event, b.event));
    this.pending.clear();
    const mainGroups = new Set(
      winners.flatMap((parsed) =>
        parsed.replay?.sidechain === false ? [parsed.replay.group] : [],
      ),
    );
    const kept: ParsedEvent[] = [];
    for (const parsed of winners) {
      this.emitted.set(parsed.key, parsed.event.ts);
      const replay = parsed.replay;
      if (replay?.sidechain) {
        // A sidechain copy of a response the main thread or an earlier copy already counted.
        if (this.replayGroups.has(replay.group) || mainGroups.has(replay.group)) continue;
        this.replayGroups.set(replay.group, false);
      } else if (replay) {
        this.replayGroups.set(replay.group, true);
      }
      kept.push(parsed);
    }
    if (since === undefined) return kept.map((parsed) => parsed.event);

    const sinceIso = since.toISOString();
    for (const { event } of kept) {
      if (!isSessionEvent(event) && event.ts >= sinceIso)
        this.activeSessions.add(sessionKey(event));
    }
    const out: LedgerEvent[] = [];
    for (const parsed of kept) {
      const { event } = parsed;
      const session = sessionKey(event);
      if (!isSessionEvent(event)) {
        if (event.ts >= sinceIso) out.push(event);
      } else if (this.activeSessions.has(session) || event.ts >= sinceIso) {
        this.activeSessions.add(session);
        out.push(event);
      } else {
        const held = this.deferred.get(session) ?? new Map<string, ParsedEvent>();
        held.set(parsed.key, parsed);
        this.deferred.set(session, held);
      }
    }
    for (const session of this.activeSessions) {
      const held = this.deferred.get(session);
      if (!held) continue;
      this.deferred.delete(session);
      for (const parsed of held.values()) out.push(parsed.event);
    }
    return out.sort(byTimeThenId);
  }
}

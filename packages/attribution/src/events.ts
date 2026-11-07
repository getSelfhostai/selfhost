import { createHash } from "node:crypto";
import {
  type Actor,
  EVENT_SCHEMA,
  type EventKind,
  type EventSource,
  type LedgerEvent,
} from "@selfhost/schema";
import { accountVendor } from "./match.js";
import type { AgentRef, CommitRecord, PullRecord } from "./types.js";

/** A UUIDv7 holding the event time, with the rest from a hash of `key`: same input, same id. */
function eventId(ts: string, key: string): string {
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(Math.min(Math.max(Date.parse(ts) || 0, 0), 2 ** 48 - 1), 0, 6);
  createHash("sha256").update(key).digest().copy(bytes, 6, 0, 10);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function attribution(agent: AgentRef | undefined, signal: string | undefined) {
  if (!agent || !signal) return { data: { unattributed: true } };
  return {
    agent: { vendor: agent.vendor },
    ...(agent.model ? { model: agent.model } : {}),
    data: { signal },
  };
}

function event(
  source: EventSource,
  kind: EventKind,
  ts: string,
  key: string,
  fields: Omit<LedgerEvent, "id" | "schema" | "ts" | "source" | "kind">,
): LedgerEvent {
  return {
    id: eventId(ts, `${source}:${kind}:${key}`),
    schema: EVENT_SCHEMA,
    ts,
    source,
    kind,
    ...fields,
  };
}

/**
 * Ledger events for commits and pull requests: `commit.created` (source `cli`, read from local
 * git) and `pr.opened`, `pr.merged`, `pr.closed` (source `github`). Attributed records carry
 * `agent`, `model` and `data.signal`; the rest carry `data.unattributed`. The commit author or
 * pull request author is the actor, an agent when it is a bot account; `ctx.actorId` stands in
 * when the author is unknown. Ids derive from the repository and the commit SHA or pull request
 * URL, so scanning twice stores nothing new.
 */
export function toLedgerEvents(
  commits: CommitRecord[],
  pulls: PullRecord[],
  ctx: { actorId: string; repo?: string },
): LedgerEvent[] {
  const repo = ctx.repo ? { repo: ctx.repo } : {};
  const scope = ctx.repo ?? "";
  const prBySha = new Map<string, string>();
  for (const pull of pulls) for (const sha of pull.commits) prBySha.set(sha, pull.url);

  const commitEvents = commits.map((commit) => {
    const actor: Actor = {
      kind: accountVendor({ email: commit.authorEmail }) ? "agent" : "person",
      id: commit.authorEmail || ctx.actorId,
    };
    const { data, ...agent } = attribution(commit.agent, commit.signal);
    const prUrl = prBySha.get(commit.sha);
    return event("cli", "commit.created", commit.authoredAt, `${scope}:${commit.sha}`, {
      actor,
      ...repo,
      ...agent,
      ...(commit.sessionId ? { session_id: commit.sessionId } : {}),
      links: { commit_sha: commit.sha.toLowerCase(), ...(prUrl ? { pr_url: prUrl } : {}) },
      data: {
        ...data,
        additions: commit.additions,
        deletions: commit.deletions,
        files: commit.files.length,
      },
    });
  });

  const pullEvents = pulls.flatMap((pull) => {
    // PullRecord keeps only the login; plain agent logins such as "Copilot" count as bots when
    // the bot account was the evidence.
    const bot =
      /\[bot\]$/i.test(pull.author) ||
      (pull.signal === "bot_account" &&
        accountVendor({ login: pull.author, type: "Bot" }) !== undefined);
    const actor: Actor = bot
      ? { kind: "agent", id: `github:${pull.author}` }
      : { kind: "person", id: pull.author === "ghost" ? ctx.actorId : pull.author };
    const { data, ...agent } = attribution(pull.agent, pull.signal);
    const fields = {
      actor,
      ...repo,
      ...agent,
      target: { type: "pr" as const, value: pull.url },
      links: { pr_url: pull.url },
      data: {
        ...data,
        number: pull.number,
        head_ref: pull.headRef,
        additions: pull.additions,
        deletions: pull.deletions,
        commits: pull.commits.length,
      },
    };
    const review = {
      approvals: pull.approvals,
      review_comments: pull.reviewComments,
      issue_comments: pull.issueComments,
    };
    const events = [event("github", "pr.opened", pull.createdAt, pull.url, fields)];
    if (pull.state === "merged" && pull.mergedAt) {
      events.push(
        event("github", "pr.merged", pull.mergedAt, pull.url, {
          ...fields,
          data: { ...fields.data, ...review, unreviewed_merge: pull.unreviewedMerge },
        }),
      );
    } else if (pull.state === "closed" && pull.closedAt) {
      events.push(
        event("github", "pr.closed", pull.closedAt, pull.url, {
          ...fields,
          data: { ...fields.data, ...review },
        }),
      );
    }
    return events;
  });

  return [...commitEvents, ...pullEvents];
}

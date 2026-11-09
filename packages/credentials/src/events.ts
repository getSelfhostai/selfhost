import { stableEventId } from "@selfhost/ledger";
import { POLICY_ACTOR_ID } from "@selfhost/policy";
import {
  type AgentRef,
  CREDENTIAL_EVENT_DATA_VERSION,
  type CredentialIssuedData,
  type CredentialRevokedData,
  EGRESS_ALLOW_RULE_ID,
  type EgressBlockedData,
  EVENT_SCHEMA,
  type ExecutionLocation,
  type LedgerEvent,
} from "@selfhost/schema";

/** The actor of every event this package writes. */
export const CREDENTIALS_ACTOR_ID = "selfhost-credentials";

/** The run an event belongs to. */
export interface EventRun {
  id: string;
  team: string;
  repo?: string;
}

function base(kind: LedgerEvent["kind"], run: EventRun, ts: string, key: string) {
  return {
    id: stableEventId(ts, `${kind}\n${run.id}\n${key}`),
    schema: EVENT_SCHEMA as typeof EVENT_SCHEMA,
    ts,
    source: "server" as const,
    kind,
    actor: { kind: "system" as const, id: CREDENTIALS_ACTOR_ID },
    team: run.team,
    run_id: run.id,
    ...(run.repo ? { repo: run.repo } : {}),
  };
}

export function credentialIssuedEvent(
  run: EventRun,
  data: Omit<CredentialIssuedData, "v">,
  ts: string,
): LedgerEvent {
  return {
    ...base("credential.issued", run, ts, data.name),
    data: { v: CREDENTIAL_EVENT_DATA_VERSION, ...data },
  };
}

export function credentialRevokedEvent(
  run: EventRun,
  data: Omit<CredentialRevokedData, "v">,
  ts: string,
): LedgerEvent {
  return {
    ...base("credential.revoked", run, ts, data.name),
    data: { v: CREDENTIAL_EVENT_DATA_VERSION, ...data },
  };
}

/** Where a blocked connection was seen, and what it belongs to. */
export interface EgressContext {
  location: ExecutionLocation;
  ts: string;
  run?: EventRun;
  session_id?: string;
  agent?: AgentRef;
}

/**
 * A connection the egress allow list refused: a tool call the hook stopped (by "hook"), or one
 * the sandbox's network controls refused and the runtime reported (by "runtime").
 */
export function egressBlockedEvent(
  blocked: {
    host: string;
    port?: number;
    by: EgressBlockedData["by"];
    mode?: EgressBlockedData["mode"];
  },
  where: EgressContext,
): LedgerEvent {
  const mode = blocked.mode ?? "enforce";
  const actor = blocked.by === "hook" ? POLICY_ACTOR_ID : CREDENTIALS_ACTOR_ID;
  const target = blocked.port ? `${blocked.host}:${blocked.port}` : blocked.host;
  const scope = where.run?.id ?? where.session_id ?? "";
  return {
    id: stableEventId(where.ts, `egress.blocked\n${scope}\n${blocked.by}\n${target}`),
    schema: EVENT_SCHEMA as typeof EVENT_SCHEMA,
    ts: where.ts,
    source: blocked.by === "hook" ? "hook" : "server",
    kind: "egress.blocked",
    actor: { kind: "system", id: actor },
    ...(where.run
      ? {
          team: where.run.team,
          run_id: where.run.id,
          ...(where.run.repo ? { repo: where.run.repo } : {}),
        }
      : {}),
    ...(where.agent ? { agent: where.agent } : {}),
    ...(where.session_id ? { session_id: where.session_id } : {}),
    target: { type: "url", value: target },
    decision: {
      verdict: "block",
      by: actor,
      rule_id: EGRESS_ALLOW_RULE_ID,
      mode,
      reason: `Host "${blocked.host}" is not in [egress] allow.`,
    },
    data: {
      v: CREDENTIAL_EVENT_DATA_VERSION,
      host: blocked.host,
      ...(blocked.port !== undefined ? { port: blocked.port } : {}),
      by: blocked.by,
      mode,
      location: where.location,
    },
  };
}

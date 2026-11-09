import { type Static, Type } from "@sinclair/typebox";
import { NonEmpty, StringEnum } from "./common.js";

/**
 * The `data` of the ledger events that track a run's credentials and its blocked connections.
 * Each carries `v`, the version of its own shape, so a reader can tell a later shape apart while
 * the event schema stays selfhost.event/v1. Values never appear in these events: only the
 * variable name, where the value came from and what it may reach.
 */
export const CREDENTIAL_EVENT_DATA_VERSION = 1;

/** Runtime kinds a location or a credential event can name. Same list as @selfhost/runtime. */
export const RUNTIME_KINDS_RECORDED = ["e2b", "daytona", "modal", "coder", "opensandbox"] as const;

export const CREDENTIAL_KINDS = ["github_app_token", "gateway_key", "secret"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export const CREDENTIAL_SOURCES = ["github-app", "gateway", "env", "vault", "infisical"] as const;
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];

/** Why a credential was revoked: the run's end, whatever ended it. */
export const REVOKE_REASONS = ["succeeded", "failed", "timed_out", "killed", "aborted"] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

const Location = NonEmpty({
  description: "Where the run executed: laptop, local:<sandbox> or runtime:<kind>.",
});

export const CredentialIssuedDataSchema = Type.Object(
  {
    v: Type.Literal(CREDENTIAL_EVENT_DATA_VERSION),
    credential: StringEnum(CREDENTIAL_KINDS),
    /** The variable inside the sandbox. */
    name: NonEmpty(),
    source: StringEnum(CREDENTIAL_SOURCES),
    /** owner/name the credential is limited to, for a GitHub App token. */
    repository: Type.Optional(NonEmpty()),
    permissions: Type.Optional(Type.Record(Type.String(), Type.String())),
    /** A gateway key's run budget in USD. */
    budget_usd: Type.Optional(Type.Number({ minimum: 0 })),
    /** Host the value is injected for at the sandbox's egress, when it never enters the sandbox. */
    injected_for: Type.Optional(NonEmpty()),
    expires_at: Type.Optional(Type.String({ format: "date-time" })),
    location: Location,
  },
  { additionalProperties: false, title: "CredentialIssuedData" },
);

export const CredentialRevokedDataSchema = Type.Object(
  {
    v: Type.Literal(CREDENTIAL_EVENT_DATA_VERSION),
    credential: StringEnum(CREDENTIAL_KINDS),
    name: NonEmpty(),
    source: StringEnum(CREDENTIAL_SOURCES),
    reason: StringEnum(REVOKE_REASONS),
    /** false when revoking failed; the credential then lives until it expires. */
    ok: Type.Boolean(),
    error: Type.Optional(Type.String()),
    location: Location,
  },
  { additionalProperties: false, title: "CredentialRevokedData" },
);

export const EgressBlockedDataSchema = Type.Object(
  {
    v: Type.Literal(CREDENTIAL_EVENT_DATA_VERSION),
    host: NonEmpty(),
    port: Type.Optional(Type.Integer({ minimum: 0, maximum: 65535 })),
    /** hook: a tool call stopped before it ran; runtime: the sandbox's network controls refused it. */
    by: StringEnum(["hook", "runtime"] as const),
    mode: StringEnum(["observe", "enforce"] as const),
    location: Location,
  },
  { additionalProperties: false, title: "EgressBlockedData" },
);

export type CredentialIssuedData = Static<typeof CredentialIssuedDataSchema>;
export type CredentialRevokedData = Static<typeof CredentialRevokedDataSchema>;
export type EgressBlockedData = Static<typeof EgressBlockedDataSchema>;

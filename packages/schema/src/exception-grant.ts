import { type Static, Type } from "@sinclair/typebox";
import { DateTime, NonEmpty, StringEnum, Uuidv7 } from "./common.js";

/**
 * One-time exceptions in team mode: the team server signs the grant that lets one blocked tool
 * call through once, with an Ed25519 key only it holds. Laptops verify the signature with the
 * server's public keys, pinned in the root-owned managed settings (or, without them, in
 * ~/.selfhost/config.json), so an agent running as the person cannot write a grant itself.
 */

export const EXCEPTION_GRANT_SCHEMA = "selfhost.exception_grant/v2";
export const EXCEPTION_GRANT_STATUS_SCHEMA = "selfhost.exception_grant_status/v1";
export const EXCEPTION_KEYS_SCHEMA = "selfhost.exception_keys/v1";

/** Where a request for a grant stands on the server. */
export const EXCEPTION_GRANT_STATES = ["waiting", "granted", "refused", "used", "expired"] as const;

const Hex = (length: number, description: string) =>
  Type.String({ pattern: `^[0-9a-f]{${length}}$`, description });

const KeyId = () =>
  Hex(16, "The signing key's id: the first 16 hex digits of sha256 of its public key.");

export const ExceptionGrantSchema = Type.Object(
  {
    schema: Type.Literal(EXCEPTION_GRANT_SCHEMA, { description: "Schema version tag." }),
    id: Uuidv7({ description: "The exception id: the review item the block named." }),
    nonce: Hex(32, "Random per grant; a laptop uses a grant with a given nonce once."),
    fingerprint: Hex(
      64,
      "The keyed hash of the blocked call the laptop reported. The hook allows only a call with the same hash.",
    ),
    rules: Type.Array(NonEmpty(), { description: "Rule ids the grant lets the call past." }),
    agent: NonEmpty({ description: "The agent whose call was blocked." }),
    session_id: Type.Union([Type.String(), Type.Null()], {
      description: "The agent session that was blocked; another session cannot use the grant.",
    }),
    repo: Type.Union([Type.String(), Type.Null()], {
      description: "The repository as owner/name, when the block named one.",
    }),
    requested_by: NonEmpty({ description: "The person whose agent was blocked." }),
    approved_by: NonEmpty({ description: "The person who approved the exception." }),
    decision_event_id: Uuidv7({ description: "The decision.recorded event of the approval." }),
    team: NonEmpty({ description: "The team the exception belongs to." }),
    approved_at: DateTime(),
    issued_at: DateTime({ description: "When the server signed the grant." }),
    expires_at: DateTime({
      description:
        "approved_at plus the team's [review] exception_expiry_minutes. The call is blocked again after it.",
    }),
    key_id: KeyId(),
    signature: Type.String({
      pattern: "^[A-Za-z0-9_-]{86}$",
      description: "Ed25519 signature, base64url, over exceptionGrantPayload of the fields above.",
    }),
  },
  {
    additionalProperties: false,
    title: "ExceptionGrant",
    description:
      "A one-time exception the team server signed: lets one blocked tool call through once, in the session and repository that asked, until it expires.",
  },
);

export const ExceptionGrantStatusSchema = Type.Object(
  {
    schema: Type.Literal(EXCEPTION_GRANT_STATUS_SCHEMA, { description: "Schema version tag." }),
    id: Uuidv7({ description: "The exception id." }),
    state: StringEnum(EXCEPTION_GRANT_STATES, {
      description:
        "waiting: nobody answered yet. granted: approved, grant holds the signed grant. refused: denied, dismissed, timed out, or approved by someone who may not. used: a laptop reported using it. expired: approved, but its time ran out.",
    }),
    grant: Type.Optional(ExceptionGrantSchema),
    reason: Type.Optional(Type.String({ description: "Why it was refused." })),
  },
  { additionalProperties: false, title: "ExceptionGrantStatus" },
);

export const ExceptionGrantUseRequestSchema = Type.Object(
  {
    nonce: Hex(32, "The nonce of the grant the hook used."),
    machine: Type.Optional(
      Type.String({ maxLength: 64, description: "The laptop's random id, for the record." }),
    ),
  },
  { additionalProperties: false, title: "ExceptionGrantUseRequest" },
);

export const ExceptionKeySchema = Type.Object(
  {
    id: KeyId(),
    public_key: Type.String({
      pattern: "^[A-Za-z0-9_-]{43}$",
      description: "The raw 32-byte Ed25519 public key, base64url.",
    }),
    created_at: DateTime(),
  },
  { additionalProperties: false, title: "ExceptionKey" },
);

export const ExceptionKeysResponseSchema = Type.Object(
  {
    schema: Type.Literal(EXCEPTION_KEYS_SCHEMA, { description: "Schema version tag." }),
    algorithm: Type.Literal("ed25519"),
    active: KeyId(),
    keys: Type.Array(ExceptionKeySchema, {
      description:
        "Every key the server signs or signed grants with, the active one included. Laptops pin these.",
    }),
  },
  { additionalProperties: false, title: "ExceptionKeysResponse" },
);

export type ExceptionGrant = Static<typeof ExceptionGrantSchema>;
export type ExceptionGrantStatus = Static<typeof ExceptionGrantStatusSchema>;
export type ExceptionGrantState = (typeof EXCEPTION_GRANT_STATES)[number];
export type ExceptionGrantUseRequest = Static<typeof ExceptionGrantUseRequestSchema>;
export type ExceptionKey = Static<typeof ExceptionKeySchema>;
export type ExceptionKeysResponse = Static<typeof ExceptionKeysResponseSchema>;

/**
 * The bytes the server signs and a laptop verifies: every field of the grant but the signature,
 * in a fixed order, after a line naming the schema. Changing a field changes the bytes.
 */
export function exceptionGrantPayload(grant: Omit<ExceptionGrant, "signature">): Uint8Array {
  const fields = [
    grant.id,
    grant.nonce,
    grant.fingerprint,
    grant.rules,
    grant.agent,
    grant.session_id,
    grant.repo,
    grant.requested_by,
    grant.approved_by,
    grant.decision_event_id,
    grant.team,
    grant.approved_at,
    grant.issued_at,
    grant.expires_at,
    grant.key_id,
  ];
  return new TextEncoder().encode(`${EXCEPTION_GRANT_SCHEMA}\n${JSON.stringify(fields)}`);
}

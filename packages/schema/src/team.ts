import { type Static, Type } from "@sinclair/typebox";
import { DateTime, NonEmpty, StringEnum } from "./common.js";

/** People, teams and invites on a team server: the bodies of /v1/teams, /v1/join and /v1/me. */

export const PERSON_ROLES = ["owner", "admin", "member"] as const;

/** What a stored token grants. Only its sha256 is kept. */
export const TOKEN_KINDS = ["admin", "person", "invite"] as const;

export type PersonRole = (typeof PERSON_ROLES)[number];
export type TokenKind = (typeof TOKEN_KINDS)[number];

export const TEAM_ID_PATTERN = "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$";

const TeamId = (description: string) => Type.String({ pattern: TEAM_ID_PATTERN, description });

const PersonId = (description: string) => NonEmpty({ maxLength: 256, description });

export const TeamInfoSchema = Type.Object(
  {
    id: TeamId("Team id, derived from the name. Set as team on every event its people write."),
    name: NonEmpty({ description: "Team name as given." }),
    created_at: DateTime(),
  },
  { additionalProperties: false, title: "TeamInfo" },
);

export const PersonSchema = Type.Object(
  {
    id: PersonId("Who the person is, such as a git email. Their events carry it as actor.id."),
    name: Type.Optional(Type.String({ description: "Display name." })),
    team: TeamId("Team the person belongs to."),
    role: StringEnum(PERSON_ROLES, {
      description: "owner for the first person to join, member for everyone after.",
    }),
    created_at: DateTime(),
  },
  { additionalProperties: false, title: "Person" },
);

export const CreateTeamRequestSchema = Type.Object(
  {
    name: NonEmpty({ maxLength: 100, description: "Team name. Its id is the name in kebab case." }),
  },
  { additionalProperties: false, title: "CreateTeamRequest" },
);

export const CreateTeamResponseSchema = Type.Object(
  {
    team: TeamInfoSchema,
    invite: NonEmpty({
      description:
        "Invite code to share with the team. Anyone holding it can join, so share it like a password.",
    }),
  },
  { additionalProperties: false, title: "CreateTeamResponse" },
);

export const JoinRequestSchema = Type.Object(
  {
    invite: NonEmpty({ description: "Invite code from POST /v1/teams." }),
    person: PersonId("Who is joining, such as their git email."),
    name: Type.Optional(Type.String({ maxLength: 200, description: "Display name." })),
  },
  { additionalProperties: false, title: "JoinRequest" },
);

export const JoinResponseSchema = Type.Object(
  {
    token: NonEmpty({
      description:
        "Person token. It writes events as this person and reads the team policy. Shown once; the server keeps only its sha256.",
    }),
    person: PersonSchema,
    team: TeamInfoSchema,
  },
  { additionalProperties: false, title: "JoinResponse" },
);

export const MeResponseSchema = Type.Object(
  {
    kind: StringEnum(["admin", "person"] as const, {
      description: "admin for the server's admin token, person for a person token.",
    }),
    person: Type.Optional(PersonSchema),
    team: Type.Optional(TeamInfoSchema),
  },
  { additionalProperties: false, title: "MeResponse" },
);

export const SetPolicyRequestSchema = Type.Object(
  {
    text: Type.String({
      maxLength: 1_000_000,
      description: "The team's selfhost.toml. Validated like selfhost doctor does.",
    }),
  },
  { additionalProperties: false, title: "SetPolicyRequest" },
);

export const InvalidPolicyErrorSchema = Type.Object(
  {
    error: Type.Object({ code: Type.Literal("invalid_policy"), message: Type.String() }),
    errors: Type.Array(
      Type.Object(
        {
          field: Type.String({ description: "Field path, for example rules[0].mode." }),
          message: Type.String(),
          line: Type.Optional(Type.Integer({ minimum: 1 })),
          column: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false, title: "InvalidPolicyError" },
);

export type TeamInfo = Static<typeof TeamInfoSchema>;
export type Person = Static<typeof PersonSchema>;
export type CreateTeamRequest = Static<typeof CreateTeamRequestSchema>;
export type CreateTeamResponse = Static<typeof CreateTeamResponseSchema>;
export type JoinRequest = Static<typeof JoinRequestSchema>;
export type JoinResponse = Static<typeof JoinResponseSchema>;
export type MeResponse = Static<typeof MeResponseSchema>;
export type SetPolicyRequest = Static<typeof SetPolicyRequestSchema>;
export type InvalidPolicyError = Static<typeof InvalidPolicyErrorSchema>;

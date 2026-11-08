import { type Static, Type } from "@sinclair/typebox";
import { DateTime, NonEmpty, StringEnum, Uuidv7 } from "./common.js";
import { TEAM_ID_PATTERN } from "./team.js";

/**
 * Context layers: the rules, skills, commands, subagents and MCP servers of .selfhost/context,
 * kept at four levels and merged in this order. Later layers add items; when two layers have
 * the same item the earlier one is kept, so the org's items are a floor nobody replaces, and the
 * merge names the item that lost. The org and team layers live on the server, the repo layer
 * is the repository's own .selfhost/context, and the personal layer stays on the laptop.
 */
export const CONTEXT_LAYER_KINDS = ["org", "team", "repo", "personal"] as const;

/** A proposal to add a personal item to the team: open until an owner or admin answers it. */
export const CONTEXT_PROPOSAL_STATES = ["open", "applied", "refused"] as const;

/** An item as kind:name, the way the coverage names it: rule:no-secrets, mcp:team-memory. */
export const CONTEXT_ITEM_PATTERN = "^(rule|skill|command|agent|mcp):[A-Za-z0-9_-]{1,64}$";

/** A path inside a context folder: mcp.json, or a file under rules/, skills/, commands/, agents/. */
export const CONTEXT_FILE_PATTERN =
  "^(mcp\\.json|(rules|skills|commands|agents)/[A-Za-z0-9 ._/+-]+)$";

export type ContextLayerKind = (typeof CONTEXT_LAYER_KINDS)[number];
export type ContextProposalState = (typeof CONTEXT_PROPOSAL_STATES)[number];

const TeamId = (description: string) => Type.String({ pattern: TEAM_ID_PATTERN, description });

const ItemId = (description: string) => Type.String({ pattern: CONTEXT_ITEM_PATTERN, description });

export const ContextFileSchema = Type.Object(
  {
    path: Type.String({
      pattern: CONTEXT_FILE_PATTERN,
      maxLength: 512,
      description: "Path inside the context folder, like rules/no-secrets.md or mcp.json.",
    }),
    text: Type.String({ maxLength: 1_000_000, description: "The file, as UTF-8 text." }),
    executable: Type.Optional(
      Type.Boolean({ description: "A skill's script, written with the executable bit." }),
    ),
  },
  { additionalProperties: false, title: "ContextFile" },
);

const Files = Type.Array(ContextFileSchema, {
  maxItems: 500,
  description:
    "The layer's files in the .selfhost/context layout: rules/<name>.md, skills/<name>/SKILL.md and the files beside it, commands/<name>.md, agents/<name>.md and mcp.json.",
});

export const SetContextRequestSchema = Type.Object(
  { files: Files },
  { additionalProperties: false, title: "SetContextRequest" },
);

export const ContextLayerSchema = Type.Object(
  {
    kind: StringEnum(["org", "team"] as const, { description: "Which layer." }),
    name: NonEmpty({ description: "The org id or the team id." }),
    hash: Type.String({ description: "sha256 of the layer's files." }),
    updated_at: DateTime({ description: "When the layer was last set or an item was added." }),
    files: Files,
  },
  { additionalProperties: false, title: "ContextLayer" },
);

const ConflictSide = (description: string) =>
  Type.Object(
    {
      item: ItemId("The item, as kind:name."),
      layer: StringEnum(CONTEXT_LAYER_KINDS),
      name: NonEmpty({ description: "The org id, team id, repo or person of the layer." }),
      path: NonEmpty({ description: "Where the item is defined." }),
    },
    { additionalProperties: false, description },
  );

export const ContextConflictSchema = Type.Object(
  {
    lost: ConflictSide("The item that is not used."),
    kept: ConflictSide("The item of the earlier layer, which is used instead."),
    message: Type.String(),
  },
  {
    additionalProperties: false,
    title: "ContextConflict",
    description:
      "Two layers define the same item (or a skill and a command share a name). The earlier layer's item is used; the org's always wins.",
  },
);

export const ContextProposalSchema = Type.Object(
  {
    id: Uuidv7({ description: "The proposal's id, which is also its review item's id." }),
    team: TeamId("The team it is proposed to."),
    person: NonEmpty({ description: "Who proposed it." }),
    item: ItemId("The item, as kind:name."),
    state: StringEnum(CONTEXT_PROPOSAL_STATES, {
      description:
        "open until its review item is answered; applied once an owner or admin approved it and it was added to the team layer; refused when it was denied, replaced by a newer proposal, approved by someone without the role, or the team layer already has the item.",
    }),
    created_at: DateTime(),
    decided_at: Type.Optional(DateTime()),
    decided_by: Type.Optional(NonEmpty({ description: "Who answered the review item." })),
    note: Type.Optional(Type.String({ description: "Why it was refused." })),
  },
  { additionalProperties: false, title: "ContextProposal" },
);

export const ContextResponseSchema = Type.Object(
  {
    team: TeamId("Team id."),
    org: TeamId("The team's org."),
    hash: Type.String({ description: "sha256 over the layers, to tell whether anything changed." }),
    layers: Type.Array(ContextLayerSchema, {
      description: "The org layer, then the team layer; a layer that was never set is left out.",
    }),
    conflicts: Type.Array(ContextConflictSchema, {
      description: "Team items the org layer replaces.",
    }),
    proposals: Type.Array(ContextProposalSchema, {
      description: "The team's newest proposals, at most 50, newest first.",
    }),
  },
  { additionalProperties: false, title: "ContextResponse" },
);

export const OrgContextResponseSchema = Type.Object(
  {
    org: TeamId("Org id."),
    hash: Type.String({ description: "sha256 of the layer's files." }),
    updated_at: Type.Union([DateTime(), Type.Null()], {
      description: "When the org layer was set; null when it never was.",
    }),
    files: Files,
  },
  { additionalProperties: false, title: "OrgContextResponse" },
);

export const ContextProposalRequestSchema = Type.Object(
  {
    team: Type.Optional(TeamId("Team to propose it to. Default: the person token's own.")),
    item: ItemId("The item, as kind:name."),
    files: Files,
  },
  { additionalProperties: false, title: "ContextProposalRequest" },
);

export type ContextFile = Static<typeof ContextFileSchema>;
export type SetContextRequest = Static<typeof SetContextRequestSchema>;
export type ContextLayerInfo = Static<typeof ContextLayerSchema>;
export type ContextConflict = Static<typeof ContextConflictSchema>;
export type ContextProposal = Static<typeof ContextProposalSchema>;
export type ContextResponse = Static<typeof ContextResponseSchema>;
export type OrgContextResponse = Static<typeof OrgContextResponseSchema>;
export type ContextProposalRequest = Static<typeof ContextProposalRequestSchema>;

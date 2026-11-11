import { type Static, Type } from "@sinclair/typebox";
import { DateTime, NonEmpty, RepoSlug, StringEnum, Url, Uuidv7 } from "./common.js";
import { AgentRefSchema, type LedgerEvent } from "./event.js";
import { maskSecrets, type RedactionPattern } from "./redact.js";
import { REVIEW_ITEM_KINDS } from "./review-item.js";
import { createValidator } from "./validate.js";

/**
 * A run handoff: one person gives an agent run (a session) to a teammate, who takes it over on
 * their own machine under their own agent login. The team server keeps one record per handoff
 * with what the new owner needs (branch, commit, files, open review items, cost so far, the last
 * turns and a note) and writes a run.handed_off ledger event for the owner change, so cost and
 * outcome stay on one run, each part with the person who held it. selfhost uses each agent's own
 * resume where it has one; otherwise the brief written at takeover is the handoff.
 */

export const HANDOFF_SCHEMA = "selfhost.handoff/v1";
export const HANDOFFS_SCHEMA = "selfhost.handoffs/v1";
export const TAKEOVER_SCHEMA = "selfhost.takeover/v1";
export const RUN_SHARE_SCHEMA = "selfhost.run_share/v1";

/** The ledger event kind an owner change is recorded under. */
export const HANDOFF_EVENT_KIND = "run.handed_off";

/**
 * The version of a run.handed_off event's `data`, its `v`, so a later shape can be told apart
 * while the event schema stays selfhost.event/v1.
 */
export const HANDOFF_EVENT_DATA_VERSION = 1;

/**
 * pending: waiting for the new owner's takeover. taken: they took it over. superseded: the run
 * was handed on again before anyone took this one.
 */
export const HANDOFF_STATES = ["pending", "taken", "superseded"] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];

/** Agents whose own transcript format selfhost can carry for a native resume. */
export const TRANSCRIPT_VENDORS = ["claude_code", "codex"] as const;
export type TranscriptVendor = (typeof TRANSCRIPT_VENDORS)[number];

export const HANDOFF_TURNS_DEFAULT = 10;
export const HANDOFF_TURNS_MAX = 50;
/** Files touched listed on a handoff, at most. */
export const HANDOFF_FILES_MAX = 200;
/** A note's length, at most. */
export const HANDOFF_NOTE_MAX = 4000;
/** A transcript's size, at most: larger ones go as the brief only. */
export const HANDOFF_TRANSCRIPT_MAX_BYTES = 24 * 1024 * 1024;

/** data of a run.handed_off event. */
export const HandoffEventDataSchema = Type.Object(
  {
    v: Type.Literal(HANDOFF_EVENT_DATA_VERSION),
    handoff: Uuidv7({ description: "The handoff record." }),
    owner: NonEmpty({ description: "The person who holds the run from now on." }),
    previous_owner: NonEmpty({ description: "The person who held it until now." }),
    branch: Type.Optional(NonEmpty({ description: "The git branch the work is on." })),
  },
  { additionalProperties: false, title: "HandoffEventData" },
);
export type HandoffEventData = Static<typeof HandoffEventDataSchema>;

const handoffData = createValidator(HandoffEventDataSchema);

/** The owner change a run.handed_off event holds, or undefined for any other event. */
export function handoffOf(event: Pick<LedgerEvent, "kind" | "data">): HandoffEventData | undefined {
  if (event.kind !== HANDOFF_EVENT_KIND) return undefined;
  const checked = handoffData.validate(event.data);
  return checked.ok ? checked.value : undefined;
}

export const HandoffTurnSchema = Type.Object(
  {
    ts: DateTime({ description: "When it happened." }),
    kind: NonEmpty({ description: "The ledger event kind." }),
    text: Type.String({
      description:
        "One line, redacted under the team's settings: a prompt shows only while log_prompts is on.",
    }),
  },
  { additionalProperties: false, title: "HandoffTurn" },
);
export type HandoffTurn = Static<typeof HandoffTurnSchema>;

export const HandoffItemSchema = Type.Object(
  {
    id: Uuidv7(),
    kind: StringEnum(REVIEW_ITEM_KINDS),
    title: Type.String(),
    blocking: Type.Boolean(),
  },
  { additionalProperties: false, title: "HandoffItem", description: "An open review item." },
);
export type HandoffItem = Static<typeof HandoffItemSchema>;

export const HandoffTranscriptInfoSchema = Type.Object(
  {
    vendor: StringEnum(TRANSCRIPT_VENDORS),
    file_name: NonEmpty({ description: "The transcript's own file name on the sender's machine." }),
    bytes: Type.Integer({ minimum: 0 }),
    redacted: Type.Literal(true, {
      description:
        "Secrets, emails and the team's [[redaction]] patterns were masked before it was stored.",
    }),
  },
  { additionalProperties: false, title: "HandoffTranscriptInfo" },
);

export const HandoffRemoteSchema = Type.Object(
  {
    url: Type.String({
      minLength: 1,
      maxLength: 2000,
      description:
        "The remote's URL as the sender's git has it, with any user name or password taken out.",
    }),
    branch: NonEmpty({
      description:
        "The branch on that remote: the upstream's name, which can differ from the local one.",
    }),
  },
  {
    additionalProperties: false,
    title: "HandoffRemote",
    description: "Where the branch was pushed: the remote and branch its upstream names.",
  },
);
export type HandoffRemote = Static<typeof HandoffRemoteSchema>;

export const HandoffSchema = Type.Object(
  {
    schema: Type.Literal(HANDOFF_SCHEMA),
    id: Uuidv7({ description: "Handoff id, as selfhost takeover takes it." }),
    run_id: NonEmpty({ description: "The run: the agent's session id." }),
    team: Type.Union([Type.String(), Type.Null()]),
    repo: Type.Union([RepoSlug(), Type.Null()]),
    agent: Type.Union([AgentRefSchema, Type.Null()]),
    from: NonEmpty({ description: "The owner before the handoff." }),
    to: NonEmpty({ description: "The new owner." }),
    by: NonEmpty({
      description: "Who handed it over: the owner, a team owner or admin, or admin (the token).",
    }),
    created_at: DateTime(),
    note: Type.Union([Type.String(), Type.Null()], { description: "Redacted." }),
    branch: Type.Union([Type.String(), Type.Null()]),
    commit: Type.Union([Type.String({ pattern: "^[0-9a-f]{7,64}$" }), Type.Null()]),
    pushed: Type.Union([Type.Boolean(), Type.Null()], {
      description:
        "Whether the branch's commits were on its upstream when it was handed over, as the sender's git knew; null when not known.",
    }),
    remote: Type.Optional(
      Type.Union([HandoffRemoteSchema, Type.Null()], {
        description:
          "The remote the branch was pushed to, so takeover fetches from it whatever the new owner named that remote; null when the branch tracks none. Absent on handoffs from before it was recorded.",
      }),
    ),
    uncommitted: Type.Array(Type.String(), {
      description: "Files with changes not committed on the sender's machine: they did not travel.",
    }),
    files: Type.Array(Type.String(), { description: "Files the run's tool calls touched." }),
    open_items: Type.Array(HandoffItemSchema, {
      description: "The run's open review items; they route to the new owner.",
    }),
    cost_usd: Type.Number({ minimum: 0, description: "The run's spend up to the handoff." }),
    tokens: Type.Integer({ minimum: 0 }),
    turns: Type.Array(HandoffTurnSchema, { description: "The run's last turns, oldest first." }),
    transcript: Type.Union([HandoffTranscriptInfoSchema, Type.Null()], {
      description:
        "The agent's own transcript, when the team's [handoff] share_transcript is on and it was sent; its text goes to the new owner once, at takeover.",
    }),
    state: StringEnum(HANDOFF_STATES),
    taken_at: Type.Union([DateTime(), Type.Null()]),
    event_id: Uuidv7({ description: "The run.handed_off ledger event." }),
    run_url: Url({ description: "The run in the console." }),
  },
  { additionalProperties: false, title: "Handoff" },
);
export type Handoff = Static<typeof HandoffSchema>;

export const TranscriptUploadSchema = Type.Object(
  {
    vendor: StringEnum(TRANSCRIPT_VENDORS),
    file_name: Type.String({ pattern: "^[A-Za-z0-9._-]{1,200}\\.jsonl$" }),
    text: Type.String({ description: "The JSONL transcript, redacted by the sender." }),
  },
  { additionalProperties: false, title: "TranscriptUpload" },
);
export type TranscriptUpload = Static<typeof TranscriptUploadSchema>;

export const CreateHandoffRequestSchema = Type.Object(
  {
    to: NonEmpty({ description: "The teammate who takes the run over." }),
    note: Type.Optional(Type.String({ maxLength: HANDOFF_NOTE_MAX })),
    branch: Type.Optional(NonEmpty()),
    commit: Type.Optional(Type.String({ pattern: "^[0-9a-f]{7,64}$" })),
    pushed: Type.Optional(Type.Boolean()),
    remote: Type.Optional(HandoffRemoteSchema),
    uncommitted: Type.Optional(Type.Array(Type.String(), { maxItems: HANDOFF_FILES_MAX })),
    turns: Type.Optional(
      Type.Integer({ minimum: 1, maximum: HANDOFF_TURNS_MAX, default: HANDOFF_TURNS_DEFAULT }),
    ),
    transcript: Type.Optional(TranscriptUploadSchema),
  },
  { additionalProperties: false, title: "CreateHandoffRequest" },
);
export type CreateHandoffRequest = Static<typeof CreateHandoffRequestSchema>;

export const HandoffQuerySchema = Type.Object(
  {
    state: Type.Optional(StringEnum(HANDOFF_STATES)),
    run: Type.Optional(NonEmpty({ description: "One run's handoffs." })),
    to: Type.Optional(
      NonEmpty({ description: "Handoffs to this person; me for the person token's own." }),
    ),
  },
  { additionalProperties: false, title: "HandoffQuery" },
);
export type HandoffQuery = Static<typeof HandoffQuerySchema>;

export const HandoffsResponseSchema = Type.Object(
  {
    schema: Type.Literal(HANDOFFS_SCHEMA),
    handoffs: Type.Array(HandoffSchema, { description: "Newest first." }),
  },
  { additionalProperties: false, title: "HandoffsResponse" },
);
export type HandoffsResponse = Static<typeof HandoffsResponseSchema>;

export const TakeoverResponseSchema = Type.Object(
  {
    schema: Type.Literal(TAKEOVER_SCHEMA),
    handoff: HandoffSchema,
    transcript: Type.Union([TranscriptUploadSchema, Type.Null()], {
      description:
        "The transcript, given once: the server deletes its copy as it answers. null when none was sent.",
    }),
  },
  { additionalProperties: false, title: "TakeoverResponse" },
);
export type TakeoverResponse = Static<typeof TakeoverResponseSchema>;

/** A handoff as the run view lists it. */
export const RunHandoffSchema = Type.Object(
  {
    id: Uuidv7(),
    from: NonEmpty(),
    to: NonEmpty(),
    by: NonEmpty(),
    at: DateTime(),
    note: Type.Union([Type.String(), Type.Null()]),
    state: StringEnum(HANDOFF_STATES),
    taken_at: Type.Union([DateTime(), Type.Null()]),
  },
  { additionalProperties: false, title: "RunHandoff" },
);
export type RunHandoff = Static<typeof RunHandoffSchema>;

export const RunShareRequestSchema = Type.Object(
  {
    comment: Type.Optional(
      Type.Boolean({
        default: true,
        description: "Post or update the run link on the run's pull requests through the App.",
      }),
    ),
  },
  { additionalProperties: false, title: "RunShareRequest" },
);
export type RunShareRequest = Static<typeof RunShareRequestSchema>;

export const RunShareResponseSchema = Type.Object(
  {
    schema: Type.Literal(RUN_SHARE_SCHEMA),
    run_id: NonEmpty(),
    url: Url({ description: "The run's stable link in the console." }),
    comments: Type.Array(
      Type.Object(
        {
          pr: Url(),
          url: Type.Union([Url(), Type.Null()], { description: "The comment, once posted." }),
          action: StringEnum(["created", "updated", "unchanged", "failed"] as const),
          error: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      { description: "One per pull request the run links to." },
    ),
    skipped: Type.Union([Type.String(), Type.Null()], {
      description: "Why nothing was posted on GitHub, when nothing was.",
    }),
  },
  { additionalProperties: false, title: "RunShareResponse" },
);
export type RunShareResponse = Static<typeof RunShareResponseSchema>;

/**
 * The person who holds a run: the new owner of its newest handoff, else the person it worked
 * for. Events in any order.
 */
export function currentOwner(
  events: readonly Pick<LedgerEvent, "kind" | "data" | "ts" | "id">[],
  person: string | null,
): string | null {
  let newest: { ts: string; id: string; owner: string } | undefined;
  for (const event of events) {
    const data = handoffOf(event);
    if (!data) continue;
    const later =
      !newest ||
      Date.parse(event.ts) > Date.parse(newest.ts) ||
      (event.ts === newest.ts && event.id > newest.id);
    if (later) newest = { ts: event.ts, id: event.id, owner: data.owner };
  }
  return newest?.owner ?? person;
}

function maskValue(
  value: unknown,
  patterns: readonly RedactionPattern[],
  found: { masked: boolean },
): unknown {
  if (typeof value === "string") {
    const result = maskSecrets(value, patterns);
    if (result.masked) found.masked = true;
    return result.text;
  }
  if (Array.isArray(value)) return value.map((item) => maskValue(item, patterns, found));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, maskValue(item, patterns, found)]),
    );
  }
  return value;
}

/**
 * A JSONL transcript with every string masked: secret-shaped values, emails and the team's
 * [[redaction]] patterns. Each line stays one JSON value (a line that is not JSON is masked as
 * text), so the agent can still read it back; a line with nothing to mask is kept byte for byte.
 * Masking a masked transcript changes nothing.
 */
export function redactTranscript(
  text: string,
  patterns: readonly RedactionPattern[] = [],
): { text: string; masked: boolean } {
  let masked = false;
  const lines = text.split("\n").map((line) => {
    if (line.trim() === "") return line;
    const found = { masked: false };
    let out: string;
    try {
      out = JSON.stringify(maskValue(JSON.parse(line), patterns, found));
    } catch {
      const result = maskSecrets(line, patterns);
      found.masked = result.masked;
      out = result.text;
    }
    if (!found.masked) return line;
    masked = true;
    return out;
  });
  return { text: lines.join("\n"), masked };
}

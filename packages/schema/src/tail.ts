import { type Static, Type } from "@sinclair/typebox";
import { DateTime, RepoSlug, StringEnum } from "./common.js";
import { AGENT_VENDORS, EVENT_KINDS, LedgerEventSchema } from "./event.js";

/**
 * GET /v1/events/tail: the ledger's events in the order they reached it, for `selfhost tail`.
 * A long poll: the caller passes the cursor of the last answer and the server answers once
 * there is something new, or after `wait` seconds with nothing.
 */

export const TAIL_SCHEMA = "selfhost.tail/v1";

export const TAIL_LIMIT_DEFAULT = 200;
export const TAIL_LIMIT_MAX = 1000;
export const TAIL_WAIT_MAX_SECONDS = 30;
/**
 * Without since, the tail reads events that happened in this window: one that lands later
 * than that (a laptop that was offline for days) is in the ledger but not in the tail.
 */
export const TAIL_WINDOW_HOURS = 24;

/** The first part of an event kind (tool for tool.called), which --kind also takes. */
export const TAIL_KIND_GROUPS = [...new Set(EVENT_KINDS.map((kind) => kind.split(".")[0]))] as [
  string,
  ...string[],
];

const KIND_LIST = `(?:${[...EVENT_KINDS, ...TAIL_KIND_GROUPS].map((k) => k.replace(".", "\\.")).join("|")})`;

export const TailQuerySchema = Type.Object(
  {
    after: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description:
          "cursor of the previous answer: only events that reached the ledger after those. Without it the answer has no events and the cursor of now, unless since is given.",
      }),
    ),
    since: Type.Optional(
      DateTime({
        description: `Events that happened at or after this time. Without after, the first answer starts with them. Default: ${TAIL_WINDOW_HOURS} hours before now.`,
      }),
    ),
    kind: Type.Optional(
      Type.String({
        pattern: `^${KIND_LIST}(?:,${KIND_LIST})*$`,
        description:
          "Comma-separated event kinds, or their first part (tool for tool.called and tool.result).",
      }),
    ),
    person: Type.Optional(Type.String({ minLength: 1, description: "actor.id of a person." })),
    agent: Type.Optional(StringEnum(AGENT_VENDORS, { description: "agent.vendor." })),
    repo: Type.Optional(
      RepoSlug({ description: "owner/name: the event's repo, else its run's repo." }),
    ),
    session: Type.Optional(Type.String({ minLength: 1, description: "session_id." })),
    run: Type.Optional(
      Type.String({ minLength: 1, description: "run_id: one background run's events." }),
    ),
    team: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Only this team's events. A person token reads the teams of its org it is in, all of them by default.",
      }),
    ),
    wait: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: TAIL_WAIT_MAX_SECONDS,
        default: 0,
        description: "Seconds to hold the request open while there is nothing new.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: TAIL_LIMIT_MAX, default: TAIL_LIMIT_DEFAULT }),
    ),
  },
  { additionalProperties: false, title: "TailQuery" },
);

export const TailResponseSchema = Type.Object(
  {
    schema: Type.Literal(TAIL_SCHEMA),
    events: Type.Array(LedgerEventSchema, {
      description:
        "Oldest to reach the ledger first, at most limit. Redacted under each team's current [ledger] and [[redaction]] settings, as the run view shows them.",
    }),
    cursor: Type.String({ description: "Pass as after to get what lands next." }),
  },
  { additionalProperties: false, title: "TailResponse" },
);

export type TailQuery = Static<typeof TailQuerySchema>;
export type TailResponse = Static<typeof TailResponseSchema>;

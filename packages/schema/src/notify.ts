import { type Static, Type } from "@sinclair/typebox";
import { DateTime, NonEmpty, StringEnum } from "./common.js";

/**
 * Notifications: where each person's alerts and digests go, as Apprise URLs
 * (github.com/caronc/apprise), and how often their digest comes. selfhost decides what to send
 * and when; Apprise delivers it to Telegram, Slack, email, Teams, Discord, ntfy and the rest.
 * Apprise URLs carry secrets (bot tokens, webhook paths, passwords), so they are stored on the
 * server only and every answer shows them masked.
 */

/** How often a person's digest comes. off sends none; instant pushes still come. */
export const NOTIFY_CADENCES = ["daily", "weekly", "off"] as const;
export type NotifyCadence = (typeof NOTIFY_CADENCES)[number];

/**
 * What a send was: item (an agent waits on a review item), spend (a budget alert at 50, 80 or
 * 100%), digest (a person's review items), spend_digest (the budget owner's daily spend digest)
 * or test.
 */
export const NOTIFY_KINDS = ["item", "spend", "digest", "spend_digest", "test"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** How the server delivers: through the Apprise API, the apprise command, or not at all. */
export const NOTIFY_DELIVERIES = ["apprise_api", "apprise_cli", "none"] as const;
export type NotifyDelivery = (typeof NOTIFY_DELIVERIES)[number];

/** A target name: letters, digits, dots, dashes and underscores. */
export const NOTIFY_TARGET_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$";

export const NotifyTargetSchema = Type.Object(
  {
    name: NonEmpty({ description: "The person's name for the target, such as phone or email." }),
    service: NonEmpty({
      description: "The Apprise URL's scheme, such as tgram, slack, mailto, msteams or ntfys.",
    }),
    masked: NonEmpty({
      description:
        "The URL with everything after the scheme hidden. The URL itself is never returned.",
    }),
    created_at: DateTime(),
  },
  { additionalProperties: false, title: "NotifyTarget" },
);

export const NotifySettingsSchema = Type.Object(
  {
    person: NonEmpty({ description: "Whose settings these are." }),
    targets: Type.Array(NotifyTargetSchema),
    digest: StringEnum(NOTIFY_CADENCES, {
      description: "The digest cadence in use: the person's own, else [notify] digest.",
    }),
    digest_set: Type.Boolean({
      description: "true when the person picked the cadence; false when it is the team default.",
    }),
    delivery: StringEnum(NOTIFY_DELIVERIES, {
      description:
        "apprise_api when the server has SELFHOST_APPRISE_URL, apprise_cli on a laptop with the apprise command, none when nothing can deliver yet.",
    }),
  },
  { additionalProperties: false, title: "NotifySettings" },
);

export const AddNotifyTargetRequestSchema = Type.Object(
  {
    url: NonEmpty({
      maxLength: 2048,
      description:
        "An Apprise URL, such as tgram://<bot token>/<chat id>, mailtos://..., slack://... or ntfys://<topic>. Stored on the server only.",
    }),
    name: Type.Optional(
      Type.String({
        pattern: NOTIFY_TARGET_NAME_PATTERN,
        description: "Default: the URL's service, such as tgram, numbered when it is taken.",
      }),
    ),
  },
  { additionalProperties: false, title: "AddNotifyTargetRequest" },
);

export const SetNotifyDigestRequestSchema = Type.Object(
  {
    digest: StringEnum(NOTIFY_CADENCES, { description: "daily, weekly or off." }),
  },
  { additionalProperties: false, title: "SetNotifyDigestRequest" },
);

export const NotifyTestRequestSchema = Type.Object(
  {
    name: Type.Optional(
      Type.String({
        pattern: NOTIFY_TARGET_NAME_PATTERN,
        description: "Only this target. Default: every target of the person.",
      }),
    ),
  },
  { additionalProperties: false, title: "NotifyTestRequest" },
);

export const NotifySendSchema = Type.Object(
  {
    at: DateTime(),
    target: NonEmpty({ description: "The target's name. Never its URL." }),
    kind: StringEnum(NOTIFY_KINDS),
    subject: Type.Optional(
      Type.String({
        description:
          "The review item id, the alert event id or the digest window it was about; advisor:<window start> for the weekly advisor note, which is sent as a digest.",
      }),
    ),
    ok: Type.Boolean(),
    error: Type.Optional(Type.String({ description: "Why it failed, with any URL masked." })),
  },
  { additionalProperties: false, title: "NotifySend" },
);

export const NotifyTestResponseSchema = Type.Object(
  {
    sends: Type.Array(NotifySendSchema, { description: "One per target tried." }),
  },
  { additionalProperties: false, title: "NotifyTestResponse" },
);

export const NotifySendsResponseSchema = Type.Object(
  {
    sends: Type.Array(NotifySendSchema, { description: "The person's sends, newest first." }),
  },
  { additionalProperties: false, title: "NotifySendsResponse" },
);

export type NotifyTarget = Static<typeof NotifyTargetSchema>;
export type NotifySettings = Static<typeof NotifySettingsSchema>;
export type AddNotifyTargetRequest = Static<typeof AddNotifyTargetRequestSchema>;
export type SetNotifyDigestRequest = Static<typeof SetNotifyDigestRequestSchema>;
export type NotifyTestRequest = Static<typeof NotifyTestRequestSchema>;
export type NotifySend = Static<typeof NotifySendSchema>;
export type NotifyTestResponse = Static<typeof NotifyTestResponseSchema>;
export type NotifySendsResponse = Static<typeof NotifySendsResponseSchema>;

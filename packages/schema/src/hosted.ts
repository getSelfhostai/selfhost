import { type Static, Type } from "@sinclair/typebox";
import { NonEmpty, StringEnum } from "./common.js";

/**
 * The hosted team server (SELFHOST_MODE=hosted): the same server and image as a self-hosted
 * install, with sign-in through GitHub or Google, an org per signup and a seat limit. These are
 * the bodies of /v1/hosted and /v1/hosted/exchange.
 */

/** Where people can sign in on a hosted server. */
export const HOSTED_PROVIDERS = ["github", "google"] as const;
export type HostedProvider = (typeof HOSTED_PROVIDERS)[number];

/** The query string `selfhost init --hosted` opens the sign-in page with. */
export const HOSTED_CLI_PARAMS = {
  port: "cli_port",
  state: "cli_state",
  challenge: "cli_challenge",
} as const;

export const HostedInfoSchema = Type.Object(
  {
    schema: Type.Literal("selfhost.hosted/v1"),
    providers: Type.Array(StringEnum(HOSTED_PROVIDERS), {
      description: "Where people can sign in, in the order the sign-in page offers them.",
    }),
    free_seats: Type.Integer({
      minimum: 1,
      description:
        "People an org can have on the free plan, with every feature and no agent limit (SELFHOST_HOSTED_FREE_SEATS).",
    }),
    retention_days: Type.Integer({
      minimum: 1,
      description: "Days events are kept at most (SELFHOST_HOSTED_RETENTION_DAYS).",
    }),
    max_events: Type.Integer({
      minimum: 1,
      description: "Events an org can keep at once (SELFHOST_HOSTED_MAX_EVENTS).",
    }),
    paid_plan: Type.Object(
      {
        notice: NonEmpty({ description: "What an org that needs more seats is told." }),
        url: Type.Union([Type.String({ format: "uri" }), Type.Null()], {
          description: "Where to read about the paid plan, null when there is no page yet.",
        }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, title: "HostedInfo" },
);

export const HostedExchangeRequestSchema = Type.Object(
  {
    code: NonEmpty({
      maxLength: 4096,
      description: "The code the sign-in page sent to the CLI's loopback address.",
    }),
    verifier: NonEmpty({
      minLength: 43,
      maxLength: 128,
      description:
        "The secret whose sha256 (base64url) the CLI sent as cli_challenge when it opened the sign-in page.",
    }),
  },
  { additionalProperties: false, title: "HostedExchangeRequest" },
);

export type HostedInfo = Static<typeof HostedInfoSchema>;
export type HostedExchangeRequest = Static<typeof HostedExchangeRequestSchema>;

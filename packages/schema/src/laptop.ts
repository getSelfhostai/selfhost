import { type Static, Type } from "@sinclair/typebox";
import { DateTime, NonEmpty, StringEnum } from "./common.js";
import { createValidator } from "./validate.js";

/**
 * Laptop coverage: which laptops of a team run which config version. Each laptop that joined a
 * team reports a heartbeat on join and on every sync, as a config.reported ledger event whose
 * data.heartbeat is a LaptopHeartbeat. GET /v1/teams/{team}/laptops reads the newest heartbeat
 * of each laptop and flags the ones that are behind, silent or missing their managed files.
 */

export const LAPTOP_HEARTBEAT_SCHEMA = "selfhost.laptop_heartbeat/v1";

/** The ledger event kind a heartbeat travels in. */
export const HEARTBEAT_EVENT_KIND = "config.reported";

/** Days without a heartbeat before a laptop counts as silent, unless the query says otherwise. */
export const LAPTOP_SILENT_DEFAULT_DAYS = 7;

export const LAPTOP_PLATFORMS = ["darwin", "linux", "win32", "other"] as const;

/**
 * Where the managed settings files stand on a laptop. current: every file for its platform
 * matches what the pulled team policy compiles to. pending: some are missing or differ, because
 * installing them needs an admin or a file there was not written by selfhost. off: the person
 * turned the install off with --no-managed. none: no team policy pulled, so nothing to install.
 */
export const MANAGED_STATES = ["current", "pending", "off", "none"] as const;

export const LAPTOP_FLAGS = ["silent", "behind", "not_installed"] as const;

const Sha256 = (description: string) => Type.String({ pattern: "^[0-9a-f]{64}$", description });

export const LaptopManagedSchema = Type.Object(
  {
    state: StringEnum(MANAGED_STATES, { description: "Where the managed files stand." }),
    files: Type.Integer({
      minimum: 0,
      description: "Managed files the team policy compiles to on this platform.",
    }),
    pending: Type.Integer({
      minimum: 0,
      description: "Of those, the ones missing or different on this laptop.",
    }),
  },
  { additionalProperties: false, title: "LaptopManaged" },
);

export const LaptopHeartbeatSchema = Type.Object(
  {
    schema: Type.Literal(LAPTOP_HEARTBEAT_SCHEMA, { description: "Schema version tag." }),
    machine: Type.String({
      pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
      description:
        "Random id selfhost made for this laptop the first time it joined a team. Not derived from the hardware.",
    }),
    hostname: Type.Optional(Type.String({ maxLength: 255, description: "The laptop's name." })),
    platform: StringEnum(LAPTOP_PLATFORMS, { description: "Operating system." }),
    selfhost_version: NonEmpty({ maxLength: 64, description: "Version of the selfhost CLI." }),
    policy_hash: Type.Union([Sha256("sha256 of the team's selfhost.toml"), Type.Null()], {
      description:
        "The config version: sha256 of the team policy pulled on the last sync, null when none was pulled.",
    }),
    managed: LaptopManagedSchema,
  },
  { additionalProperties: false, title: "LaptopHeartbeat" },
);

export const heartbeatValidator = createValidator(LaptopHeartbeatSchema);

export const LaptopsQuerySchema = Type.Object(
  {
    silent_days: Type.Optional(
      Type.String({
        pattern: "^[1-9][0-9]{0,2}$",
        description: `Days without a heartbeat before a laptop is flagged silent, 1 to 999. Default: ${LAPTOP_SILENT_DEFAULT_DAYS}.`,
      }),
    ),
  },
  { additionalProperties: false, title: "LaptopsQuery" },
);

export const LaptopRowSchema = Type.Object(
  {
    machine: Type.String({ description: "The laptop's id from its heartbeats." }),
    person: Type.String({ description: "Who the laptop belongs to: the person who sent it." }),
    hostname: Type.Union([Type.String(), Type.Null()]),
    platform: StringEnum(LAPTOP_PLATFORMS),
    selfhost_version: Type.String(),
    policy_hash: Type.Union([Type.String(), Type.Null()], {
      description: "The config version the laptop reported last.",
    }),
    managed: LaptopManagedSchema,
    last_heartbeat: DateTime({ description: "When the laptop last reported." }),
    flags: Type.Array(StringEnum(LAPTOP_FLAGS), {
      description:
        "silent: no heartbeat in silent_days. behind: its config version is not the team's. not_installed: its managed files are pending or turned off.",
    }),
    status: StringEnum(["current", ...LAPTOP_FLAGS] as const, {
      description: "The first flag, or current when there is none.",
    }),
  },
  { additionalProperties: false, title: "LaptopRow" },
);

export const TeamLaptopsResponseSchema = Type.Object(
  {
    team: Type.String({ description: "Team id." }),
    policy_hash: Type.Union([Type.String(), Type.Null()], {
      description: "The team's config version now, null when the team has no policy.",
    }),
    silent_days: Type.Integer({ minimum: 1 }),
    laptops: Type.Array(LaptopRowSchema, {
      description: "Every laptop that sent a heartbeat for the team, flagged ones first.",
    }),
    people_without_heartbeat: Type.Array(Type.String(), {
      description: "People in the team with no heartbeat from any laptop.",
    }),
  },
  { additionalProperties: false, title: "TeamLaptopsResponse" },
);

export type LaptopHeartbeat = Static<typeof LaptopHeartbeatSchema>;
export type LaptopManaged = Static<typeof LaptopManagedSchema>;
export type ManagedState = (typeof MANAGED_STATES)[number];
export type LaptopPlatform = (typeof LAPTOP_PLATFORMS)[number];
export type LaptopFlag = (typeof LAPTOP_FLAGS)[number];
export type LaptopsQuery = Static<typeof LaptopsQuerySchema>;
export type LaptopRow = Static<typeof LaptopRowSchema>;
export type TeamLaptopsResponse = Static<typeof TeamLaptopsResponseSchema>;

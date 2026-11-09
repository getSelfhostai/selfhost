import { type Static, Type } from "@sinclair/typebox";
import { DateTime, NonEmpty, StringEnum } from "./common.js";
import { RUNTIME_TOOLS } from "./integration-tools.js";
import { createValidator } from "./validate.js";

/**
 * Sandbox lifecycle in the ledger. A background run's sandbox writes a sandbox.started event when
 * it is created and a sandbox.stopped event when it is stopped, each with data.sandbox a
 * SandboxRecord. sandbox.stopped also carries `cost`: no tokens, usd the sandbox's cost, estimated
 * when it came from the runtime's list price. Idle waste (F94) and runtime caps (F73) read these.
 */

export const SANDBOX_RECORD_SCHEMA = "selfhost.sandbox/v1";

/** The ledger event kinds a SandboxRecord travels in. */
export const SANDBOX_EVENT_KINDS = ["sandbox.started", "sandbox.stopped"] as const;
export type SandboxEventKind = (typeof SANDBOX_EVENT_KINDS)[number];

/**
 * How a provider bills a sandbox. reserved: for the CPU and memory it holds while it runs, busy
 * or not (E2B, Daytona, Modal, a Coder workspace, the team's own server). active_cpu: only for
 * CPU time used.
 */
export const SANDBOX_BILLING = ["reserved", "active_cpu"] as const;
export type SandboxBilling = (typeof SANDBOX_BILLING)[number];

/**
 * Why a sandbox stopped. run_ended: its run finished. cap: a [budget] runtime cap was reached.
 * reaped: selfhost runtime reap found it left running. timeout: its own timeout. error: it
 * failed. manual: a person stopped it.
 */
export const SANDBOX_STOP_REASONS = [
  "run_ended",
  "cap",
  "reaped",
  "timeout",
  "error",
  "manual",
] as const;
export type SandboxStopReason = (typeof SANDBOX_STOP_REASONS)[number];

const Seconds = (description: string) => Type.Number({ minimum: 0, description });
const Usd = (description: string) => Type.Number({ minimum: 0, description });

export const SandboxSizeSchema = Type.Object(
  {
    cpu: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "vCPUs." })),
    memory_gib: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Memory in GiB." })),
  },
  { additionalProperties: false, title: "SandboxSize" },
);

export const SandboxRecordSchema = Type.Object(
  {
    schema: Type.Literal(SANDBOX_RECORD_SCHEMA, { description: "Schema version tag." }),
    runtime: StringEnum(RUNTIME_TOOLS, { description: "Where the sandbox runs." }),
    sandbox_id: NonEmpty({ description: "The provider's id for the sandbox." }),
    size: Type.Optional(SandboxSizeSchema),
    region: Type.Optional(Type.String({ description: "Region the sandbox runs in." })),
    usd_per_hour: Type.Optional(
      Usd(
        "List price of the sandbox per running hour. Absent when the runtime has none, such as the team's own server without [runtime.providers] usd_per_hour.",
      ),
    ),
    billing: Type.Optional(StringEnum(SANDBOX_BILLING, { description: "How the provider bills." })),
    reason: Type.Optional(
      StringEnum(SANDBOX_STOP_REASONS, { description: "sandbox.stopped: why it stopped." }),
    ),
    cap: Type.Optional(
      Type.String({
        description:
          "sandbox.stopped with reason cap: the [budget] key that was reached, runtime_daily_usd or runtime_run_usd.",
      }),
    ),
    billed_seconds: Type.Optional(
      Seconds("sandbox.stopped: seconds billed, as the provider counts them."),
    ),
    busy_seconds: Type.Optional(
      Seconds("sandbox.stopped: billed seconds during which a command was running in the sandbox."),
    ),
    idle_seconds: Type.Optional(
      Seconds(
        "sandbox.stopped: billed seconds with no command running, billed_seconds - busy_seconds.",
      ),
    ),
    run_ended_at: Type.Optional(
      DateTime({ description: "When the sandbox's run ended, if it had." }),
    ),
    after_run_seconds: Type.Optional(
      Seconds("sandbox.stopped: seconds the sandbox kept running after its run ended."),
    ),
  },
  { additionalProperties: false, title: "SandboxRecord" },
);

export const sandboxRecordValidator = createValidator(SandboxRecordSchema);

/** Idle share above which a runtime that bills reserved time gets a cheaper billing suggestion. */
export const IDLE_SHARE_SUGGESTION = 0.5;

/** Windows of the waste report, in days back from now. */
export const SANDBOX_WASTE_WINDOWS = [7, 30] as const;

export const SandboxWasteQuerySchema = Type.Object(
  {
    leftover_minutes: Type.Optional(
      Type.String({
        pattern: "^[1-9][0-9]{0,4}$",
        description:
          "Minutes a sandbox may outlive its run before it is listed as left running. Default: [runtime] leftover_minutes, else 15.",
      }),
    ),
  },
  { additionalProperties: false, title: "SandboxWasteQuery" },
);

export const SandboxSuggestionSchema = Type.Object(
  {
    text: NonEmpty({ description: "The cheaper billing model, in one or two sentences." }),
    monthly_saving_usd: Usd("Estimated saving a month: idle cost in the window scaled to 30 days."),
  },
  { additionalProperties: false, title: "SandboxSuggestion" },
);

export const SandboxRuntimeWasteSchema = Type.Object(
  {
    runtime: Type.String({ description: "The runtime." }),
    billing: StringEnum(SANDBOX_BILLING),
    sandboxes: Type.Integer({ minimum: 0 }),
    billed_seconds: Seconds("Billed sandbox seconds in the window."),
    idle_seconds: Seconds("Of those, the seconds with no command running."),
    billed_usd: Usd("Sandbox cost in the window."),
    idle_usd: Usd("Share of billed_usd paid while idle."),
    idle_share: Type.Number({ minimum: 0, maximum: 1, description: "idle_usd / billed_usd." }),
    suggestion: Type.Union([SandboxSuggestionSchema, Type.Null()], {
      description: `A cheaper billing model when idle_share is above ${IDLE_SHARE_SUGGESTION} on a runtime that bills reserved time; null otherwise.`,
    }),
  },
  { additionalProperties: false, title: "SandboxRuntimeWaste" },
);

export const SandboxWasteWindowSchema = Type.Object(
  {
    days: Type.Integer({ minimum: 1 }),
    billed_usd: Usd("Sandbox cost in the window, every runtime."),
    idle_usd: Usd("Of it, paid while idle."),
    idle_share: Type.Number({ minimum: 0, maximum: 1 }),
    by_runtime: Type.Array(SandboxRuntimeWasteSchema, { description: "Highest cost first." }),
  },
  { additionalProperties: false, title: "SandboxWasteWindow" },
);

export const SandboxLeftoverSchema = Type.Object(
  {
    sandbox_id: Type.String(),
    runtime: Type.String(),
    run_id: Type.Union([Type.String(), Type.Null()]),
    owner: Type.Union([Type.String(), Type.Null()], {
      description: "The person who started the run, when the ledger says.",
    }),
    started_at: DateTime(),
    run_ended_at: DateTime({ description: "When its run finished, failed or got stuck." }),
    stopped_at: Type.Union([DateTime(), Type.Null()], {
      description: "When it stopped at last; null while it is still running.",
    }),
    minutes_after_run: Type.Number({ minimum: 0 }),
    cost_usd: Usd("Cost so far, or in total once stopped, at list price."),
    after_run_usd: Usd("The part of cost_usd billed after the run ended."),
  },
  { additionalProperties: false, title: "SandboxLeftover" },
);

export const SandboxRunWasteSchema = Type.Object(
  {
    run_id: Type.String(),
    runtime: Type.String(),
    billed_seconds: Seconds("Billed sandbox seconds."),
    busy_seconds: Seconds("Seconds with a command running."),
    idle_seconds: Seconds("Billed seconds with no command running."),
    sandbox_usd: Usd("The run's sandbox cost."),
    model_usd: Usd("The run's model cost, from its cost.recorded events."),
  },
  { additionalProperties: false, title: "SandboxRunWaste" },
);

export const SandboxWasteResponseSchema = Type.Object(
  {
    team: Type.Union([Type.String(), Type.Null()]),
    generated_at: DateTime(),
    leftover_minutes: Type.Integer({ minimum: 1 }),
    windows: Type.Array(SandboxWasteWindowSchema, { description: "The last 7 and 30 days." }),
    leftovers: Type.Array(SandboxLeftoverSchema, {
      description:
        "Sandboxes that ran longer than leftover_minutes after their run ended, in the last 30 days, running ones first.",
    }),
    runs: Type.Array(SandboxRunWasteSchema, {
      description: "Each run of the last 7 days with a sandbox, highest sandbox cost first.",
    }),
  },
  { additionalProperties: false, title: "SandboxWasteResponse" },
);

export type SandboxRecord = Static<typeof SandboxRecordSchema>;
export type SandboxSize = Static<typeof SandboxSizeSchema>;
export type SandboxWasteQuery = Static<typeof SandboxWasteQuerySchema>;
export type SandboxSuggestion = Static<typeof SandboxSuggestionSchema>;
export type SandboxRuntimeWaste = Static<typeof SandboxRuntimeWasteSchema>;
export type SandboxWasteWindow = Static<typeof SandboxWasteWindowSchema>;
export type SandboxLeftover = Static<typeof SandboxLeftoverSchema>;
export type SandboxRunWaste = Static<typeof SandboxRunWasteSchema>;
export type SandboxWasteResponse = Static<typeof SandboxWasteResponseSchema>;

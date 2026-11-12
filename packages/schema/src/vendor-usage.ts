import { type Static, Type } from "@sinclair/typebox";
import { DateTime, StringEnum } from "./common.js";
import { AGENT_VENDORS } from "./event.js";

/**
 * Vendor usage imports and the seat versus API key break-even: the bodies of
 * GET /v1/vendor-imports and GET /v1/usage/break-even.
 */

/** The vendor admin APIs the server imports usage from. */
export const VENDOR_IMPORTERS = ["anthropic", "openai", "cursor"] as const;
export type VendorImporterName = (typeof VENDOR_IMPORTERS)[number];

export const VENDOR_IMPORT_STATES = ["ok", "not_available", "error", "pending"] as const;
export type VendorImportState = (typeof VENDOR_IMPORT_STATES)[number];

const Usd = (description: string) => Type.Number({ minimum: 0, description });
const Day = (description: string) =>
  Type.Union([Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), Type.Null()], { description });

export const VendorImportStatusSchema = Type.Object(
  {
    importer: StringEnum(VENDOR_IMPORTERS),
    state: StringEnum(VENDOR_IMPORT_STATES, {
      description:
        "ok: the last read worked. not_available: the key may not read the vendor's admin API (401, 403 or 404), so nothing is imported and nothing fails. error: the last read failed and is tried again at the next run. pending: no run yet.",
    }),
    detail: Type.Union([Type.String(), Type.Null()], {
      description: "What went wrong, or what was left out. Never holds a key.",
    }),
    through_day: Day("Last UTC day imported, YYYY-MM-DD; the next run starts the day after."),
    last_run_at: Type.Union([DateTime(), Type.Null()]),
    events: Type.Integer({ minimum: 0, description: "Events the last run wrote." }),
    notes: Type.Array(Type.String(), {
      description: "What the importer covers and what it cannot see.",
    }),
  },
  { additionalProperties: false, title: "VendorImportStatus" },
);

export const VendorImportsResponseSchema = Type.Object(
  {
    importers: Type.Array(VendorImportStatusSchema, {
      description: "One per importer with a key set on the server.",
    }),
  },
  { additionalProperties: false, title: "VendorImportsResponse" },
);

export const BREAK_EVEN_SCHEMA = "selfhost.break_even/v1";

export const BREAK_EVEN_VERDICTS = ["seat", "api"] as const;

export const BreakEvenRowSchema = Type.Object(
  {
    person: Type.String(),
    agent: StringEnum(AGENT_VENDORS),
    api_usd: Usd("Spend in the range, priced at API rates, as the ledger counts it."),
    monthly_api_usd: Usd("api_usd scaled to 30 days."),
    verdict: StringEnum(BREAK_EVEN_VERDICTS, {
      description:
        "seat: a subscription seat costs less than paying for the same use with an API key. api: an API key costs less.",
    }),
    tier: Type.Union([Type.String(), Type.Null()], {
      description: "The cheapest seat tier for this use, such as max_5x; null with verdict api.",
    }),
    seat_usd: Type.Union([Usd("That tier's price a month."), Type.Null()]),
    monthly_cost_usd: Usd(
      "What the verdict costs a month: the seat, plus API spend past its limits, or the API spend.",
    ),
    saving_usd: Usd("A month, against the other choice."),
    break_even_usd: Usd(
      "Monthly API spend at which the cheapest seat starts to pay for itself: its price.",
    ),
    over_limit: Type.Boolean({
      description:
        "The use is past the chosen tier's approximate monthly limit, so the rest goes to an API key.",
    }),
  },
  { additionalProperties: false, title: "BreakEvenRow" },
);

export const BreakEvenResponseSchema = Type.Object(
  {
    schema: Type.Literal(BREAK_EVEN_SCHEMA),
    org: Type.String(),
    from: DateTime(),
    to: DateTime(),
    days: Type.Number({ exclusiveMinimum: 0 }),
    prices_as_of: Type.String({ description: "Day the seat prices were checked, YYYY-MM-DD." }),
    rows: Type.Array(BreakEvenRowSchema, {
      description:
        "One per person and agent with a seat plan to compare (Claude Code and Codex), heaviest use first.",
    }),
    notes: Type.Array(Type.String()),
  },
  {
    additionalProperties: false,
    title: "BreakEvenResponse",
    description:
      "For each developer, the range's usage priced at API rates against the seat tiers of the agent's plan, with a verdict.",
  },
);

export type VendorImportStatus = Static<typeof VendorImportStatusSchema>;
export type VendorImportsResponse = Static<typeof VendorImportsResponseSchema>;
export type BreakEvenRow = Static<typeof BreakEvenRowSchema>;
export type BreakEvenResponse = Static<typeof BreakEvenResponseSchema>;

import type { LedgerEvent } from "@selfhost/schema";
import { type AdminImporter, type PersonMatch, rollupEvent } from "./common.js";

export { ANTHROPIC_NOTES, anthropicImporter } from "./anthropic.js";
export {
  ADMIN_IMPORTERS,
  type AdminImporter,
  type AdminImporterId,
  daysBetween,
  type PersonMatch,
  rollupEvent,
  VENDOR_ROLLUP_DAY,
  VendorApiError,
  type VendorDayRead,
  type VendorDayUsage,
  VendorNotAvailableError,
} from "./common.js";
export { CURSOR_NOTES, cursorImporter } from "./cursor.js";
export { OPENAI_NOTES, openAiImporter, openAiUsd } from "./openai.js";

export interface VendorEvents {
  events: LedgerEvent[];
  /** Vendor emails with usage, and how many of them matched no person on the server. */
  people: number;
  unmatched: number;
  skipped: Record<string, number>;
}

/**
 * Reads `from` through `through` (UTC days, both included) from one vendor and maps each
 * person's daily usage of a model to a cost.recorded event. `person` maps a vendor email to a
 * person on the server; an email it does not know is kept as the person id, lowercased.
 */
export async function readVendorEvents(
  importer: AdminImporter,
  from: string,
  through: string,
  person: (email: string) => PersonMatch | undefined,
): Promise<VendorEvents> {
  const { usage, skipped } = await importer.read(from, through);
  const emails = new Map<string, PersonMatch | undefined>();
  for (const row of usage) if (!emails.has(row.email)) emails.set(row.email, person(row.email));
  const events = usage
    .filter((row) => row.usd > 0 || row.input_tokens + row.output_tokens > 0 || row.extra)
    .map((row) => rollupEvent(importer.id, row, emails.get(row.email) ?? { id: row.email }));
  const unmatched = [...emails.values()].filter((match) => match === undefined).length;
  return { events, people: emails.size, unmatched, skipped };
}

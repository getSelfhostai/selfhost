import {
  type AdminImporter,
  amount,
  count,
  DAY_MS,
  dayOf,
  isObject,
  mergeUsage,
  text,
  type VendorDayUsage,
  vendorJson,
} from "./common.js";

/**
 * Cursor usage per person and day from the Cursor Admin API (a team admin key, HTTP Basic with
 * the key as user name): POST /teams/filtered-usage-events
 * (https://cursor.com/docs/account/teams/admin-api). Each usage event carries the person's
 * email, the model, its tokens and tokenUsage.totalCents, what the request costs at API rates;
 * chargedCents is what Cursor billed on top of the plan. usd is the API-rate cost, so a seat can
 * be compared with what the same use would cost on API keys; data.charged_usd keeps the bill.
 */

export const CURSOR_API_URL = "https://api.cursor.com";

export const CURSOR_NOTES = [
  "Needs a Cursor team admin key; the Admin API is for team plans, and a key without access shows as not available.",
  "Cursor sends model traffic from its own servers, so this is the only place its usage per person comes from.",
];

const PAGE_SIZE = 1000;

export interface CursorImporterOptions {
  /** A team Admin API key. Goes only in the Authorization header. */
  adminKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export function cursorImporter(options: CursorImporterOptions): AdminImporter {
  const send = options.fetch ?? fetch;
  const base = (options.baseUrl ?? CURSOR_API_URL).replace(/\/+$/, "");
  const headers = {
    authorization: `Basic ${Buffer.from(`${options.adminKey}:`).toString("base64")}`,
    "content-type": "application/json",
  };

  return {
    id: "cursor",
    notes: CURSOR_NOTES,
    async read(from, through) {
      const skipped: Record<string, number> = {};
      const rows: VendorDayUsage[] = [];
      const startDate = Date.parse(`${from}T00:00:00Z`);
      const endDate = Date.parse(`${through}T00:00:00Z`) + DAY_MS - 1;
      for (let page = 1; ; page++) {
        const body = await vendorJson(send, "Cursor", `${base}/teams/filtered-usage-events`, {
          method: "POST",
          headers,
          body: JSON.stringify({ startDate, endDate, page, pageSize: PAGE_SIZE }),
        });
        const events = isObject(body) && Array.isArray(body.usageEvents) ? body.usageEvents : [];
        for (const event of events) {
          if (!isObject(event)) continue;
          const email = text(event.userEmail)?.toLowerCase();
          const at = Number(event.timestamp);
          if (!email || !Number.isFinite(at)) {
            skipped.no_person = (skipped.no_person ?? 0) + 1;
            continue;
          }
          const day = dayOf(at);
          if (day < from || day > through) continue;
          const usage = isObject(event.tokenUsage) ? event.tokenUsage : undefined;
          const charged = amount(event.chargedCents) / 100;
          rows.push({
            day,
            email,
            agent: "cursor",
            model: text(event.model) ?? "unknown",
            input_tokens: count(usage?.inputTokens),
            output_tokens: count(usage?.outputTokens),
            cache_read_tokens: count(usage?.cacheReadTokens),
            cache_write_tokens: count(usage?.cacheWriteTokens),
            usd: usage ? amount(usage.totalCents) / 100 : charged,
            estimated: false,
            extra: { requests: 1, charged_usd: charged },
          });
        }
        const pagination = isObject(body) && isObject(body.pagination) ? body.pagination : {};
        if (pagination.hasNextPage !== true || events.length === 0) break;
      }
      return { usage: mergeUsage(rows), skipped };
    },
  };
}

import { findPricing } from "../vendor/ccusage/pricing.js";
import {
  type AdminImporter,
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
 * API key usage per person and day from OpenAI's organization usage API (an Admin key):
 * GET /v1/organization/usage/completions, daily buckets grouped by user, model and API key
 * (https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/completions),
 * with each user id's email from GET /v1/organization/users.
 *
 * The usage API reports tokens, not dollars per model, so usd is priced from the bundled price
 * table at the base rate (estimated). Usage is counted as Codex: on a coding agent server that
 * is what an API key mostly runs, and a person-day the Codex logs or the gateway already report
 * is counted from them instead.
 */

export const OPENAI_API_URL = "https://api.openai.com";

export const OPENAI_NOTES = [
  "Covers OpenAI API key usage only. Codex signed in with a ChatGPT plan is not in this API: it comes from each laptop's logs.",
  "Usage is counted as Codex, priced at list price from the bundled price table. A key used by no person (a service account or project key) is skipped.",
  "Keys listed in SELFHOST_OPENAI_SKIP_KEY_IDS (the gateway's own provider keys) are skipped, since the gateway records that traffic itself.",
];

export interface OpenAiImporterOptions {
  /** An Admin key. Goes only in the Authorization header. */
  adminKey: string;
  /** API key ids whose usage is left out, such as the key the gateway calls OpenAI with. */
  skipKeyIds?: readonly string[];
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** USD at the base rates of the bundled table, or undefined for a model it does not know. */
export function openAiUsd(
  model: string,
  tokens: { uncached: number; cached: number; cacheWrite: number; output: number },
): number | undefined {
  const pricing = findPricing(model);
  if (!pricing) return undefined;
  const cacheRead = pricing.cacheReadExplicit ? pricing.cacheRead : pricing.input;
  return (
    tokens.uncached * pricing.input +
    tokens.cached * cacheRead +
    tokens.cacheWrite * (pricing.cacheCreate || pricing.input) +
    tokens.output * pricing.output
  );
}

export function openAiImporter(options: OpenAiImporterOptions): AdminImporter {
  const send = options.fetch ?? fetch;
  const base = (options.baseUrl ?? OPENAI_API_URL).replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${options.adminKey}` };
  const skipKeys = new Set(options.skipKeyIds ?? []);

  async function emails(): Promise<Map<string, string>> {
    const byId = new Map<string, string>();
    let after: string | undefined;
    for (;;) {
      const params = new URLSearchParams({ limit: "100" });
      if (after) params.set("after", after);
      const body = await vendorJson(send, "OpenAI", `${base}/v1/organization/users?${params}`, {
        headers,
      });
      const data = isObject(body) && Array.isArray(body.data) ? body.data : [];
      for (const user of data) {
        if (!isObject(user)) continue;
        const id = text(user.id);
        const email = text(user.email);
        if (id && email) byId.set(id, email.toLowerCase());
      }
      after = isObject(body) && body.has_more === true ? text(body.last_id) : undefined;
      if (!after) return byId;
    }
  }

  return {
    id: "openai",
    notes: OPENAI_NOTES,
    async read(from, through) {
      const skipped: Record<string, number> = {};
      const skip = (why: string) => {
        skipped[why] = (skipped[why] ?? 0) + 1;
      };
      const people = await emails();
      const rows: VendorDayUsage[] = [];
      const start = Date.parse(`${from}T00:00:00Z`) / 1000;
      const end = (Date.parse(`${through}T00:00:00Z`) + DAY_MS) / 1000;
      let page: string | undefined;
      do {
        const params = new URLSearchParams({
          start_time: String(start),
          end_time: String(end),
          bucket_width: "1d",
          limit: "31",
        });
        for (const group of ["user_id", "model", "api_key_id"]) params.append("group_by", group);
        if (page) params.set("page", page);
        const body = await vendorJson(
          send,
          "OpenAI",
          `${base}/v1/organization/usage/completions?${params}`,
          { headers },
        );
        const buckets = isObject(body) && Array.isArray(body.data) ? body.data : [];
        for (const bucket of buckets) {
          if (!isObject(bucket) || typeof bucket.start_time !== "number") continue;
          const day = dayOf(bucket.start_time * 1000);
          for (const result of Array.isArray(bucket.results) ? bucket.results : []) {
            if (!isObject(result)) continue;
            const key = text(result.api_key_id);
            if (key && skipKeys.has(key)) {
              skip("gateway_key");
              continue;
            }
            const user = text(result.user_id);
            const email = user ? people.get(user) : undefined;
            if (!email) {
              skip("no_person");
              continue;
            }
            const model = text(result.model) ?? "unknown";
            const input = count(result.input_tokens);
            const cached = count(result.input_cached_tokens);
            const cacheWrite = count(result.input_cache_write_tokens);
            const uncached =
              result.input_uncached_tokens === undefined
                ? Math.max(0, input - cached - cacheWrite)
                : count(result.input_uncached_tokens);
            const output = count(result.output_tokens);
            const usd = openAiUsd(model, { uncached, cached, cacheWrite, output });
            rows.push({
              day,
              email,
              agent: "codex",
              model,
              input_tokens: uncached,
              output_tokens: output,
              cache_read_tokens: cached,
              cache_write_tokens: cacheWrite,
              usd: usd ?? 0,
              estimated: true,
              extra: {
                requests: count(result.num_model_requests),
                ...(usd === undefined ? { unpriced: true } : {}),
              },
            });
          }
        }
        page =
          isObject(body) && body.has_more === true
            ? text((body as { next_page?: unknown }).next_page)
            : undefined;
      } while (page);
      return { usage: mergeUsage(rows), skipped };
    },
  };
}

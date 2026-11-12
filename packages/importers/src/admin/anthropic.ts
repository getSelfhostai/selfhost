import {
  type AdminImporter,
  amount,
  count,
  daysBetween,
  isObject,
  mergeUsage,
  text,
  type VendorDayUsage,
  vendorJson,
} from "./common.js";

/**
 * Claude Code usage per person and day from Anthropic's Claude Code Analytics API
 * (GET /v1/organizations/usage_report/claude_code, an Admin API key):
 * https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api
 *
 * Each record is one actor's day for one terminal, customer type, subscription type and remote
 * flag, so records of a person are added up. Each model_breakdown entry becomes that person's
 * usage of the model, with estimated_cost.amount (cents) as usd. Sessions, lines, commits and
 * pull requests go on the person's first model of the day, in data.
 *
 * Records of an API key (api_actor) name no person and are left out: API key traffic is what the
 * model gateway already records, request by request.
 */

export const ANTHROPIC_API_URL = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2026-10-21";

export const ANTHROPIC_NOTES = [
  "Covers Claude Code used with a login to your Claude Console organization (API billing). Personal Pro and Max plans, and Team and Enterprise seats signed in through claude.ai, are not in this API: their usage comes from each laptop's logs.",
  "Records of an API key name no person and are skipped; send API key traffic through the gateway to see it per person.",
  "Anthropic's cost is an estimate at list price; days arrive about an hour after they end.",
];

export interface AnthropicImporterOptions {
  /** An Admin API key (sk-ant-admin01-...). Goes only in the x-api-key header. */
  adminKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export function anthropicImporter(options: AnthropicImporterOptions): AdminImporter {
  const send = options.fetch ?? fetch;
  const base = (options.baseUrl ?? ANTHROPIC_API_URL).replace(/\/+$/, "");
  const headers = {
    "x-api-key": options.adminKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "user-agent": "selfhost (https://selfhost.ai)",
  };

  async function readDay(day: string, skipped: Record<string, number>) {
    const rows: VendorDayUsage[] = [];
    const metrics = new Map<string, Record<string, number>>();
    let page: string | undefined;
    do {
      const params = new URLSearchParams({ starting_at: day, limit: "1000" });
      if (page) params.set("page", page);
      const body = await vendorJson(
        send,
        "Anthropic",
        `${base}/v1/organizations/usage_report/claude_code?${params}`,
        { headers },
      );
      const data = isObject(body) && Array.isArray(body.data) ? body.data : [];
      for (const record of data) {
        if (!isObject(record)) continue;
        const actor = isObject(record.actor) ? record.actor : {};
        const email = text(actor.email_address)?.toLowerCase();
        if (actor.type !== "user_actor" || !email) {
          skipped.api_key = (skipped.api_key ?? 0) + 1;
          continue;
        }
        const core = isObject(record.core_metrics) ? record.core_metrics : {};
        const lines = isObject(core.lines_of_code) ? core.lines_of_code : {};
        const sum = metrics.get(email) ?? {};
        const add = (name: string, value: unknown) => {
          sum[name] = (sum[name] ?? 0) + count(value);
        };
        add("sessions", core.num_sessions);
        add("lines_added", lines.added);
        add("lines_removed", lines.removed);
        add("commits", core.commits_by_claude_code);
        add("pull_requests", core.pull_requests_by_claude_code);
        metrics.set(email, sum);
        const models = Array.isArray(record.model_breakdown) ? record.model_breakdown : [];
        for (const entry of models) {
          if (!isObject(entry)) continue;
          const tokens = isObject(entry.tokens) ? entry.tokens : {};
          const cost = isObject(entry.estimated_cost) ? entry.estimated_cost : {};
          rows.push({
            day,
            email,
            agent: "claude_code",
            model: text(entry.model) ?? "unknown",
            input_tokens: count(tokens.input),
            output_tokens: count(tokens.output),
            cache_read_tokens: count(tokens.cache_read),
            cache_write_tokens: count(tokens.cache_creation),
            usd: amount(cost.amount) / 100,
            estimated: true,
          });
        }
      }
      const more = isObject(body) && body.has_more === true;
      page = more ? text((body as Record<string, unknown>).next_page) : undefined;
    } while (page);
    const merged = mergeUsage(rows).sort((a, b) => a.model.localeCompare(b.model));
    const placed = new Set<string>();
    for (const row of merged) {
      if (placed.has(row.email)) continue;
      placed.add(row.email);
      const day = metrics.get(row.email);
      if (day) row.extra = { ...row.extra, ...day };
    }
    return merged;
  }

  return {
    id: "anthropic",
    notes: ANTHROPIC_NOTES,
    async read(from, through) {
      const skipped: Record<string, number> = {};
      const usage: VendorDayUsage[] = [];
      for (const day of daysBetween(from, through)) usage.push(...(await readDay(day, skipped)));
      return { usage, skipped };
    },
  };
}

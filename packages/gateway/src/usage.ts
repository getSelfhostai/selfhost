import type { GatewayUsageReport, LedgerEvent } from "@selfhost/schema";
import type { GatewayClient } from "./types.js";

/** Where a usage read starts again: requests can finish (and be logged) a while after they start. */
export const USAGE_OVERLAP_MS = 60 * 60 * 1000;
/** How far back the first read goes when the ledger has no gateway request yet. */
export const USAGE_FIRST_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const USAGE_MAX_PAGES = 20;

/** Writes one page; ids already stored are duplicates, as the ledger's append reports them. */
export type UsageWriter = (
  events: LedgerEvent[],
) => Promise<{ accepted: number; duplicates: number }>;

export interface UsageResult {
  report: GatewayUsageReport;
  /** Where the next read should start. */
  next: Date;
}

/**
 * Reads the gateway's finished requests from `from` to now into the ledger. Event ids come from
 * the gateway's request ids, so reading a window again writes nothing twice. When the read stops
 * at maxPages, the next one starts at the same place; otherwise an hour before now.
 */
export async function readUsage(
  client: GatewayClient,
  from: Date,
  write: UsageWriter,
  options: { now?: Date; maxPages?: number } = {},
): Promise<UsageResult> {
  const now = options.now ?? new Date();
  const maxPages = options.maxPages ?? USAGE_MAX_PAGES;
  const report: GatewayUsageReport = {
    at: now.toISOString(),
    from: from.toISOString(),
    events: 0,
    duplicates: 0,
  };
  let pages = 0;
  try {
    for await (const events of client.requests(from, now, maxPages)) {
      pages++;
      if (events.length === 0) continue;
      const written = await write(events);
      report.events += written.accepted;
      report.duplicates += written.duplicates;
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    return { report, next: from };
  }
  const complete = pages < maxPages;
  const next = complete
    ? new Date(Math.max(from.getTime(), now.getTime() - USAGE_OVERLAP_MS))
    : from;
  return { report, next };
}

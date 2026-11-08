import { RECEIPT_SCHEMA, type Receipt, type ReceiptVerdict } from "@selfhost/schema";

/** A receipt before its verdict is worked out. */
export type ReceiptParts = Omit<Receipt, "schema" | "verdict">;

/**
 * failed when setup, the app, a test run, a screenshot or the preview failed; nothing_checked
 * when no test ran, no screen was captured and there is no ready preview; else passed.
 */
export function receiptVerdict(parts: ReceiptParts): ReceiptVerdict {
  const failed =
    parts.setup?.status === "failed" ||
    parts.app.status === "failed" ||
    parts.tests.runs.some((run) => run.status !== "passed") ||
    parts.screens.shots.some((shot) => shot.status === "failed") ||
    parts.preview.status === "failed";
  if (failed) return "failed";
  const checked =
    parts.tests.runs.length > 0 ||
    parts.screens.shots.length > 0 ||
    parts.preview.status === "ready";
  return checked ? "passed" : "nothing_checked";
}

export function assembleReceipt(parts: ReceiptParts): Receipt {
  return { schema: RECEIPT_SCHEMA, ...parts, verdict: receiptVerdict(parts) };
}

export interface ReceiptCounts {
  runs: number;
  failedRuns: number;
  notRun: number;
  shots: number;
  failedShots: number;
}

export function receiptCounts(receipt: Receipt): ReceiptCounts {
  return {
    runs: receipt.tests.runs.length,
    failedRuns: receipt.tests.runs.filter((run) => run.status !== "passed").length,
    notRun: receipt.tests.not_run.length,
    shots: receipt.screens.shots.length,
    failedShots: receipt.screens.shots.filter((shot) => shot.status === "failed").length,
  };
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapClaudeCodeHook, openLedger } from "@selfhost/ledger";
import { validateReviewItem } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import type { ReviewListReport } from "../src/review-list.js";
import { run, tempDir } from "./run.js";

const NOW = new Date("2026-11-10T10:00:00.000Z");
const notification = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "fixtures",
      "hooks",
      "claude-code",
      "Notification.json",
    ),
    "utf8",
  ),
) as Record<string, unknown>;

/** An embedded ledger with one permission prompt and one idle prompt in it. */
async function ledgerWithWaits() {
  const dir = tempDir("review-list");
  const dataDir = dir.path("data");
  const ledger = await openLedger({ dataDir });
  const ctx = { ts: "2026-11-10T09:50:00.000Z", person: "dev@example.com" };
  await ledger.append([
    ...mapClaudeCodeHook(notification, ctx),
    ...mapClaudeCodeHook(
      {
        ...notification,
        session_id: "idle",
        notification_type: "idle_prompt",
        message: "Claude is waiting for your input",
      },
      ctx,
    ),
  ]);
  await ledger.close();
  return { dir, dataDir };
}

describe("selfhost review list", () => {
  it("refreshes the local list and prints it ranked as JSON", async () => {
    const { dir, dataDir } = await ledgerWithWaits();
    const result = await run(["review", "list", "--data-dir", dataDir, "--json"], {
      cwd: dir.root,
      now: NOW,
    });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out) as ReviewListReport;
    expect(report.schema).toBe("selfhost.review_list/v1");
    expect(report.refreshed).toEqual({ created: 2, updated: 0 });
    expect(report.items.map((item) => [item.kind, item.owners])).toEqual([
      ["approval", ["dev@example.com"]],
      ["question", ["dev@example.com"]],
    ]);
    for (const item of report.items) expect(validateReviewItem(item).ok).toBe(true);
    expect(report.next_cursor).toBeNull();

    const again = await run(["review", "list", "--data-dir", dataDir, "--json"], {
      cwd: dir.root,
      now: NOW,
    });
    expect((JSON.parse(again.out) as ReviewListReport).refreshed).toEqual({
      created: 0,
      updated: 0,
    });
  });

  it("prints a table, and the approval the timeout denied once it passes", async () => {
    const { dir, dataDir } = await ledgerWithWaits();
    const open = await run(["review", "list", "--data-dir", dataDir], { cwd: dir.root, now: NOW });
    expect(open.out.split("\n").slice(0, 3)).toEqual([
      "2 open items, blocking first, then by risk.",
      "",
      expect.stringMatching(/^# +KIND +RISK +AGENT +TITLE +OWNERS +ID$/),
    ]);
    expect(open.out).toContain("Claude needs your permission to use Bash");

    const later = new Date(NOW.getTime() + 30 * 60_000);
    const expired = await run(["review", "list", "--data-dir", dataDir, "--state", "expired"], {
      cwd: dir.root,
      now: later,
    });
    expect(expired.out).toContain("1 expired item, blocking first, then by risk.");
    expect(expired.out).toContain("approval");
  });

  it("refuses an unknown state", async () => {
    const { dir, dataDir } = await ledgerWithWaits();
    const result = await run(
      ["review", "list", "--data-dir", dataDir, "--state", "closed", "--json"],
      {
        cwd: dir.root,
      },
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).error).toBe(
      '--state: expected one of open, answered, dismissed, expired, got "closed"',
    );
  });
});
